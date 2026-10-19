function sqlDriver() { return require("mssql"); }

function makeSqlConfig(config) {
  const common = {
    server: config.server,
    port: config.port || 1433,
    database: config.database,
    connectionTimeout: config.connection_timeout_ms || 8000,
    requestTimeout: config.request_timeout_ms || 8000,
    pool: config.pool ? {
      max: config.pool.max ?? 5,
      min: config.pool.min ?? 0,
      idleTimeoutMillis: config.pool.idle_timeout_ms ?? config.pool.idleTimeoutMillis ?? 30000
    } : { max: 5, min: 0, idleTimeoutMillis: 30000 }
  };

  if (config.auth_mode === "windowsIntegrated") {
    if (process.platform !== "win32") {
      throw new Error(
        "auth_mode windowsIntegrated requires Windows. Use sqlLogin and define SQLSERVER_USER/SQLSERVER_PASSWORD on other systems."
      );
    }
    return {
      ...common,
      options: {
        trustedConnection: true,
        encrypt: config.encrypt !== false,
        trustServerCertificate: config.trust_server_certificate === true,
        serverName: config.tls_server_name || config.server
      }
    };
  }

  if (config.auth_mode === "sqlLogin") {
    const user = config.username ?? process.env[config.username_env || "SQLSERVER_USER"];
    const password = config.password ?? process.env[config.password_env || "SQLSERVER_PASSWORD"];
    if (!user || !password) {
      throw new Error(
        `Missing credentials in .env: ${config.username_env || "SQLSERVER_USER"} y ${config.password_env || "SQLSERVER_PASSWORD"}`
      );
    }
    return {
      ...common,
      user,
      password,
      options: {
        encrypt: config.encrypt !== false,
        trustServerCertificate: config.trust_server_certificate === true,
        serverName: config.tls_server_name || config.server,
        enableArithAbort: true
      }
    };
  }

  throw new Error("sqlserver.auth_mode must be windowsIntegrated or sqlLogin");
}

async function connect(config, logger) {
  const pool = new (sqlDriver().ConnectionPool)(makeSqlConfig(config));
  pool.on("error", err => {
    if (logger) logger.error("SQL Server pool error", { message: err.message });
    else console.error(`[SQL ERROR] ${err.message}`);
  });
  await pool.connect();

  const result = await pool.request().query(`
    SELECT @@SERVERNAME AS server_name,
           DB_NAME() AS database_name,
           SYSTEM_USER AS login_name
  `);
  const connection = result.recordset?.[0] || {};
  if (logger) {
    logger.info("SQL Server connection established", {
      server: connection.server_name || config.server,
      database: connection.database_name || config.database
    });
  }
  return pool;
}

function parseSampleValue(valueJson) {
  if (valueJson === null || valueJson === undefined) return null;
  try {
    return JSON.parse(valueJson);
  } catch {
    return valueJson;
  }
}

const telemetryColumnCache = new WeakMap();

async function getTelemetryColumns(pool, table) {
  let cached = telemetryColumnCache.get(pool);
  if (!cached) {
    cached = new Map();
    telemetryColumnCache.set(pool, cached);
  }
  if (cached.has(table)) return cached.get(table);
  const [schemaName, tableName] = table.split('.');
  const sql = require('mssql');
  const result = await pool.request()
    .input('schemaName', sql.NVarChar(128), schemaName)
    .input('tableName', sql.NVarChar(128), tableName)
    .query(`
      SELECT
        COL_LENGTH(QUOTENAME(@schemaName) + N'.' + QUOTENAME(@tableName), N'SourceId') AS SourceId,
        COL_LENGTH(QUOTENAME(@schemaName) + N'.' + QUOTENAME(@tableName), N'DataType') AS DataType,
        COL_LENGTH(QUOTENAME(@schemaName) + N'.' + QUOTENAME(@tableName), N'ErrorMessage') AS ErrorMessage
    `);
  const row = result.recordset?.[0] || {};
  const columns = { SourceId: row.SourceId !== null && row.SourceId !== undefined, DataType: row.DataType !== null && row.DataType !== undefined, ErrorMessage: row.ErrorMessage !== null && row.ErrorMessage !== undefined };
  cached.set(table, columns);
  return columns;
}

async function insertSample(pool, table, sample) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new Error('Invalid table name; use schema.table');
  }

  const sql = require('mssql');
  const request = pool.request();
  const parsed = parseSampleValue(sample.valueJson);
  let value = parsed;
  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.values)) value = parsed.values[0] ?? null;
    else if (Object.prototype.hasOwnProperty.call(parsed, 'value')) value = parsed.value;
    else value = null;
  }

  const numericValue = typeof value === 'number' && Number.isFinite(value)
    ? value
    : typeof value === 'boolean' ? (value ? 1 : 0) : null;
  const stringValue = value !== null && value !== undefined && numericValue === null
    ? (typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 4000)
    : null;

  request.input('TagId', sql.NVarChar(150), String(sample.tagId));
  request.input('TagAddress', sql.NVarChar(100), String(sample.address));
  request.input('ValueFloat', sql.Float, numericValue);
  request.input('ValueString', sql.NVarChar(4000), stringValue);
  request.input('Quality', sql.NVarChar(20), String(sample.quality || 'GOOD'));
  request.input('TimestampUtc', sql.DateTime2(3), sample.timestampUtc || new Date());

  const columns = await getTelemetryColumns(pool, table);
  const names = ['TagId', 'TagAddress'];
  const values = ['@TagId', '@TagAddress'];
  if (columns.SourceId) {
    request.input('SourceId', sql.NVarChar(120), String(sample.sourceId || sample.plcId || 'unknown'));
    names.push('SourceId'); values.push('@SourceId');
  }
  if (columns.DataType) {
    request.input('DataType', sql.NVarChar(40), String(sample.dataType || 'UNKNOWN'));
    names.push('DataType'); values.push('@DataType');
  }
  names.push('ValueFloat', 'ValueString', 'Quality', 'TimestampUtc');
  values.push('@ValueFloat', '@ValueString', '@Quality', '@TimestampUtc');
  if (columns.ErrorMessage) {
    request.input('ErrorMessage', sql.NVarChar(1000), sample.errorMessage ? String(sample.errorMessage).slice(0, 1000) : null);
    names.push('ErrorMessage'); values.push('@ErrorMessage');
  }
  names.push('CreatedAtUtc'); values.push('SYSUTCDATETIME()');
  await request.query(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${values.join(', ')})`);
}

module.exports = { connect, insertSample, makeSqlConfig, parseSampleValue };
