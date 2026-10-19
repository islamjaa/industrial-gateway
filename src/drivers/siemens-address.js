const { normalizeDataType } = require('./value-decode');

const DB_TYPES = Object.freeze({
  X: ['BOOL'], BOOL: ['BOOL'],
  BYTE: ['UINT8'], USINT: ['UINT8'],
  WORD: ['UINT16'], UINT: ['UINT16'],
  INT: ['INT16'],
  DWORD: ['UINT32'], UDINT: ['UINT32'],
  DINT: ['INT32'],
  REAL: ['FLOAT32'], LREAL: ['FLOAT64'],
  STRING: ['STRING'], S: ['STRING']
});

function parseSiemensAddress(rawAddress) {
  const address = String(rawAddress || '').trim().toUpperCase();
  if (!address) throw new Error('Siemens address is empty.');


  const db = address.match(/^DB(\d+),([A-Z]+)(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  if (db) {
    const dbNumber = Number(db[1]);
    if (!Number.isInteger(dbNumber) || dbNumber < 1) throw new Error(`Invalid DB number in ${rawAddress}.`);
    const areaType = db[2];
    const allowedTypes = DB_TYPES[areaType];
    if (!allowedTypes) throw new Error(`DB address type '${areaType}' is not supported by nodes7.`);
    if (['X', 'BOOL'].includes(areaType)) {
      const bit = Number(db[4]);
      if (db[4] === undefined || !Number.isInteger(bit) || bit < 0 || bit > 7) throw new Error(`Siemens address ${rawAddress} requires a bit between 0 y 7.`);
    }
    if (['STRING', 'S'].includes(areaType) && db[4] !== undefined && Number(db[4]) < 1) throw new Error(`The STRING length of ${rawAddress} must be greater than zero.`);
    return { address, area: 'DB', dbNumber, addressType: areaType, allowedTypes, writable: true };
  }


  const memory = address.match(/^([IQM])([BWDR])(\d+)$/);
  if (memory) {
    const area = memory[1];
    const width = memory[2].trim();
    const addressType = ({ B: 'BYTE', W: 'WORD', D: 'DWORD', R: 'REAL' })[width];
    const allowedTypes = ({
      B: ['UINT8'],
      W: ['UINT16', 'INT16'],
      D: ['UINT32', 'INT32', 'FLOAT32'],
      R: ['FLOAT32']
    })[width];
    return { address, area, addressType, allowedTypes, writable: area !== 'I' };
  }


  const bit = address.match(/^([IQM])(\d+)\.(\d)$/);
  if (bit) {
    const index = Number(bit[3]);
    if (index < 0 || index > 7) throw new Error(`The bit of ${rawAddress} must be between 0 and 7.`);
    return { address, area: bit[1], addressType: 'BOOL', allowedTypes: ['BOOL'], writable: bit[1] !== 'I' };
  }

  throw new Error(`Siemens address ${rawAddress} does not match a validated nodes7 address format. Examples: QB800, QW800, MD20, M10.3, DB1,BYTE0 o DB1,REAL4.`);
}

function validateSiemensTagAddress(rawAddress, dataType, options = {}) {
  const parsed = parseSiemensAddress(rawAddress);
  const normalized = normalizeDataType(dataType);
  if (!parsed.allowedTypes.includes(normalized)) {
    const expected = parsed.allowedTypes.map(type => ({
      UINT8: 'BYTE', UINT16: 'WORD', INT16: 'INT', UINT32: 'DWORD', INT32: 'DINT', FLOAT32: 'REAL', FLOAT64: 'LREAL', BOOL: 'BOOL', STRING: 'STRING'
    })[type] || type).join(' / ');
    throw new Error(`Data type ${dataType} is incompatible with Siemens address ${rawAddress}; expected ${expected}. No write was sent.`);
  }
  if (options.write && !parsed.writable) {
    throw new Error(`Siemens address ${rawAddress} belongs to the input area (I), which is read-only.`);
  }
  return parsed;
}

module.exports = { parseSiemensAddress, validateSiemensTagAddress };
