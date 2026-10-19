const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { connect: connectSqlServer, insertSample, makeSqlConfig, parseSampleValue } = require('../database');

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
function needIdentifier(value, label) {
  if (!IDENT_RE.test(String(value || ''))) throw new Error(`${label} is invalid.`);
  return String(value);
}
function quoteMssql(value) { return `[${needIdentifier(value, 'Identificador SQL Server').replace(/]/g, ']]')}]`; }
function quotePg(value) { return `"${needIdentifier(value, 'Identificador PostgreSQL').replace(/"/g, '""')}"`; }
function quoteMysql(value) { return `\`${needIdentifier(value, 'Identificador MySQL').replace(/`/g, '``')}\``; }
function parseValue(sample) {
  const parsed = parseSampleValue(sample.valueJson);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    if (Array.isArray(parsed.values)) return parsed.values[0] ?? null;
    if (Object.prototype.hasOwnProperty.call(parsed, 'value')) return parsed.value;
    return null;
  }
  if (Array.isArray(parsed)) return JSON.stringify(parsed);
  return parsed;
}
function valuesForRow(sample) {
  const value = parseValue(sample);
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'boolean' ? (value ? 1 : 0) : null;
  const text = value !== null && value !== undefined && numeric === null ? (typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 4000) : null;
  return {
    sourceId: sample.sourceId || sample.plcId || 'unknown',
    tagId: String(sample.tagId || ''), tagAddress: String(sample.address || ''), dataType: String(sample.dataType || 'UNKNOWN'),
    valueFloat: numeric, valueString: text, quality: String(sample.quality || 'GOOD'),
    timestampUtc: sample.timestampUtc instanceof Date ? sample.timestampUtc : new Date(sample.timestampUtc || Date.now()),
    errorMessage: sample.errorMessage ? String(sample.errorMessage).slice(0, 1000) : null
  };
}
function sqlServerConfig(config, databaseOverride) {
  const c = config.connection;
  return {
    server: c.host, port: Number(c.port || 1433), database: databaseOverride || c.database,
    auth_mode: c.authMode || 'sqlLogin', username_env: c.usernameEnv || 'SQLSERVER_USER', password_env: c.passwordEnv || 'SQLSERVER_PASSWORD',
    username: c.username, password: c.password,
    encrypt: c.encrypt !== false, trust_server_certificate: c.trustServerCertificate === true,
    tls_server_name: c.tlsServerName || c.host, connection_timeout_ms: Number(c.timeoutMs || 8000), request_timeout_ms: Number(c.timeoutMs || 8000), pool: c.pool
  };
}
function closeQuietly(resource, method = 'close') { try { const result = resource?.[method]?.(); if (result && typeof result.catch === 'function') result.catch(() => undefined); } catch {} }

function createSqlServerSink(config, context) {
  let pool = null;
  const c = config.connection, d = config.destination;
  const table = `${needIdentifier(d.schema || 'dbo', 'Esquema')}.${needIdentifier(d.table, 'Tabla')}`;
  const open = async () => {
    if (!pool) pool = await connectSqlServer(sqlServerConfig(config), context.logger);
    return pool;
  };
  return {
    async connect() { await open(); return { server: c.host, database: c.database }; },
    async testConnection() {
      const p = await open();
      const result = await p.request().query('SELECT DB_NAME() AS databaseName, @@SERVERNAME AS serverName, SYSTEM_USER AS loginName');
      return { ok: true, message: `Connection successful to ${result.recordset?.[0]?.serverName || c.host}/${result.recordset?.[0]?.databaseName || c.database}.` };
    },
    async createDatabase() {
      const adminConfig = sqlServerConfig(config, 'master');
      const adminPool = await connectSqlServer(adminConfig, context.logger);
      try {
        const sql = require('mssql');
        const name = needIdentifier(c.database, 'Database');
        await adminPool.request().input('databaseName', sql.NVarChar(128), name).query(`IF DB_ID(@databaseName) IS NULL BEGIN DECLARE @ddl nvarchar(4000) = N'CREATE DATABASE ' + QUOTENAME(@databaseName); EXEC(@ddl); END`);
        return { ok: true, message: `Database ${name}: created or already exists.` };
      } finally { await adminPool.close(); }
    },
    async createTable() {
      const p = await open();
      const schema = needIdentifier(d.schema || 'dbo', 'Esquema'), name = needIdentifier(d.table, 'Tabla');
      const sql = require('mssql');
      await p.request().input('schemaName', sql.NVarChar(128), schema).query(`IF SCHEMA_ID(@schemaName) IS NULL BEGIN DECLARE @schemaDdl nvarchar(4000) = N'CREATE SCHEMA ' + QUOTENAME(@schemaName); EXEC(@schemaDdl); END`);
      await p.request().query(`IF OBJECT_ID(N'${schema}.${name}', N'U') IS NULL CREATE TABLE ${quoteMssql(schema)}.${quoteMssql(name)} (
        [Id] bigint IDENTITY(1,1) NOT NULL PRIMARY KEY,
        [SourceId] nvarchar(120) NULL, [TagId] nvarchar(150) NOT NULL, [TagAddress] nvarchar(100) NULL,
        [DataType] nvarchar(40) NULL, [ValueFloat] float NULL, [ValueString] nvarchar(4000) NULL,
        [Quality] nvarchar(20) NOT NULL, [TimestampUtc] datetime2(3) NOT NULL, [CreatedAtUtc] datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(), [ErrorMessage] nvarchar(1000) NULL
      )`);
      return { ok: true, message: `Table ${schema}.${name}: created or already exists.` };
    },
    async writeSample(sample) { const p = await open(); await insertSample(p, table, sample); },
    async close() { if (pool) { const p = pool; pool = null; await p.close(); } }
  };
}

