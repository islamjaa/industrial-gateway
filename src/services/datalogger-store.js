const fs = require('node:fs/promises');
const path = require('node:path');

const PROVIDERS = new Set(['sqlserver', 'postgresql', 'mysql', 'sqlite', 'influxdb2']);
const ID_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function validateLoggerConfig(input) {
  const loggerConfig = clone(input || {});
  if (!ID_RE.test(String(loggerConfig.id || ''))) throw new Error('Each data logger requires a valid ID (letters, numbers, hyphen, dot, or underscore).');
  loggerConfig.id = String(loggerConfig.id);
  if (!String(loggerConfig.name || '').trim()) throw new Error(`Missing name for data logger ${loggerConfig.id}.`);
  loggerConfig.name = String(loggerConfig.name).trim().slice(0, 120);
  loggerConfig.provider = String(loggerConfig.provider || '').toLowerCase();
  if (!PROVIDERS.has(loggerConfig.provider)) throw new Error(`Unsupported data logger provider: ${loggerConfig.provider}`);
  loggerConfig.enabled = loggerConfig.enabled !== false;
  loggerConfig.connection = loggerConfig.connection && typeof loggerConfig.connection === 'object' ? loggerConfig.connection : {};
  loggerConfig.destination = loggerConfig.destination && typeof loggerConfig.destination === 'object' ? loggerConfig.destination : {};
  loggerConfig.selectedTagIds = Array.isArray(loggerConfig.selectedTagIds) ? [...new Set(loggerConfig.selectedTagIds.map(String))] : [];
  if (loggerConfig.selectedTagIds.some(id => id !== '*' && !/^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(id))) throw new Error(`The tag selection for data logger ${loggerConfig.id} contains an invalid Tag ID.`);
  loggerConfig.trigger = loggerConfig.trigger && typeof loggerConfig.trigger === 'object' ? loggerConfig.trigger : {};
  loggerConfig.trigger.mode = String(loggerConfig.trigger.mode || 'every-sample');
  if (!['every-sample', 'on-change', 'interval'].includes(loggerConfig.trigger.mode)) throw new Error('Trigger mode must be every-sample, on-change, or interval.');
  loggerConfig.trigger.intervalMs = Number(loggerConfig.trigger.intervalMs || 1000);
  loggerConfig.trigger.deadband = Number(loggerConfig.trigger.deadband || 0);
  if (!Number.isInteger(loggerConfig.trigger.intervalMs) || loggerConfig.trigger.intervalMs < 100 || loggerConfig.trigger.intervalMs > 86400000) throw new Error('Data logger interval must be between 100 ms and 24 hours.');
  if (!Number.isFinite(loggerConfig.trigger.deadband) || loggerConfig.trigger.deadband < 0) throw new Error('Deadband cannot be negative.');
  loggerConfig.createTableIfMissing = loggerConfig.createTableIfMissing === true;

  const c = loggerConfig.connection;
  const d = loggerConfig.destination;
  if (loggerConfig.provider === 'sqlserver' || loggerConfig.provider === 'postgresql' || loggerConfig.provider === 'mysql') {
    c.host = String(c.host || '').trim();
    c.port = Number(c.port || (loggerConfig.provider === 'sqlserver' ? 1433 : loggerConfig.provider === 'postgresql' ? 5432 : 3306));
    c.database = String(c.database || '').trim();
    if (!c.host) throw new Error(`Missing server/host for data logger ${loggerConfig.id}.`);
    if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) throw new Error(`Invalid port for data logger ${loggerConfig.id}.`);
    if (!c.database || c.database.length > 128) throw new Error(`Enter a valid database for ${loggerConfig.id}.`);
    if (!IDENT_RE.test(c.database)) throw new Error('The database name must start with a letter or underscore and contain only letters, numbers, or underscores.');
    c.authMode = c.authMode || 'password';
    if (loggerConfig.provider === 'sqlserver' && !['sqlLogin', 'windowsIntegrated'].includes(c.authMode)) throw new Error('SQL Server authentication must be sqlLogin or windowsIntegrated.');
    if (loggerConfig.provider === 'sqlserver' || loggerConfig.provider === 'postgresql') {
      c.schema = String(c.schema || (loggerConfig.provider === 'sqlserver' ? 'dbo' : 'public'));
      if (!IDENT_RE.test(c.schema)) throw new Error('Schema must be a simple SQL identifier.');
    }
    if (loggerConfig.provider === 'sqlserver') {
      d.schema = String(d.schema || c.schema || 'dbo');
      d.table = String(d.table || 'Telemetry');
    } else {
      d.schema = String(d.schema || (loggerConfig.provider === 'postgresql' ? 'public' : ''));
      d.table = String(d.table || 'telemetry');
    }
    if ((loggerConfig.provider === 'sqlserver' || loggerConfig.provider === 'postgresql') && !IDENT_RE.test(d.schema)) throw new Error('Invalid destination schema.');
    if (!IDENT_RE.test(d.table)) throw new Error('Invalid table name. Use letters, numbers, and underscores.');
    c.timeoutMs = Number(c.timeoutMs || 8000);
    if (!Number.isInteger(c.timeoutMs) || c.timeoutMs < 500 || c.timeoutMs > 120000) throw new Error('Data logger timeout must be between 500 and 120000 ms.');
    c.usernameEnv = c.usernameEnv ? String(c.usernameEnv) : undefined;
    c.passwordEnv = c.passwordEnv ? String(c.passwordEnv) : undefined;
    delete c.username; delete c.password; delete c.token;
  } else if (loggerConfig.provider === 'sqlite') {
    c.filePath = String(c.filePath || './data/telemetry.sqlite').trim();
    if (!c.filePath || c.filePath.length > 500) throw new Error('Invalid SQLite database path.');
    d.table = String(d.table || 'Telemetry');
    if (!IDENT_RE.test(d.table)) throw new Error('Invalid SQLite table name.');
    delete c.username; delete c.password; delete c.token;
  } else if (loggerConfig.provider === 'influxdb2') {
    c.url = String(c.url || '').trim().replace(/\/$/, '');
    c.org = String(c.org || '').trim();
    c.tokenEnv = c.tokenEnv ? String(c.tokenEnv) : undefined;
    if (!/^https?:\/\//i.test(c.url)) throw new Error('InfluxDB URL must start with http:// or https://.');
    if (!c.org) throw new Error('InfluxDB organization is missing.');
    d.bucket = String(d.bucket || '').trim();
    d.measurement = String(d.measurement || 'telemetry').trim();
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(d.bucket)) throw new Error('InfluxDB bucket may contain only letters, numbers, dots, hyphens, or underscores.');
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(d.measurement)) throw new Error('Invalid InfluxDB measurement.');
    delete c.username; delete c.password; delete c.token;
  }
  return loggerConfig;
}

