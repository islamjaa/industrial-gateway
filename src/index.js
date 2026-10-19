require('dotenv').config({ path: require('node:path').resolve(__dirname, '..', '.env') });

const path = require('node:path');
const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { CatalogStore } = require('./services/catalog-store');
const { DataloggerStore } = require('./services/datalogger-store');
const { DataloggerManager } = require('./services/datalogger-manager');
const { Poller } = require('./services/poller');
const { createWebServer } = require('./web/server');

async function main() {
  const appRoot = path.resolve(__dirname, '..');
  const config = loadConfig(path.join(appRoot, 'config.yaml'));
  const logger = createLogger(config.gateway.log_level, path.join(appRoot, 'logs/gateway.log'), {
    sampleIntervalMs: config.gateway.console_sample_interval_ms ?? 5000
  });
  const store = await new CatalogStore(path.resolve(appRoot, config.catalog.file)).init();
  const dataloggerStore = await new DataloggerStore(path.resolve(appRoot, config.dataloggers?.file || './data/dataloggers.json')).init(config.sqlserver);
  const dataloggerManager = new DataloggerManager({
    store: dataloggerStore,
    appRoot,
    logger,
    retryIntervalMs: config.gateway.retry_interval_ms
  });
  await dataloggerManager.applyConfig();
  const poller = new Poller(config, null, store, logger, dataloggerManager);
  let webListener = null;
  let shuttingDown = false;

  async function shutdown(signal = 'manual') {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Stopping gateway', { signal });
    try { if (webListener) await new Promise(resolve => webListener.close(() => resolve())); }
    catch (error) { logger.warn('Error closing web interface', { message: error.message }); }
    try { await poller.stop(); } catch (error) { logger.warn('Error stopping poller', { message: error.message }); }
    try { if (poller.manager) await poller.manager.close(); } catch (error) { logger.warn('Error closing drivers', { message: error.message }); }
    try { await dataloggerManager.close(); } catch (error) { logger.warn('Error closing data loggers', { message: error.message }); }
    logger.info('Gateway stopped');
  }

  process.once('SIGINT', () => { shutdown('SIGINT').finally(() => process.exit(0)); });
  process.once('SIGTERM', () => { shutdown('SIGTERM').finally(() => process.exit(0)); });

  const catalog = await store.get();
  logger.info('Catalog loaded', { sources: catalog.sources.length, tags: catalog.tags.length, enabledTags: catalog.tags.filter(tag => tag.enabled !== false).length });
  await poller.reload();
  const runningLoggers = dataloggerManager.getStatus();
  logger.info('Gateway running', {
    name: config.gateway.name,
    sources: catalog.sources.length,
    tags: catalog.tags.filter(tag => tag.enabled !== false).length,
    sql: runningLoggers.filter(item => item.enabled && item.status === 'connected').map(item => `${item.name} (${item.destination})`).join('; ') || 'no connected storage destinations'
  });

  if (config.web?.enabled) {
    const webServer = createWebServer({ config, store, poller, logger, dataloggerStore, dataloggerManager, appRoot });
    webListener = await webServer.listen();
    logger.info('Administration interface available', { url: `http://${config.web.host === '0.0.0.0' ? '<server-ip>' : config.web.host}:${config.web.port}` });
  }

  process.on('uncaughtException', error => {
    logger.error('Uncaught exception', { message: error?.stack || error?.message || String(error) });
    shutdown('uncaughtException').finally(() => process.exit(1));
  });
  process.on('unhandledRejection', reason => {
    logger.error('Unhandled promise rejection', { message: reason?.stack || reason?.message || String(reason) });
  });
}

main().catch(error => {
  console.error(`[FATAL] ${error?.message || String(error)}`);
  if (error?.stack) console.error(error.stack.split('\n').slice(1, 4).join('\n'));
  process.exitCode = 1;
});
