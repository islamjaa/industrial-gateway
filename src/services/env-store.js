const fs = require('node:fs/promises');
const path = require('node:path');
const KEY_RE = /^[A-Z][A-Z0-9_]{1,127}$/;

function renderEnvValue(value) {
  return JSON.stringify(String(value));
}

async function setEnvVariables(envPath, values) {
  const file = path.resolve(envPath);
  let text = '';
  try { text = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (const [key, rawValue] of Object.entries(values || {})) {
    if (!KEY_RE.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
    const value = renderEnvValue(rawValue);
    const matcher = new RegExp(`^\\s*(?:export\\s+)?${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=.*$`);
    const idx = lines.findIndex(line => matcher.test(line));
    if (idx >= 0) lines[idx] = `${key}=${value}`;
    else {
      while (lines.length && lines[lines.length - 1] === '') lines.pop();
      lines.push(`${key}=${value}`);
    }
    process.env[key] = String(rawValue);
  }
  const output = lines.join('\n').replace(/\n*$/, '\n');
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, output, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, file);
  try { await fs.chmod(file, 0o600); } catch {}
}

function generatedEnvKey(id, suffix) {
  const clean = String(id).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 70) || 'LOGGER';
  return `DATALOGGER_${clean}_${suffix}`;
}

async function persistLoggerSecrets(loggerConfig, options = {}) {
  const config = JSON.parse(JSON.stringify(loggerConfig));
  const c = config.connection || {};
  const env = {};
  const fields = config.provider === 'influxdb2'
    ? [['token', 'tokenEnv', 'TOKEN']]
    : [['username', 'usernameEnv', 'USER'], ['password', 'passwordEnv', 'PASSWORD']];
  for (const [valueKey, envKey, suffix] of fields) {
    const value = c[valueKey];
    if (value !== undefined && value !== null && String(value) !== '') {
      const key = c[envKey] || (config.provider === 'sqlserver' && config.id === 'sqlserver_main' ? (suffix === 'USER' ? 'SQLSERVER_USER' : 'SQLSERVER_PASSWORD') : generatedEnvKey(config.id, suffix));
      env[key] = String(value);
      c[envKey] = key;
    } else if (!c[envKey] && options.previous?.connection?.[envKey]) {
      c[envKey] = options.previous.connection[envKey];
    }
    delete c[valueKey];
  }
  if (Object.keys(env).length) await setEnvVariables(options.envPath, env);
  const safe = { ...config, connection: c };
  return safe;
}

function sanitizeLogger(loggerConfig) {
  const safe = JSON.parse(JSON.stringify(loggerConfig));
  const c = safe.connection || {};
  const has = key => Boolean((c[key] && process.env[c[key]]) || c[key.replace('Env', '')]);
  safe.credentialsConfigured = {
    username: Boolean(c.usernameEnv && process.env[c.usernameEnv]),
    password: Boolean(c.passwordEnv && process.env[c.passwordEnv]),
    token: Boolean(c.tokenEnv && process.env[c.tokenEnv])
  };
  delete c.username; delete c.password; delete c.token;
  return safe;
}

module.exports = { setEnvVariables, persistLoggerSecrets, sanitizeLogger, generatedEnvKey };
