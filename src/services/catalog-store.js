const fs = require('node:fs/promises');
const path = require('node:path');
const { normalizeDataType, wordCountForType } = require('../drivers/value-decode');
const { listExpressionReferences } = require('./expression-engine');
const { parseSiemensAddress, validateSiemensTagAddress } = require('../drivers/siemens-address');

const DRIVERS = new Set(['omron-fins', 'siemens-s7', 'modbus-tcp', 'modbus-rtu', 'allen-bradley', 'opcua-client']);
const DATA_TYPES = new Set([
  'BOOL', 'BIT', 'BYTE', 'USINT', 'SINT', 'SBYTE', 'UINT8', 'INT8',
  'WORD', 'UINT16', 'INT16', 'UINT', 'INT', 'UINT32', 'UDINT', 'INT32',
  'DWORD', 'DINT', 'REAL', 'FLOAT32', 'FLOAT64', 'LREAL', 'UINT64', 'ULINT', 'INT64', 'LINT',
  'STRING', 'UTF8', 'RAW'
]);
const ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/;

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function asBool(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (/^(true|1|yes|on)$/i.test(value.trim())) return true;
    if (/^(false|0|no|off)$/i.test(value.trim())) return false;
  }
  return Boolean(value);
}

function validateTagAddressForDriver(catalog, tag, options = {}) {
  if (!tag || tag.kind === 'expression') return true;
  const source = (catalog.sources || []).find(item => String(item.id).toLowerCase() === String(tag.sourceId || '').toLowerCase());
  if (!source) throw new Error(`Tag ${tag.id || ''} does not reference a valid device.`);
  if (source.driver === 'siemens-s7') {
    return validateSiemensTagAddress(tag.address, tag.dataType, { write: options.write === true || tag.writeEnabled === true });
  }
  return true;
}

function validateCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object') throw new Error('The catalog must be a JSON object.');
  if (!Array.isArray(catalog.sources) || !Array.isArray(catalog.tags)) throw new Error('The catalog must contain sources and tags arrays.');
  const sourceIds = new Set();
  const sourceByNormalizedId = new Map();
  for (const source of catalog.sources) {
    if (!source || !ID_RE.test(String(source.id || ''))) throw new Error('Each source requires a valid ID (letters, numbers, _, ., :, -).');
    source.id = String(source.id);
    const normalizedSourceId = source.id.toLowerCase();
    if (sourceIds.has(normalizedSourceId)) throw new Error(`Duplicate source ID (case-insensitive): ${source.id}`);
    sourceIds.add(normalizedSourceId);
    sourceByNormalizedId.set(normalizedSourceId, source);
    if (!DRIVERS.has(source.driver)) throw new Error(`Unsupported driver for ${source.id}: ${source.driver}`);
    if (!source.name) source.name = source.id;
    source.enabled = asBool(source.enabled, true);

    source.writeEnabled = asBool(source.writeEnabled, false);
    if (['omron-fins', 'siemens-s7', 'modbus-tcp', 'allen-bradley'].includes(source.driver) && !String(source.host || '').trim()) {
      throw new Error(`Missing host for source ${source.id}.`);
    }
    if (source.driver === 'modbus-rtu' && !String(source.portPath || '').trim()) {
      throw new Error(`Missing portPath for Modbus RTU source ${source.id} (for example COM3 or /dev/ttyUSB0).`);
    }
    if (source.driver === 'opcua-client' && !/^opc\.tcp:\/\//i.test(String(source.endpoint || ''))) {
      throw new Error(`The endpoint for ${source.id} must be a valid OPC UA URL (for example opc.tcp://host:4840).`);
    }
    if (source.driver === 'omron-fins' && !['tcp', 'udp'].includes(String(source.protocol || 'tcp').toLowerCase())) {
      throw new Error(`Protocol for ${source.id} must be tcp or udp.`);
    }
    for (const field of ['port', 'timeoutMs']) {
      if (source[field] !== undefined && (!Number.isInteger(Number(source[field])) || Number(source[field]) < 1 || Number(source[field]) > (field === 'port' ? 65535 : 120000))) {
        throw new Error(`${field} for ${source.id} is invalid.`);
      }
    }
    if (source.driver === 'allen-bradley' && source.port !== undefined && Number(source.port) !== 44818) {
      throw new Error(`The current Allen-Bradley driver uses the standard EtherNet/IP port 44818; other ports are not supported.`);
    }
    if (source.driver === 'siemens-s7') {
      for (const field of ['rack', 'slot']) {
        if (source[field] !== undefined && (!Number.isInteger(Number(source[field])) || Number(source[field]) < 0 || Number(source[field]) > 31)) {
          throw new Error(`${field} for ${source.id} must be an integer between 0 and 31.`);
        }
      }
    }
    if (source.driver === 'modbus-tcp' || source.driver === 'modbus-rtu') {
      const ranges = source.driver === 'modbus-rtu'
        ? { unitId: [1, 247], baudRate: [300, 1000000], dataBits: [5, 8], stopBits: [1, 2] }
        : { unitId: [1, 247] };
      for (const [field, [min, max]] of Object.entries(ranges)) {
        if (source[field] !== undefined && (!Number.isInteger(Number(source[field])) || Number(source[field]) < min || Number(source[field]) > max)) {
          throw new Error(`${field} for ${source.id} must be between ${min} and ${max}.`);
        }
      }
      if (source.parity !== undefined && !['none', 'even', 'odd', 'mark', 'space'].includes(String(source.parity).toLowerCase())) {
        throw new Error(`Parity for ${source.id} must be none, even, odd, mark, or space.`);
      }
    }
    if (source.driver === 'opcua-client') {
      if (source.securityMode !== undefined && !['None', 'Sign', 'SignAndEncrypt'].includes(source.securityMode)) {
        throw new Error(`securityMode for ${source.id} must be None, Sign, or SignAndEncrypt.`);
      }
      if (source.securityPolicy !== undefined && !['None', 'Basic128Rsa15', 'Basic256', 'Basic256Sha256', 'Aes128_Sha256_RsaOaep', 'Aes256_Sha256_RsaPss'].includes(source.securityPolicy)) {
        throw new Error(`securityPolicy for ${source.id} is not supported.`);
      }
    }
  }
  const tagIds = new Set();
  const tagByNormalizedId = new Map();
  for (const tag of catalog.tags) {
    if (!tag || !ID_RE.test(String(tag.id || ''))) throw new Error('Each tag requires a valid ID.');
    tag.id = String(tag.id);
    const normalizedTagId = tag.id.toLowerCase();
    if (tagIds.has(normalizedTagId)) throw new Error(`Duplicate TagId (case-insensitive): ${tag.id}`);
    tagIds.add(normalizedTagId);
    tagByNormalizedId.set(normalizedTagId, tag);
    tag.kind = String(tag.kind || 'physical').toLowerCase();
    if (!['physical', 'expression'].includes(tag.kind)) throw new Error(`kind for ${tag.id} must be physical or expression.`);
    tag.name = String(tag.name || tag.id).slice(0, 150);
    tag.dataType = String(tag.dataType || (tag.kind === 'expression' ? 'REAL' : 'UINT16')).toUpperCase();
    if (!DATA_TYPES.has(tag.dataType)) throw new Error(`Unsupported data type for ${tag.id}: ${tag.dataType}`);
    tag.enabled = asBool(tag.enabled, true);
    tag.writeEnabled = tag.kind === 'expression' ? false : asBool(tag.writeEnabled, false);
    tag.pollIntervalMs = Number(tag.pollIntervalMs || 1000);
    if (!Number.isInteger(tag.pollIntervalMs) || tag.pollIntervalMs < 100 || tag.pollIntervalMs > 86400000) {
      throw new Error(`pollIntervalMs for ${tag.id} must be between 100 and 86400000.`);
    }
    tag.description = String(tag.description || '').slice(0, 500);

    if (tag.kind === 'expression') {
      if (normalizeDataType(tag.dataType) === 'RAW') throw new Error(`Calculated tag ${tag.id} cannot use RAW; select a concrete result type.`);
      tag.sourceId = null;
      tag.address = 'EXPRESSION';
      tag.expression = String(tag.expression || '').trim();
      tag.writeEnabled = false;


      tag.writeBackEnabled = asBool(tag.writeBackEnabled, false);
      tag.autoWriteEnabled = asBool(tag.autoWriteEnabled, false);
      tag.writeBackTargetTagId = String(tag.writeBackTargetTagId || '').trim();
      tag.writeBackMinIntervalMs = Number(tag.writeBackMinIntervalMs || 1000);
      if (!Number.isInteger(tag.writeBackMinIntervalMs) || tag.writeBackMinIntervalMs < 250 || tag.writeBackMinIntervalMs > 86400000) {
        throw new Error(`writeBackMinIntervalMs for ${tag.id} must be between 250 and 86400000.`);
      }
      if (!tag.expression) throw new Error(`Calculated tag ${tag.id} requires an expression.`);
      if (tag.expression.length > 1000) throw new Error(`Expression for ${tag.id} exceeds 1000 characters.`);
      if ((tag.writeBackEnabled || tag.autoWriteEnabled) && !tag.writeBackTargetTagId) throw new Error(`Calculated tag ${tag.id} requires a configured physical destination tag.`);

      listExpressionReferences(tag.expression);
      continue;
    }

    const matchedSource = sourceByNormalizedId.get(String(tag.sourceId || '').toLowerCase());
    if (!matchedSource) throw new Error(`Tag ${tag.id} references an unknown sourceId: ${tag.sourceId}`);
    tag.sourceId = matchedSource.id;
    if (typeof tag.address !== 'string' || !tag.address.trim()) throw new Error(`Missing address for tag ${tag.id}.`);
    delete tag.expression;
    if (tag.bit !== undefined && (!Number.isInteger(tag.bit) || tag.bit < 0 || tag.bit > 15)) {
      throw new Error(`Bit field for ${tag.id} must be between 0 and 15.`);
    }
    if (tag.lengthWords !== undefined && (!Number.isInteger(Number(tag.lengthWords)) || Number(tag.lengthWords) < 1 || Number(tag.lengthWords) > 2048)) {
      throw new Error(`lengthWords for ${tag.id} must be an integer between 1 and 2048.`);
    }
    if (tag.wordOrder !== undefined && !['ABCD', 'BADC', 'CDAB', 'DCBA'].includes(String(tag.wordOrder).toUpperCase())) {
      throw new Error(`wordOrder for ${tag.id} must be ABCD, BADC, CDAB, or DCBA.`);
    }
    const source = matchedSource;
    if (source?.driver === 'siemens-s7') {


      parseSiemensAddress(tag.address);
    }
    if (source?.driver === 'omron-fins') {
      try { wordCountForType(tag.dataType, tag.lengthWords); }
      catch (error) { throw new Error(`Invalid length configuration for Omron tag ${tag.id}: ${error.message}`); }
    }
    if (source && (source.driver === 'modbus-tcp' || source.driver === 'modbus-rtu')) {
      const registerType = String(tag.registerType || 'holding').toLowerCase();
      if (!['holding', 'input', 'coil', 'discrete-input', 'discreteinput'].includes(registerType)) {
        throw new Error(`registerType for ${tag.id} must be holding, input, coil, or discrete-input.`);
      }
      if (!/^[0-9]+$/.test(tag.address)) throw new Error(`Modbus address for ${tag.id} must be a zero-based integer offset.`);
      const unitId = tag.unitId ?? source.unitId ?? 1;
      if (!Number.isInteger(Number(unitId)) || Number(unitId) < 1 || Number(unitId) > 247) throw new Error(`unitId for ${tag.id} must be between 1 and 247.`);
      if (registerType === 'coil' || registerType === 'discrete-input' || registerType === 'discreteinput') {
        if (normalizeDataType(tag.dataType) !== 'BOOL') throw new Error(`Modbus tag ${tag.id} with registerType ${registerType} must use dataType BOOL.`);
      }
      if (tag.writeEnabled && ['input', 'discrete-input', 'discreteinput'].includes(registerType)) {
        throw new Error(`Modbus tag ${tag.id} uses a read-only area; writes cannot be enabled.`);
      }
      try { wordCountForType(tag.dataType, tag.lengthWords); }
      catch (error) { throw new Error(`Invalid length configuration for Modbus tag ${tag.id}: ${error.message}`); }
    }
    if (tag.writeEnabled && normalizeDataType(tag.dataType) === 'RAW') {
      throw new Error(`Tag ${tag.id} uses RAW and cannot be enabled for writing without explicit byte encoding.`);
    }
    if (tag.writeEnabled && source.driver === 'omron-fins' && ['UINT8', 'INT8'].includes(normalizeDataType(tag.dataType))) {
      throw new Error(`FINS writes memory areas by word; BYTE/SINT writes for ${tag.id} are disabled to avoid overwriting the adjacent byte.`);
    }
    if (tag.writeEnabled && source.driver.startsWith('modbus-') && ['UINT8', 'INT8'].includes(normalizeDataType(tag.dataType))) {
      throw new Error(`This gateway does not support isolated Modbus BYTE/SINT writes into a 16-bit register. Use WORD/INT or an explicitly designed byte layout.`);
    }
    if (tag.writeEnabled && source.driver === 'opcua-client' && ['UINT64', 'INT64'].includes(normalizeDataType(tag.dataType))) {
      throw new Error(`OPC UA writes for type ${tag.dataType} are not implemented by this adapter; leave the tag read-only or use a supported type.`);
    }
    if (tag.writeEnabled && tag.bit !== undefined && !String(tag.address).includes('.')) {
      throw new Error(`Tag ${tag.id} selects a bit within a word. For safety, writing requires an explicit bit address or a compatible BOOL tag; implicit read-modify-write is not performed.`);
    }
  }


  for (const expressionTag of catalog.tags.filter(item => item.kind === 'expression' && (item.writeBackEnabled === true || item.autoWriteEnabled === true))) {
    const target = tagByNormalizedId.get(String(expressionTag.writeBackTargetTagId || '').toLowerCase());
    if (!target) throw new Error(`Calculated tag ${expressionTag.id} references a write target that does not exist: ${expressionTag.writeBackTargetTagId || '(empty)'}.`);
    if (target.id.toLowerCase() === expressionTag.id.toLowerCase()) throw new Error(`Calculated tag ${expressionTag.id} cannot target itself.`);
    if (target.kind === 'expression') throw new Error(`The destination for ${expressionTag.id} must be a physical tag, not another calculated tag.`);
    expressionTag.writeBackTargetTagId = target.id;


  }



  const autoTargetOwners = new Map();
  for (const expressionTag of catalog.tags.filter(item => item.kind === 'expression' && item.autoWriteEnabled === true)) {
    const targetKey = String(expressionTag.writeBackTargetTagId || '').toLowerCase();
    const previousOwner = autoTargetOwners.get(targetKey);
    if (previousOwner) throw new Error(`Destination tag ${expressionTag.writeBackTargetTagId} is already assigned to automatic synchronization for ${previousOwner}. Each target can have only one automatic expression.`);
    autoTargetOwners.set(targetKey, expressionTag.id);
  }


  const expressionDependencies = new Map();
  for (const tag of catalog.tags.filter(item => item.kind === 'expression')) {
    const refs = listExpressionReferences(tag.expression);
    const canonicalRefs = [];
    for (const ref of refs) {
      const dependency = tagByNormalizedId.get(String(ref).toLowerCase());
      if (!dependency) throw new Error(`Expression tag ${tag.id} references an unknown Tag ID: ${ref}`);
      canonicalRefs.push(dependency.id);
    }
    expressionDependencies.set(tag.id, canonicalRefs);
  }



  for (const expressionTag of catalog.tags.filter(item => item.kind === 'expression' && item.autoWriteEnabled === true)) {
    const targetId = String(expressionTag.writeBackTargetTagId || '').toLowerCase();
    const visitedDependencies = new Set();
    const dependsOnTarget = id => {
      const normalized = String(id || '').toLowerCase();
      if (normalized === targetId) return true;
      if (visitedDependencies.has(normalized)) return false;
      visitedDependencies.add(normalized);
      const dependencyTag = tagByNormalizedId.get(normalized);
      if (!dependencyTag || dependencyTag.kind !== 'expression') return false;
      return (expressionDependencies.get(dependencyTag.id) || []).some(dep => dependsOnTarget(dep));
    };
    if ((expressionDependencies.get(expressionTag.id) || []).some(dep => dependsOnTarget(dep))) {
      throw new Error(`Automatic synchronization for ${expressionTag.id} would create a loop because the expression depends on destination tag ${expressionTag.writeBackTargetTagId}.`);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function visitExpression(id) {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`A circular expression dependency includes tag ${id}.`);
    visiting.add(id);
    for (const ref of expressionDependencies.get(id) || []) {
      const dependency = tagByNormalizedId.get(ref.toLowerCase());
      if (dependency?.kind === 'expression') visitExpression(dependency.id);
    }
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of expressionDependencies.keys()) visitExpression(id);
  catalog.version = Number(catalog.version || 1);
  return catalog;
}

class CatalogStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.writeChain = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const text = await fs.readFile(this.filePath, 'utf8');
      validateCatalog(JSON.parse(text));
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`Cannot read catalog ${this.filePath}: ${err.message}`);
      const initial = { version: 1, sources: [], tags: [] };
      await this.save(initial);
    }
    return this;
  }

  async get() {
    const data = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    return clone(validateCatalog(data));
  }

  async save(catalog) {
    const safe = clone(validateCatalog(catalog));
    const serialized = JSON.stringify(safe, null, 2) + '\n';
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      const tempPath = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(tempPath, serialized, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tempPath, this.filePath);
    });
    await this.writeChain;
    return safe;
  }
}

module.exports = { CatalogStore, validateCatalog, validateTagAddressForDriver, DRIVERS, DATA_TYPES };
