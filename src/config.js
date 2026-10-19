const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

function loadConfig(file = './config.yaml') {
  const absolute = path.resolve(file);
  const config = YAML.parse(fs.readFileSync(absolute, 'utf8'));
  if (!config.gateway?.name) throw new Error('Missing gateway.name in config.yaml');
  if (!Number.isInteger(config.gateway.default_poll_interval_ms) || config.gateway.default_poll_interval_ms < 100) {
    throw new Error('gateway.default_poll_interval_ms must be an integer >= 100');
  }
  if (!Number.isInteger(config.gateway.retry_interval_ms) || config.gateway.retry_interval_ms < 500) {
    throw new Error('gateway.retry_interval_ms must be an integer >= 500');
  }
  if (config.web?.enabled) {
    if (!Number.isInteger(config.web.port) || config.web.port < 1 || config.web.port > 65535) {
      throw new Error('web.port must be between 1 and 65535');
    }
    if (!config.web.host) throw new Error('Missing web.host');
  }
  if (config.sqlserver?.enabled && !config.sqlserver.table) throw new Error('Missing sqlserver.table');
  if (!config.catalog?.file) throw new Error('Missing catalog.file');
  return config;
}

module.exports = { loadConfig };
