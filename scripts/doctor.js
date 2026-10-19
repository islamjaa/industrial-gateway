require('dotenv').config();
const path = require('node:path');
const fs = require('node:fs');
const packageJson = require('../package.json');
const { loadConfig } = require('../src/config');
const { CatalogStore } = require('../src/services/catalog-store');

async function main() {
  let failed = false;
  const root = path.resolve(__dirname, '..');
  const ok = (label, detail = '') => console.log(`[OK] ${label}${detail ? ` — ${detail}` : ''}`);
  const warn = (label, detail = '') => console.warn(`[WARN] ${label}${detail ? ` — ${detail}` : ''}`);
  const fail = (label, detail = '') => { failed = true; console.error(`[ERROR] ${label}${detail ? ` — ${detail}` : ''}`); };

  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > 22 || (major === 22 && minor >= 13)) ok('Node.js compatible', process.version);
  else fail('Node.js 22.13 or later is required', process.version);

  let config;
  try {
    config = loadConfig(path.join(root, 'config.yaml'));
    ok('config.yaml is valid');
  } catch (error) { fail('config.yaml is invalid', error.message); }

  if (config) {
    try {
      const store = await new CatalogStore(path.resolve(root, config.catalog.file)).init();
      const catalog = await store.get();
      ok('Catalog is valid', `${catalog.sources.length} source(s), ${catalog.tags.length} tag(s)`);
    } catch (error) { fail('Catalog is invalid', error.message); }
    if (config.sqlserver?.enabled) {
      const user = process.env[config.sqlserver.username_env || 'SQLSERVER_USER'];
      const pass = process.env[config.sqlserver.password_env || 'SQLSERVER_PASSWORD'];
      if (user && pass) ok('SQL environment variables configured');
      else fail('SQL credentials are missing from .env', `${config.sqlserver.username_env || 'SQLSERVER_USER'} / ${config.sqlserver.password_env || 'SQLSERVER_PASSWORD'}`);
    }
    if (config.web?.enabled && !['127.0.0.1', 'localhost', '::1'].includes(config.web.host) && !process.env[config.web.api_token_env || 'GATEWAY_API_TOKEN']) {
      fail('The web interface binds outside localhost without an API token');
    }
  }

  for (const dependency of Object.keys(packageJson.dependencies || {})) {
    try {
      const location = require.resolve(`${dependency}/package.json`, { paths: [root] });
      ok(`Dependency ${dependency}`, path.relative(root, location));
    } catch {

      try { require.resolve(dependency, { paths: [root] }); ok(`Dependency ${dependency}`); }
      catch { fail(`Dependency not installed: ${dependency}`, 'Run npm install'); }
    }
  }

  const gitIgnore = path.join(root, '.gitignore');
  if (fs.existsSync(gitIgnore)) ok('.gitignore is present');
  if (failed) process.exitCode = 1;
  else console.log('\nLocal diagnostics complete. This does not replace communication testing with each PLC.');
}

main().catch(error => { console.error(`[ERROR] Diagnostics: ${error.message}`); process.exitCode = 1; });
