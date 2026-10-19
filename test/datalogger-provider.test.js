const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createDataloggerSink } = require('../src/services/datalogger-providers');
const { DataloggerManager } = require('../src/services/datalogger-manager');
const { DataloggerStore } = require('../src/services/datalogger-store');

function sqliteConfig(appRoot, extra = {}) {
  return {
    id: 'local_sqlite', name: 'SQLite test', provider: 'sqlite', enabled: true,
    connection: { filePath: './data/telemetry-test.sqlite' }, destination: { table: 'Telemetry' },
    selectedTagIds: ['*'], trigger: { mode: 'every-sample', intervalMs: 1000, deadband: 0 }, createTableIfMissing: true,
    ...extra
  };
}
const sample = (value, timestamp = '2026-10-14T10:00:00.000Z') => ({
  sourceId: 'omron_01', tagId: 'D00108', address: 'D00108', dataType: 'WORD', valueJson: JSON.stringify(value),
  quality: 'GOOD', timestampUtc: new Date(timestamp), errorMessage: null
});
const fakeLogger = { info() {}, warn() {}, error() {} };

test('SQLite creates its file and table and stores narrow samples with source, type, and quality', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-datalogger-sqlite-'));
  const dbFile = path.join(root, 'data', 'telemetry-test.sqlite');
  const config = sqliteConfig(root);
  let sink;
  try {
    sink = createDataloggerSink(config, { appRoot: root, logger: fakeLogger });
    await sink.connect();
    await sink.createTable();
    await sink.writeSample(sample(34885));
    await sink.writeSample({ ...sample(null, '2026-10-14T10:00:01.000Z'), quality: 'BAD', errorMessage: 'read failed' });
    await sink.close(); sink = null;
    const db = new DatabaseSync(dbFile);
    try {
      const rows = db.prepare('SELECT SourceId, TagId, TagAddress, DataType, ValueFloat, Quality, ErrorMessage FROM Telemetry ORDER BY Id').all();
      assert.equal(rows.length, 2);
      assert.equal(rows[0].SourceId, 'omron_01');
      assert.equal(rows[0].TagId, 'D00108');
      assert.equal(rows[0].ValueFloat, 34885);
      assert.equal(rows[0].Quality, 'GOOD');
      assert.equal(rows[1].Quality, 'BAD');
      assert.equal(rows[1].ErrorMessage, 'read failed');
    } finally { db.close(); }
  } finally {
    if (sink) await sink.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('data logger respects tag selection and creates an enabled SQLite destination', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-datalogger-manager-'));
  const file = path.join(root, 'dataloggers.json');
  const store = await new DataloggerStore(file).init(null);
  const config = sqliteConfig(root, { selectedTagIds: ['D00108'] });
  await store.save({ version: 1, loggers: [config] });
  const manager = new DataloggerManager({ store, appRoot: root, logger: fakeLogger });
  try {
    const status = await manager.applyConfig();
    assert.equal(status[0].status, 'connected');
    const notSelected = await manager.writeSample(sample(1), { id: 'temperature' });
    assert.equal(notSelected.attempted, 0);
    const selected = await manager.writeSample(sample(2), { id: 'D00108' });
    assert.equal(selected.written, 1);
    await manager.close();
    const db = new DatabaseSync(path.join(root, 'data', 'telemetry-test.sqlite'));
    try { assert.equal(db.prepare('SELECT ValueFloat FROM Telemetry').get().ValueFloat, 2); }
    finally { db.close(); }
  } finally {
    await manager.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('on-change trigger retries the same sample when the first write fails', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-datalogger-retry-'));
  const config = sqliteConfig(root, { trigger: { mode: 'on-change', intervalMs: 1000, deadband: 0 } });
  const store = { async get() { return { version: 1, loggers: [config] }; } };
  let writes = 0;
  let first = true;
  const createSink = () => ({
    async connect() {}, async createTable() {}, async close() {},
    async writeSample() { writes += 1; if (first) { first = false; throw new Error('temporary write error'); } }
  });
  const manager = new DataloggerManager({ store, appRoot: root, logger: fakeLogger, retryIntervalMs: 0, createSink });
  try {
    assert.equal((await manager.applyConfig())[0].status, 'connected');
    const firstResult = await manager.writeSample(sample(123), { id: 'D00108' });
    assert.equal(firstResult.errors, 1);
    const secondResult = await manager.writeSample(sample(123), { id: 'D00108' });
    assert.equal(secondResult.written, 1);
    assert.equal(writes, 2);
  } finally { await manager.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('manager retries a failed data logger after applying configuration', async () => {
  const config = sqliteConfig('/tmp', { createTableIfMissing: false });
  const store = { async get() { return { version: 1, loggers: [config] }; } };
  let connectAttempts = 0;
  const createSink = () => ({
    async connect() { connectAttempts += 1; if (connectAttempts === 1) throw new Error('database not created yet'); },
    async close() {}, async writeSample() {}, async createTable() {}
  });
  const manager = new DataloggerManager({ store, appRoot: '/tmp', logger: fakeLogger, createSink });
  try {
    assert.equal((await manager.applyConfig())[0].status, 'error');
    assert.equal((await manager.applyConfig())[0].status, 'connected');
    assert.equal(connectAttempts, 2);
  } finally { await manager.close(); }
});


test('retry timeout does not reset continuously while the destination remains disconnected', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-datalogger-backoff-'));
  const config = sqliteConfig(root, { trigger: { mode: 'on-change', intervalMs: 1000, deadband: 0 } });
  const store = { async get() { return { version: 1, loggers: [config] }; } };
  let connectAttempts = 0;
  let writeAttempts = 0;
  let firstWrite = true;
  const createSink = () => ({
    async connect() { connectAttempts += 1; }, async createTable() {}, async close() {},
    async writeSample() { writeAttempts += 1; if (firstWrite) { firstWrite = false; throw new Error('temporary error'); } }
  });
  const manager = new DataloggerManager({ store, appRoot: root, logger: fakeLogger, retryIntervalMs: 35, createSink });
  try {
    await manager.applyConfig();
    assert.equal((await manager.writeSample(sample(5), { id: 'D00108' })).errors, 1);
    const retryAt = manager.outputs.get('local_sqlite').nextRetryAt;
    assert.equal((await manager.writeSample(sample(5), { id: 'D00108' })).errors, 1);
    assert.equal(connectAttempts, 1, 'must not reconnect before backoff expires');
    assert.equal(manager.outputs.get('local_sqlite').nextRetryAt, retryAt, 'backoff must not be extended by every sample');
    await new Promise(resolve => setTimeout(resolve, 45));
    assert.equal((await manager.writeSample(sample(5), { id: 'D00108' })).written, 1);
    assert.equal(connectAttempts, 2);
    assert.equal(writeAttempts, 2);
  } finally { await manager.close(); await fs.rm(root, { recursive: true, force: true }); }
});