function legacySqlLogger(sqlConfig) {
  if (!sqlConfig?.enabled) return null;
  const tableParts = String(sqlConfig.table || 'dbo.Telemetry').split('.');
  const table = tableParts.length === 2 ? tableParts[1] : tableParts[0];
  const schema = tableParts.length === 2 ? tableParts[0] : 'dbo';
  return validateLoggerConfig({
    id: 'sqlserver_main', name: `SQL Server · ${sqlConfig.database || 'Historian'}`, provider: 'sqlserver', enabled: true,
    connection: {
      host: sqlConfig.server || '', port: Number(sqlConfig.port || 1433), database: sqlConfig.database || '',
      authMode: sqlConfig.auth_mode || 'sqlLogin', usernameEnv: sqlConfig.username_env || 'SQLSERVER_USER', passwordEnv: sqlConfig.password_env || 'SQLSERVER_PASSWORD',
      encrypt: sqlConfig.encrypt !== false, trustServerCertificate: sqlConfig.trust_server_certificate === true,
      tlsServerName: sqlConfig.tls_server_name || sqlConfig.server, timeoutMs: sqlConfig.connection_timeout_ms || 8000,
      pool: sqlConfig.pool
    },
    destination: { schema, table }, selectedTagIds: ['*'],
    trigger: { mode: 'every-sample', intervalMs: 1000, deadband: 0 },
    createTableIfMissing: false, _migratedFromLegacy: true
  });
}

class DataloggerStore {
  constructor(filePath) { this.filePath = path.resolve(filePath); this.writeChain = Promise.resolve(); }
  async init(legacySqlConfig) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const text = await fs.readFile(this.filePath, 'utf8');
      this.validateDocument(JSON.parse(text));
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Could not read data logger configuration ${this.filePath}: ${error.message}`);
      const migrated = legacySqlLogger(legacySqlConfig);
      await this.save({ version: 1, loggers: migrated ? [migrated] : [] });
    }
    return this;
  }
  validateDocument(doc) {
    if (!doc || !Array.isArray(doc.loggers)) throw new Error('Data logger configuration must include loggers[].');
    const ids = new Set();
    doc.loggers = doc.loggers.map(item => {
      const normalized = validateLoggerConfig(item);
      const key = normalized.id.toLowerCase();
      if (ids.has(key)) throw new Error(`Duplicate data logger ID: ${normalized.id}`);
      ids.add(key);
      return normalized;
    });
    doc.version = Number(doc.version || 1);
    return doc;
  }
  async get() {
    const doc = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    return clone(this.validateDocument(doc));
  }
  async save(doc) {
    const safe = clone(this.validateDocument(doc));
    const serialized = JSON.stringify(safe, null, 2) + '\n';
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      const temp = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(temp, serialized, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temp, this.filePath);
      try { await fs.chmod(this.filePath, 0o600); } catch {}
    });
    await this.writeChain;
    return safe;
  }
}

module.exports = { DataloggerStore, validateLoggerConfig, PROVIDERS, IDENT_RE };