function createPostgresSink(config, context) {
  let pool = null;
  const c = config.connection, d = config.destination;
  const host = c.host, port = Number(c.port || 5432), database = c.database;
  const user = c.username ?? process.env[c.usernameEnv || ''];
  const password = c.password ?? process.env[c.passwordEnv || ''];
  if (!user || !password) throw new Error('PostgreSQL requires a username and password; enter them in the data logger.');
  const options = { host, port, database, user, password, connectionTimeoutMillis: Number(c.timeoutMs || 8000), ssl: c.ssl ? { rejectUnauthorized: c.rejectUnauthorized !== false } : false, max: 5 };
  const open = async () => { if (!pool) { const { Pool } = require('pg'); pool = new Pool(options); pool.on('error', error => context.logger?.warn('Pool PostgreSQL', { logger: config.id, message: error.message })); await pool.query('SELECT 1'); } return pool; };
  const qualified = () => `${quotePg(d.schema || 'public')}.${quotePg(d.table)}`;
  return {
    async connect() { await open(); return { host, database }; },
    async testConnection() { const p = await open(); const r = await p.query('SELECT current_database() AS database_name, current_user AS login_name'); return { ok: true, message: `PostgreSQL connected: ${r.rows[0].database_name}.` }; },
    async createDatabase() {
      const { Client } = require('pg'); const client = new Client({ ...options, database: 'postgres' });
      await client.connect();
      try {
        const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
        if (!existing.rowCount) await client.query(`CREATE DATABASE ${quotePg(database)}`);
      } finally { await client.end(); }
      return { ok: true, message: `Database ${database}: created or already exists.` };
    },
    async createTable() {
      const p = await open();
      await p.query(`CREATE SCHEMA IF NOT EXISTS ${quotePg(d.schema || 'public')}`);
      await p.query(`CREATE TABLE IF NOT EXISTS ${qualified()} (
        "Id" BIGSERIAL PRIMARY KEY, "SourceId" text NULL, "TagId" varchar(150) NOT NULL, "TagAddress" varchar(100), "DataType" varchar(40),
        "ValueFloat" double precision NULL, "ValueString" text NULL, "Quality" varchar(20) NOT NULL,
        "TimestampUtc" timestamptz NOT NULL, "CreatedAtUtc" timestamptz NOT NULL DEFAULT now(), "ErrorMessage" varchar(1000) NULL)`);
      return { ok: true, message: `Table ${d.schema || 'public'}.${d.table}: created or already exists.` };
    },
    async writeSample(sample) {
      const p = await open(), v = valuesForRow(sample);
      await p.query(`INSERT INTO ${qualified()} ("SourceId","TagId","TagAddress","DataType","ValueFloat","ValueString","Quality","TimestampUtc","ErrorMessage") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [v.sourceId,v.tagId,v.tagAddress,v.dataType,v.valueFloat,v.valueString,v.quality,v.timestampUtc,v.errorMessage]);
    },
    async close() { if (pool) { const p = pool; pool = null; await p.end(); } }
  };
}

function createMysqlSink(config, context) {
  let pool = null;
  const c = config.connection, d = config.destination, database = c.database;
  const user = c.username ?? process.env[c.usernameEnv || ''];
  const password = c.password ?? process.env[c.passwordEnv || ''];
  if (!user || !password) throw new Error('MySQL/MariaDB requires a username and password; enter them in the data logger.');
  const options = { host: c.host, port: Number(c.port || 3306), user, password, database, connectTimeout: Number(c.timeoutMs || 8000), ssl: c.ssl ? {} : undefined, waitForConnections: true, connectionLimit: 5, queueLimit: 0, dateStrings: false };
  const table = quoteMysql(d.table);
  const open = async () => { if (!pool) { const mysql = require('mysql2/promise'); pool = mysql.createPool(options); await pool.query('SELECT DATABASE() AS database_name'); } return pool; };
  return {
    async connect() { await open(); return { host: c.host, database }; },
    async testConnection() { const p = await open(); const [rows] = await p.query('SELECT DATABASE() AS database_name, CURRENT_USER() AS login_name'); return { ok: true, message: `MySQL/MariaDB connected: ${rows[0].database_name}.` }; },
    async createDatabase() {
      const mysql = require('mysql2/promise'); const conn = await mysql.createConnection({ host: c.host, port: Number(c.port || 3306), user, password, connectTimeout: Number(c.timeoutMs || 8000), ssl: c.ssl ? {} : undefined });
      try { await conn.query(`CREATE DATABASE IF NOT EXISTS ${quoteMysql(database)}`); } finally { await conn.end(); }
      return { ok: true, message: `Database ${database}: created or already exists.` };
    },
    async createTable() {
      const p = await open();
      await p.query(`CREATE TABLE IF NOT EXISTS ${table} (
        Id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, SourceId VARCHAR(120) NULL, TagId VARCHAR(150) NOT NULL, TagAddress VARCHAR(100) NULL, DataType VARCHAR(40) NULL,
        ValueFloat DOUBLE NULL, ValueString TEXT NULL, Quality VARCHAR(20) NOT NULL, TimestampUtc DATETIME(3) NOT NULL,
        CreatedAtUtc DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ErrorMessage VARCHAR(1000) NULL, INDEX idx_telemetry_tag_time (TagId, TimestampUtc))`);
      return { ok: true, message: `Table ${d.table}: created or already exists.` };
    },
    async writeSample(sample) {
      const p = await open(), v = valuesForRow(sample);
      await p.query(`INSERT INTO ${table} (SourceId,TagId,TagAddress,DataType,ValueFloat,ValueString,Quality,TimestampUtc,ErrorMessage) VALUES (?,?,?,?,?,?,?,?,?)`, [v.sourceId,v.tagId,v.tagAddress,v.dataType,v.valueFloat,v.valueString,v.quality,v.timestampUtc,v.errorMessage]);
    },
    async close() { if (pool) { const p = pool; pool = null; await p.end(); } }
  };
}

function createSqliteSink(config, context) {
  const c = config.connection, d = config.destination;
  const dbPath = path.isAbsolute(c.filePath) ? c.filePath : path.resolve(context.appRoot, c.filePath);
  const table = `"${needIdentifier(d.table, 'Tabla SQLite')}"`;
  let db = null;
  const open = () => {
    if (!db) {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      db = new DatabaseSync(dbPath);
      db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    }
    return db;
  };
  const schema = () => open().exec(`CREATE TABLE IF NOT EXISTS ${table} (
    Id INTEGER PRIMARY KEY AUTOINCREMENT, SourceId TEXT, TagId TEXT NOT NULL, TagAddress TEXT, DataType TEXT,
    ValueFloat REAL, ValueString TEXT, Quality TEXT NOT NULL, TimestampUtc TEXT NOT NULL,
    CreatedAtUtc TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), ErrorMessage TEXT)`);
  return {
    async connect() { open(); return { filePath: dbPath }; },
    async testConnection() { const result = open().prepare('PRAGMA integrity_check').get(); if (result.integrity_check !== 'ok') throw new Error(`SQLite integrity_check: ${result.integrity_check}`); return { ok: true, message: `SQLite available: ${dbPath}` }; },
    async createDatabase() { open(); return { ok: true, message: `SQLite file available: ${dbPath}.` }; },
    async createTable() { schema(); return { ok: true, message: `SQLite table ${d.table}: created or already exists.` }; },
    async writeSample(sample) {
      const v = valuesForRow(sample), target = open();
      const info = target.prepare(`INSERT INTO ${table} (SourceId,TagId,TagAddress,DataType,ValueFloat,ValueString,Quality,TimestampUtc,ErrorMessage) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(v.sourceId,v.tagId,v.tagAddress,v.dataType,v.valueFloat,v.valueString,v.quality,v.timestampUtc.toISOString(),v.errorMessage);
      return { changes: Number(info.changes) };
    },
    async close() { if (db) { const current = db; db = null; current.close(); } }
  };
}

