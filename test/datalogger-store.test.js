const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DataloggerStore, validateLoggerConfig } = require('../src/services/datalogger-store');
const { persistLoggerSecrets, sanitizeLogger } = require('../src/services/env-store');

function logger(provider, extra = {}) {
  const base = {
    id: `logger_${provider}`, name: `Test ${provider}`, provider, enabled: true,
    connection: {}, destination: {}, selectedTagIds: ['*'],
    trigger: { mode: 'every-sample', intervalMs: 1000, deadband: 0 },
    createTableIfMissing: false
  };
  if (['sqlserver', 'postgresql', 'mysql'].includes(provider)) {
    base.connection = { host: '127.0.0.1', port: ({sqlserver:1433,postgresql:5432,mysql:3306})[provider], database: 'TelemetryDB', authMode: provider === 'sqlserver' ? 'sqlLogin' : 'password', usernameEnv: 'TEST_USER', passwordEnv: 'TEST_PASSWORD' };
    base.destination = { schema: provider === 'sqlserver' ? 'dbo' : 'public', table: 'Telemetry' };
  } else if (provider === 'sqlite') {
    base.connection = { filePath: './data/test.sqlite' };
    base.destination = { table: 'Telemetry' };
  } else {
    base.connection = { url: 'http://127.0.0.1:8086', org: 'test-org', tokenEnv: 'TEST_TOKEN' };
    base.destination = { bucket: 'test-bucket', measurement: 'telemetry' };
  }
  return { ...base, ...extra };
}

test('validates the five data logger destination types', () => {
  for (const provider of ['sqlserver', 'postgresql', 'mysql', 'sqlite', 'influxdb2']) {
    const config = validateLoggerConfig(logger(provider));
    assert.equal(config.provider, provider);
    assert.equal(config.enabled, true);
  }
});

test('rejects unsafe table names and invalid empty selections', () => {
  assert.throws(() => validateLoggerConfig(logger('sqlserver', { destination: { schema: 'dbo', table: 'Telemetry;DROP' } })), /invalid table name/i);
  assert.throws(() => validateLoggerConfig(logger('sqlite', { selectedTagIds: ['not valid id'] })), /invalid Tag ID/i);
});

test('migrates legacy SQL Server configuration to the data logger catalog', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-datalogger-migration-'));
  try {
    const store = await new DataloggerStore(path.join(dir, 'dataloggers.json')).init({
      enabled: true, server: '127.0.0.1', port: 1433, database: 'TelemetryDB', auth_mode: 'sqlLogin',
      username_env: 'TEST_USER', password_env: 'TEST_PASSWORD', table: 'dbo.Telemetry'
    });
    const doc = await store.get();
    assert.equal(doc.loggers.length, 1);
    assert.equal(doc.loggers[0].provider, 'sqlserver');
    assert.equal(doc.loggers[0].connection.database, 'TelemetryDB');
    assert.equal(doc.loggers[0].destination.schema, 'dbo');
    assert.equal(doc.loggers[0].destination.table, 'Telemetry');
    assert.deepEqual(doc.loggers[0].selectedTagIds, ['*']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('credentials are stored in .env and are not returned in the catalog', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-datalogger-secrets-'));
  const envPath = path.join(dir, '.env');
  const userKey = 'DATALOGGER_SECRET_TEST_USER';
  const passKey = 'DATALOGGER_SECRET_TEST_PASSWORD';
  try {
    const saved = await persistLoggerSecrets(logger('mysql', {
      id: 'secret_test', connection: { host: '127.0.0.1', port: 3306, database: 'TelemetryDB', username: 'test-user-value', password: 'test-password-value' }
    }), { envPath });
    assert.equal(saved.connection.username, undefined);
    assert.equal(saved.connection.password, undefined);
    assert.ok(saved.connection.usernameEnv);
    assert.ok(saved.connection.passwordEnv);
    assert.match(await fs.readFile(envPath, 'utf8'), /test-password-value/);
    const oldUser = process.env[saved.connection.usernameEnv];
    const oldPassword = process.env[saved.connection.passwordEnv];
    const sanitized = sanitizeLogger(saved);
    assert.equal(sanitized.connection.username, undefined);
    assert.equal(sanitized.connection.password, undefined);
    assert.equal(sanitized.credentialsConfigured.username, true);
    if (oldUser === undefined) delete process.env[saved.connection.usernameEnv]; else process.env[saved.connection.usernameEnv] = oldUser;
    if (oldPassword === undefined) delete process.env[saved.connection.passwordEnv]; else process.env[saved.connection.passwordEnv] = oldPassword;
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
