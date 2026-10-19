const fs = require('node:fs');
const path = require('node:path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LABELS = { debug: 'DEBUG', info: 'INFO', warn: 'WARN', error: 'ERROR' };

function createLogger(level = 'info', file = './logs/gateway.log', options = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const threshold = LEVELS[String(level).toLowerCase()] ?? LEVELS.info;
  const repeatedErrors = new Map();
  const consoleErrorIntervalMs = 10000;
  const sampleIntervalMs = Number.isFinite(options.sampleIntervalMs) ? Math.max(0, options.sampleIntervalMs) : 5000;
  const lastSampleConsoleAt = new Map();

  function write(lvl, message, details) {
    if (LEVELS[lvl] < threshold) return;
    const line = `${new Date().toISOString()} [${lvl.toUpperCase()}] ${message}` + (details === undefined ? '' : ` ${safeStringify(details)}`);
    try { fs.appendFileSync(file, line + '\n', 'utf8'); }
    catch (error) { process.stderr.write(`[LOG ERROR] Could not write ${file}: ${error.message}\n`); }
    const now = Date.now();
    const time = new Date(now).toLocaleTimeString('en-GB', { hour12: false });
    const text = formatConsoleMessage(message, details || {});
    if (message === 'Read successful') {
      const key = String(details?.tag || details?.address || 'tag');
      if (sampleIntervalMs > 0 && now - (lastSampleConsoleAt.get(key) || 0) < sampleIntervalMs) return;
      lastSampleConsoleAt.set(key, now);
    }
    if (lvl === 'error') {
      const key = `${message}|${details?.address || details?.tag || ''}|${details?.message || ''}`;
      const previous = repeatedErrors.get(key);
      if (previous && now - previous.lastShown < consoleErrorIntervalMs) {
        previous.suppressed += 1;
        previous.lastSeen = now;
        return;
      }
      if (previous && previous.suppressed > 0) {
        process.stdout.write(`[${time}] [WARN] The same error repeated ${previous.suppressed} times; full details are in logs/gateway.log\n`);
      }
      repeatedErrors.set(key, { lastShown: now, lastSeen: now, suppressed: 0 });
    }
    process.stdout.write(`[${time}] [${LABELS[lvl]}] ${text}\n`);
  }

  return {
    debug: (message, details) => write('debug', message, details),
    info: (message, details) => write('info', message, details),
    warn: (message, details) => write('warn', message, details),
    error: (message, details) => write('error', message, details)
  };
}

function formatConsoleMessage(message, details = {}) {
  switch (message) {
    case 'Connecting to SQL Server': return `Connecting to SQL Server (${details.database || 'database'})...`;
    case 'SQL Server connection established': return `SQL Server connected | ${details.server || ''} | ${details.database || ''}`;
    case 'Catalog loaded': return `Catalog loaded | ${details.sources} source(s) | ${details.enabledTags}/${details.tags} tag(s) enabled`;
    case 'Source connected': return `Source connected | ${details.sourceId} | ${details.driver}`;
    case 'Source connection failed': return `Source ${details.sourceId} disconnected | ${details.message}`;
    case 'FINS driver reported an error': return `FINS ${details.source}: ${details.message}`;
    case 'Gateway running': return `Gateway running | ${details.name} | enabled tags: ${details.tags} | storage: ${details.sql}`;
    case 'Administration interface available': return `Web interface available | ${details.url}`;
    case 'Read successful': return `${details.tag || details.address} = ${formatValue(details.value)} | GOOD | ${details.storageStatus || ''}`;
    case 'Read failed': return `Read failed ${details.tag || details.address} [${details.driver}]: ${details.message}`;
    case 'SQL sample insert failed': return `SQL ${details.tag}: ${details.message}`;
    case 'SQL error sample insert failed': return `SQL ${details.tag}: ${details.message}`;
    case 'SQL Server pool error': return `SQL Server: ${details.message}`;
    case 'Stopping gateway': return `Stopping gateway (${details.signal || 'manual'})...`;
    case 'Gateway stopped': return 'Gateway stopped';
    case 'Administration API error': return `API: ${details.message}`;
    case 'Error closing drivers': return `Error closing drivers: ${details.message}`;
    case 'Error closing web interface': return `Error closing web interface: ${details.message}`;
    case 'Error closing SQL Server': return `Error closing SQL Server: ${details.message}`;
    case 'Uncaught exception': return `Uncaught exception: ${details.message}`;
    case 'Unhandled promise rejection': return `Unhandled promise rejection: ${details.message}`;
    default: return details.message ? `${message}: ${details.message}` : message;
  }
}

function formatValue(value) {
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return String(value);
}
function safeStringify(value) { try { return JSON.stringify(value); } catch { return String(value); } }
module.exports = { createLogger };