function escapeInflux(value) { return String(value ?? '').replace(/\\/g, '\\\\').replace(/ /g, '\\ ').replace(/,/g, '\\,').replace(/=/g, '\\='); }
function escapeInfluxString(value) { return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n'); }
function influxField(value) {
  if (typeof value === 'boolean') return `value=${value}`;
  if (typeof value === 'number' && Number.isFinite(value)) return Number.isInteger(value) ? `value=${value}i` : `value=${value}`;
  if (value === null || value === undefined) return null;
  return `value="${escapeInfluxString(typeof value === 'string' ? value : JSON.stringify(value))}"`;
}
function createInfluxSink(config, context) {
  const c = config.connection, d = config.destination;
  const token = c.token ?? process.env[c.tokenEnv || ''];
  if (!token) throw new Error('InfluxDB 2 requires an API token. Enter it in the data logger.');
  const baseUrl = c.url.replace(/\/$/, '');
  let closed = false;
  async function request(endpoint, options = {}) {
    const response = await fetch(`${baseUrl}${endpoint}`, { ...options, signal: AbortSignal.timeout(Number(c.timeoutMs || 8000)), headers: { Authorization: `Token ${token}`, ...(options.headers || {}) } });
    const text = await response.text();
    if (!response.ok) throw new Error(`InfluxDB HTTP ${response.status}: ${text.slice(0, 500)}`);
    return text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  }
  async function orgId() {
    const result = await request(`/api/v2/orgs?org=${encodeURIComponent(c.org)}&limit=10`);
    const found = result?.orgs?.find(item => item.name === c.org);
    if (!found) throw new Error(`InfluxDB organization not found '${c.org}' or the token does not have access.`);
    return found.id;
  }
  return {
    async connect() { await this.testConnection(); return { url: baseUrl, org: c.org }; },
    async testConnection() {
      const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(Number(c.timeoutMs || 8000)) });
      if (!health.ok) throw new Error(`InfluxDB health check returned HTTP ${health.status}.`);
      await orgId();
      return { ok: true, message: `InfluxDB connected: ${c.org}/${d.bucket}.` };
    },
    async createDatabase() {
      const oid = await orgId();
      const found = await request(`/api/v2/buckets?name=${encodeURIComponent(d.bucket)}&orgID=${encodeURIComponent(oid)}&limit=10`);
      if (!found?.buckets?.length) await request('/api/v2/buckets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orgID: oid, name: d.bucket, description: 'Gateway Industrial data logger', retentionRules: [] }) });
      return { ok: true, message: `Bucket ${d.bucket}: created or already exists.` };
    },
    async createTable() { return { ok: true, message: `InfluxDB uses measurements; '${d.measurement}' is created automatically on the first point. Create or verify the bucket first.` }; },
    async writeSample(sample) {
      if (closed) throw new Error('The InfluxDB destination is closed.');
      const v = valuesForRow(sample), field = influxField(parseValue(sample));
      const measurement = escapeInflux(d.measurement);
      const tags = `source_id=${escapeInflux(v.sourceId)},tag_id=${escapeInflux(v.tagId)},address=${escapeInflux(v.tagAddress)},quality=${escapeInflux(v.quality)}`;
      const dataType = `data_type="${escapeInfluxString(v.dataType)}"`;
      const line = field ? `${measurement},${tags} ${field},${dataType} ${v.timestampUtc.getTime() * 1_000_000}` : `${measurement},${tags} ${dataType} ${v.timestampUtc.getTime() * 1_000_000}`;
      await request(`/api/v2/write?org=${encodeURIComponent(c.org)}&bucket=${encodeURIComponent(d.bucket)}&precision=ns`, { method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: line });
    },
    async close() { closed = true; }
  };
}

function createDataloggerSink(config, context) {
  switch (config.provider) {
    case 'sqlserver': return createSqlServerSink(config, context);
    case 'postgresql': return createPostgresSink(config, context);
    case 'mysql': return createMysqlSink(config, context);
    case 'sqlite': return createSqliteSink(config, context);
    case 'influxdb2': return createInfluxSink(config, context);
    default: throw new Error(`Unsupported data logger provider: ${config.provider}`);
  }
}

async function runDataloggerAction(config, action, context) {
  const sink = createDataloggerSink(config, context);
  try {
    if (action === 'test') return await sink.testConnection();
    if (action === 'createDatabase') return await sink.createDatabase();
    if (action === 'createTable') {
      await sink.connect();
      return await sink.createTable();
    }
    throw new Error(`Unsupported data logger action: ${action}`);
  } finally {
    try { if (typeof sink.close === 'function') await sink.close(); } catch {  }
  }
}

async function testDataloggerConnection(config, context) {
  return runDataloggerAction(config, 'test', context);
}

module.exports = { createDataloggerSink, testDataloggerConnection, runDataloggerAction, valuesForRow, parseValue, needIdentifier };
