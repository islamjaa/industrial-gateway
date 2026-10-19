const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CatalogStore, validateCatalog, validateTagAddressForDriver } = require('../src/services/catalog-store');

const base = () => ({
  version: 1,
  sources: [{ id: 'omron_01', name: 'Omron', driver: 'omron-fins', enabled: true, host: '127.0.0.1', port: 9600, protocol: 'tcp' }],
  tags: [{ id: 'tag_1', name: 'Tag one', sourceId: 'omron_01', address: 'D00000', dataType: 'UINT16', enabled: true, pollIntervalMs: 1000 }]
});

test('validates the catalog and normalizes defaults', () => {
  const catalog = validateCatalog(base());
  assert.equal(catalog.tags[0].dataType, 'UINT16');
  assert.equal(catalog.tags[0].enabled, true);
});

test('rejects a tag with a missing source', () => {
  const catalog = base();
  catalog.tags[0].sourceId = 'missing';
  assert.throws(() => validateCatalog(catalog), /unknown sourceId/);
});

test('rejects duplicate IDs and unsupported data types', () => {
  const duplicate = base(); duplicate.tags.push({ ...duplicate.tags[0] });
  assert.throws(() => validateCatalog(duplicate), /Duplicate TagId/);
  const badType = base(); badType.tags[0].dataType = 'MYSTERY';
  assert.throws(() => validateCatalog(badType), /Unsupported data type/);
});

test('CatalogStore persists changes atomically', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'industrial-gateway-'));
  try {
    const file = path.join(dir, 'catalog.json');
    const store = await new CatalogStore(file).init();
    await store.save(base());
    const readBack = await store.get();
    assert.equal(readBack.sources[0].id, 'omron_01');
    assert.equal(readBack.tags[0].address, 'D00000');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});


test('accepts valid Modbus TCP, RTU, Siemens, Rockwell, and OPC UA catalogs', () => {
  const catalog = {
    version: 1,
    sources: [
      { id: 's7_1', name: 'S7', driver: 'siemens-s7', host: '192.168.0.10', rack: 0, slot: 1 },
      { id: 'mbtcp_1', name: 'Modbus TCP', driver: 'modbus-tcp', host: '192.168.0.20', port: 502, unitId: 1 },
      { id: 'mbrtu_1', name: 'Modbus RTU', driver: 'modbus-rtu', portPath: 'COM3', baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', unitId: 1 },
      { id: 'ab_1', name: 'Rockwell', driver: 'allen-bradley', host: '192.168.0.30', slot: 0 },
      { id: 'opc_1', name: 'OPC UA', driver: 'opcua-client', endpoint: 'opc.tcp://127.0.0.1:4840', securityMode: 'None', securityPolicy: 'None' }
    ],
    tags: [
      { id: 'mb_temp', sourceId: 'mbtcp_1', address: '0', dataType: 'FLOAT32', registerType: 'holding', lengthWords: 2, wordOrder: 'ABCD' },
      { id: 'opc_temp', sourceId: 'opc_1', address: 'ns=2;s=Temperature', dataType: 'FLOAT32' }
    ]
  };
  assert.equal(validateCatalog(catalog).tags.length, 2);
});

test('rejects invalid OPC UA addressing and policies', () => {
  const badModbus = {
    version: 1,
    sources: [{ id: 'mb_1', driver: 'modbus-tcp', host: '127.0.0.1' }],
    tags: [{ id: 'tag_1', sourceId: 'mb_1', address: '40001', dataType: 'UINT16', registerType: 'unknown' }]
  };
  assert.throws(() => validateCatalog(badModbus), /registerType/);
  const badOpc = {
    version: 1,
    sources: [{ id: 'opc_1', driver: 'opcua-client', endpoint: 'http://127.0.0.1:4840', securityMode: 'Write' }],
    tags: []
  };
  assert.throws(() => validateCatalog(badOpc), /valid OPC UA URL/);
});


test('rejects source IDs and tags differing only by case', () => {
  const duplicateSource = base();
  duplicateSource.sources.push({ ...duplicateSource.sources[0], id: 'OMRON_01' });
  assert.throws(() => validateCatalog(duplicateSource), /Duplicate source ID/);

  const duplicateTag = base();
  duplicateTag.tags.push({ ...duplicateTag.tags[0], id: 'TAG_1' });
  assert.throws(() => validateCatalog(duplicateTag), /Duplicate TagId/);
});

test('rejects an unsupported EtherNet/IP port', () => {
  const catalog = { version: 1, sources: [{ id: 'ab_1', driver: 'allen-bradley', host: '127.0.0.1', port: 44819 }], tags: [] };
  assert.throws(() => validateCatalog(catalog), /standard EtherNet\/IP port 44818/);
});


test('normalizes the tag sourceId to the canonical source ID', () => {
  const catalog = base();
  catalog.tags[0].sourceId = 'OMRON_01';
  assert.equal(validateCatalog(catalog).tags[0].sourceId, 'omron_01');
});


test('rejects a Modbus coil whose data type is not BOOL', () => {
  const catalog = { version: 1, sources: [{ id: 'mb_1', driver: 'modbus-tcp', host: '127.0.0.1' }], tags: [{ id: 'coil_1', sourceId: 'mb_1', address: '0', dataType: 'UINT16', registerType: 'coil' }] };
  assert.throws(() => validateCatalog(catalog), /must use dataType BOOL/);
});


test('validates data type and Siemens memory area when saving a tag', () => {
  const catalog = { version: 1, sources: [{ id: 's7_1', driver: 'siemens-s7', host: '127.0.0.1', writeEnabled: true }], tags: [] };
  assert.doesNotThrow(() => validateTagAddressForDriver(catalog, { id: 'qb800', sourceId: 's7_1', address: 'QB800', dataType: 'BYTE', writeEnabled: true }));
  assert.throws(() => validateTagAddressForDriver(catalog, { id: 'qb800', sourceId: 's7_1', address: 'QB800', dataType: 'WORD', writeEnabled: true }), /expected BYTE/);
  assert.throws(() => validateTagAddressForDriver(catalog, { id: 'ib800', sourceId: 's7_1', address: 'IB800', dataType: 'BYTE', writeEnabled: true }), /input area/);
});
