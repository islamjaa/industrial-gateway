const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const { evaluateExpression, listExpressionReferences } = require('../services/expression-engine');
const { createDriver } = require('../drivers');
const { validateLoggerConfig } = require('../services/datalogger-store');
const { validateTagAddressForDriver } = require('../services/catalog-store');
const { persistLoggerSecrets, sanitizeLogger } = require('../services/env-store');
const { runDataloggerAction } = require('../services/datalogger-providers');

function constantTimeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function plcWritesEnabled(config) {


  return config.writes?.enabled === true;
}

function createWebServer({ config, store, poller, logger, dataloggerStore, dataloggerManager, appRoot }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use(express.static(path.resolve(__dirname, '../../public'), { index: 'index.html', etag: true, maxAge: '1h' }));

  const tokenName = config.web.api_token_env || 'GATEWAY_API_TOKEN';
  const expectedToken = process.env[tokenName];
  const bindHost = String(config.web.host || '127.0.0.1');
  const loopbackOnly = ['127.0.0.1', 'localhost', '::1'].includes(bindHost);
  if (!loopbackOnly && !expectedToken) {
    throw new Error(`The interface is exposed on ${bindHost}; define ${tokenName} in .env before exposing access to the network.`);
  }

  app.get('/api/auth/status', (_req, res) => res.json({ required: Boolean(expectedToken), tokenName: expectedToken ? tokenName : null }));
  app.use('/api', (req, res, next) => {
    if (!expectedToken) return next();
    const authorization = req.headers.authorization || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!token || !constantTimeEqual(token, expectedToken)) return res.status(401).json({ error: 'Authorization required. Enter the token configured in .env.' });
    return next();
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true, timestamp: new Date().toISOString() }));
  app.get('/api/values', (_req, res) => res.json(poller.getLatestValues()));
  app.get('/api/catalog', asyncRoute(async (_req, res) => res.json(await store.get())));



  app.get('/api/dataloggers', asyncRoute(async (_req, res) => {
    if (!dataloggerStore) return res.json({ loggers: [], status: [] });
    const doc = await dataloggerStore.get();
    res.json({ loggers: doc.loggers.map(sanitizeLogger), status: dataloggerManager?.getStatus() || [] });
  }));

  app.post('/api/dataloggers', asyncRoute(async (req, res) => {
    if (!dataloggerStore) return res.status(503).json({ error: 'Data logger management is not initialized.' });
    const doc = await dataloggerStore.get();
    const id = String(req.body?.id || '');
    if (doc.loggers.some(item => item.id.toLowerCase() === id.toLowerCase())) return res.status(409).json({ error: `Data logger already exists ${id}.` });
    const withSecrets = await persistLoggerSecrets({ ...req.body, id }, { envPath: path.resolve(appRoot, '.env') });
    const safe = validateLoggerConfig(withSecrets);
    doc.loggers.push(safe);
    await dataloggerStore.save(doc);
    await dataloggerManager?.applyConfig();
    res.status(201).json({ ok: true, logger: sanitizeLogger(safe), status: dataloggerManager?.getStatus() || [] });
  }));

  app.put('/api/dataloggers/:id', asyncRoute(async (req, res) => {
    if (!dataloggerStore) return res.status(503).json({ error: 'Data logger management is not initialized.' });
    const doc = await dataloggerStore.get();
    const index = doc.loggers.findIndex(item => item.id === req.params.id);
    if (index < 0) return res.status(404).json({ error: 'Data logger not found.' });
    const previous = doc.loggers[index];
    const withSecrets = await persistLoggerSecrets({ ...req.body, id: previous.id }, { envPath: path.resolve(appRoot, '.env'), previous });
    const safe = validateLoggerConfig(withSecrets);
    doc.loggers[index] = safe;
    await dataloggerStore.save(doc);
    await dataloggerManager?.applyConfig();
    res.json({ ok: true, logger: sanitizeLogger(safe), status: dataloggerManager?.getStatus() || [] });
  }));

  app.delete('/api/dataloggers/:id', asyncRoute(async (req, res) => {
    if (!dataloggerStore) return res.status(503).json({ error: 'Data logger management is not initialized.' });
    const doc = await dataloggerStore.get();
    if (!doc.loggers.some(item => item.id === req.params.id)) return res.status(404).json({ error: 'Data logger not found.' });
    doc.loggers = doc.loggers.filter(item => item.id !== req.params.id);
    await dataloggerStore.save(doc);
    await dataloggerManager?.applyConfig();
    res.json({ ok: true, status: dataloggerManager?.getStatus() || [] });
  }));

  app.post('/api/dataloggers/:id/test', asyncRoute(async (req, res) => {
    if (!dataloggerStore) return res.status(503).json({ error: 'Data logger management is not initialized.' });
    const doc = await dataloggerStore.get();
    const loggerConfig = doc.loggers.find(item => item.id === req.params.id);
    if (!loggerConfig) return res.status(404).json({ error: 'Data logger not found.' });
    const result = await runDataloggerAction(loggerConfig, 'test', { appRoot, logger });
    await dataloggerManager?.applyConfig();
    res.json({ ...result, status: dataloggerManager?.getStatus() || [] });
  }));

  app.post('/api/dataloggers/:id/create-database', asyncRoute(async (req, res) => {
    if (!dataloggerStore) return res.status(503).json({ error: 'Data logger management is not initialized.' });
    const doc = await dataloggerStore.get();
    const loggerConfig = doc.loggers.find(item => item.id === req.params.id);
    if (!loggerConfig) return res.status(404).json({ error: 'Data logger not found.' });
    const result = await runDataloggerAction(loggerConfig, 'createDatabase', { appRoot, logger });
    await dataloggerManager?.applyConfig();
    res.json({ ...result, status: dataloggerManager?.getStatus() || [] });
  }));

  app.post('/api/dataloggers/:id/create-table', asyncRoute(async (req, res) => {
    if (!dataloggerStore) return res.status(503).json({ error: 'Data logger management is not initialized.' });
    const doc = await dataloggerStore.get();
    const loggerConfig = doc.loggers.find(item => item.id === req.params.id);
    if (!loggerConfig) return res.status(404).json({ error: 'Data logger not found.' });
    const result = await runDataloggerAction(loggerConfig, 'createTable', { appRoot, logger });
    await dataloggerManager?.applyConfig();
    res.json({ ...result, status: dataloggerManager?.getStatus() || [] });
  }));



  app.post('/api/expressions/evaluate', asyncRoute(async (req, res) => {
    const expression = String(req.body?.expression || '').trim();
    if (!expression) return res.status(400).json({ error: 'Enter an expression to test.' });
    if (expression.length > 1000) return res.status(400).json({ error: 'The expression cannot exceed 1000 characters.' });
    let references;
    try { references = listExpressionReferences(expression); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    const catalog = await store.get();
    const tagsById = new Map(catalog.tags.map(tag => [tag.id.toLowerCase(), tag]));
    const unknown = references.filter(id => !tagsById.has(id.toLowerCase()));
    if (unknown.length) return res.status(400).json({ error: `Unknown Tag ID: ${unknown.join(', ')}` });
    const values = new Map(poller.getLatestValues().map(item => [String(item.tagId).toLowerCase(), item]));
    try {
      const value = evaluateExpression(expression, id => values.get(String(id).toLowerCase()));
      return res.json({
        ok: true,
        value,
        resultType: typeof value,
        references: references.map(id => {
          const tag = tagsById.get(id.toLowerCase());
          const live = values.get(id.toLowerCase());
          return { id: tag.id, name: tag.name || tag.id, quality: live?.quality || 'PENDING', value: live?.value ?? null };
        })
      });
    } catch (error) {
      return res.status(422).json({ error: error.message, references: references.map(id => {
        const tag = tagsById.get(id.toLowerCase());
        const live = values.get(id.toLowerCase());
        return { id: tag.id, name: tag.name || tag.id, quality: live?.quality || 'PENDING', value: live?.value ?? null };
      }) });
    }
  }));
  app.get('/api/status', asyncRoute(async (_req, res) => {
    const catalog = await store.get();
    res.json({
      gateway: poller.getStatus(),
      sourcesConfigured: catalog.sources.length,
      tagsConfigured: catalog.tags.length,
      enabledTags: catalog.tags.filter(tag => tag.enabled !== false).length,
      writeAccess: {
        enabled: plcWritesEnabled(config),
        configEnabled: config.writes?.enabled === true,
        environmentEnabled: true,
        managedByInterface: true
      },
      web: { host: config.web.host, port: config.web.port }
    });
  }));

  app.post('/api/sources/:id/test', asyncRoute(async (req, res) => {
    const catalog = await store.get();
    const source = catalog.sources.find(item => item.id === req.params.id);
    if (!source) return res.status(404).json({ error: 'Device not found.' });
    const tags = catalog.tags.filter(item => item.sourceId === source.id && item.kind !== 'expression');
    let driver;
    try {
      driver = createDriver({ ...source, enabled: true }, tags, logger);
      await driver.connect();
      return res.json({ ok: true, sourceId: source.id, driver: source.driver, message: `Connection successful with ${source.name || source.id} (${source.driver}).` });
    } finally {
      try { await driver?.close(); } catch {}
    }
  }));

  app.post('/api/tags/:id/verify', asyncRoute(async (req, res) => {
    const catalog = await store.get();
    const tag = catalog.tags.find(item => item.id === req.params.id);
    if (!tag) return res.status(404).json({ error: 'Tag not found.' });
    if (tag.kind === 'expression') {
      const latest = new Map(poller.getLatestValues().map(item => [String(item.tagId).toLowerCase(), item]));
      try {
        const value = evaluateExpression(tag.expression, id => latest.get(String(id).toLowerCase()));
        return res.json({ ok: true, tagId: tag.id, value, quality: 'GOOD', message: `Expression ${tag.id} evaluated successfully using the latest samples.` });
      } catch (error) { return res.status(422).json({ error: `Expression verification failed: ${error.message}` }); }
    }
    const source = catalog.sources.find(item => item.id === tag.sourceId);
    if (!source) return res.status(400).json({ error: 'The tag does not have a valid device.' });
    const tags = catalog.tags.filter(item => item.kind !== 'expression' && item.sourceId === source.id);
    validateTagAddressForDriver(catalog, tag);
    let driver;
    try {
      driver = createDriver({ ...source, enabled: true }, tags, logger);
      await driver.connect();
      const value = await driver.read(tag);
      return res.json({ ok: true, tagId: tag.id, address: tag.address, value, quality: 'GOOD', message: `Read successful: ${tag.id} = ${String(value)}` });
    } finally {
      try { await driver?.close(); } catch {}
    }
  }));

  app.post('/api/sources', asyncRoute(async (req, res) => {
    const catalog = await store.get();
    if (catalog.sources.some(source => source.id === req.body?.id)) return res.status(409).json({ error: `Source already exists ${req.body.id}.` });
    catalog.sources.push(req.body);
    await store.save(catalog);
    await poller.reload();
    res.status(201).json({ ok: true, catalog: await store.get() });
  }));

  app.put('/api/sources/:id', asyncRoute(async (req, res) => {
    const catalog = await store.get();
    const index = catalog.sources.findIndex(source => source.id === req.params.id);
    if (index < 0) return res.status(404).json({ error: 'Source not found.' });
    catalog.sources[index] = { ...req.body, id: req.params.id };
    await store.save(catalog);
    await poller.reload();
    res.json({ ok: true, catalog: await store.get() });
  }));

  app.delete('/api/sources/:id', asyncRoute(async (req, res) => {
    const catalog = await store.get();
    if (!catalog.sources.some(source => source.id === req.params.id)) return res.status(404).json({ error: 'Source not found.' });
    const dependent = catalog.tags.filter(tag => tag.sourceId === req.params.id);
    if (dependent.length) return res.status(409).json({ error: `Cannot delete source: there are still ${dependent.length} associated tag(s). Delete or reassign those tags first.` });
    catalog.sources = catalog.sources.filter(source => source.id !== req.params.id);
    await store.save(catalog);
    await poller.reload();
    res.json({ ok: true });
  }));

  app.post('/api/tags', asyncRoute(async (req, res) => {
    const catalog = await store.get();
    if (catalog.tags.some(tag => tag.id === req.body?.id)) return res.status(409).json({ error: `Tag already exists ${req.body.id}.` });
    validateTagAddressForDriver(catalog, req.body || {});
    catalog.tags.push(req.body);
    await store.save(catalog);
    await poller.reload();
    res.status(201).json({ ok: true, catalog: await store.get() });
  }));

  app.put('/api/tags/:id', asyncRoute(async (req, res) => {
    const catalog = await store.get();
    const index = catalog.tags.findIndex(tag => tag.id === req.params.id);
    if (index < 0) return res.status(404).json({ error: 'Tag not found.' });
    validateTagAddressForDriver(catalog, { ...req.body, id: req.params.id });
    catalog.tags[index] = { ...req.body, id: req.params.id };
    await store.save(catalog);
    await poller.reload();
    res.json({ ok: true, catalog: await store.get() });
  }));

  const recentWriteRequests = new Map();
  app.post('/api/tags/:id/write', asyncRoute(async (req, res) => {
    const tagId = String(req.params.id);
    const catalog = await store.get();
    const tag = catalog.tags.find(item => item.id === tagId);
    const source = tag ? catalog.sources.find(item => item.id === tag.sourceId) : null;
    const auditRejected = (status, message) => {
      logger.warn('Audit: PLC write blocked by policy or validation', {
        tagId,
        sourceId: source?.id || tag?.sourceId || null,
        address: tag?.address || null,
        reason: message
      });
      return res.status(status).json({ error: message });
    };

    if (!tag) return auditRejected(404, `Tag ${tagId} does not exist.`);
    if (!plcWritesEnabled(config)) {
      return auditRejected(403, 'PLC writes are globally disabled. Enable global writes in the interface and grant write permission to the device and tag.');
    }
    if (tag.kind === 'expression') return auditRejected(400, 'Expression tags are calculation-only and cannot be written directly to a PLC.');
    if (!source || source.enabled === false || tag.enabled === false) return auditRejected(400, 'The device and tag must be enabled to operate.');
    if (source.writeEnabled !== true || tag.writeEnabled !== true) {
      return auditRejected(403, 'Writing requires writeEnabled on both the device and the tag.');
    }
    if (req.body?.confirmTagId !== tag.id) {
      return auditRejected(400, `Confirmation required: type the TagID exactly again ${tag.id}.`);
    }
    if (!Object.prototype.hasOwnProperty.call(req.body || {}, 'value')) return auditRejected(400, 'The value to write is missing.');
    const lastAt = recentWriteRequests.get(tag.id) || 0;
    if (Date.now() - lastAt < 500) return auditRejected(429, 'Wait half a second before writing to the same tag again.');
    recentWriteRequests.set(tag.id, Date.now());
    try {
      const { validateAndCoerceWriteValue } = require('../services/write-value');
      const value = validateAndCoerceWriteValue(tag, req.body.value);
      const result = await poller.writeTag(tag.id, value);
      logger.warn('Audit: PLC write acknowledged by the driver', {
        tagId: tag.id, sourceId: source.id, driver: source.driver, address: tag.address,
        dataType: tag.dataType, value, protocolResult: result.result?.protocolCode || result.result?.statusCode || 'accepted'
      });
      return res.json({ ok: true, tagId: tag.id, value, message: 'The driver acknowledged the write. No read-back verification was performed.', result: result.result });
    } catch (error) {
      logger.warn('Audit: PLC write rejected or failed', { tagId: tag.id, sourceId: source.id, address: tag.address, message: error?.message || String(error) });
      const message = error?.message || 'PLC write failed.';
      const status = /blocked|cannot write|does not support writing|not implemented|not enabled|not authorized|read-only|outside the range|must be|requires|does not support|cannot encode|missing|not acknowledged|does not allow|explicit endCode/i.test(message) ? 400 : 502;
      return res.status(status).json({ error: message });
    }
  }));

  app.post('/api/tags/:id/write-back', asyncRoute(async (req, res) => {
    const expressionTagId = String(req.params.id);
    const catalog = await store.get();
    const expressionTag = catalog.tags.find(item => item.id === expressionTagId);
    const reject = (status, message, target = null) => {
      logger.warn('Audit: calculated PLC write-back blocked', {
        expressionTagId,
        targetTagId: target?.id || expressionTag?.writeBackTargetTagId || null,
        reason: message
      });
      return res.status(status).json({ error: message });
    };

    if (!expressionTag) return reject(404, `Calculated tag ${expressionTagId} does not exist.`);
    if (expressionTag.kind !== 'expression') return reject(400, 'Write-back is only available for calculated tags.');
    if (expressionTag.writeBackEnabled !== true || !expressionTag.writeBackTargetTagId) {
      return reject(403, 'Enable manual write-back and select a physical destination tag first.');
    }
    if (req.body?.confirmExpressionId !== expressionTag.id) {
      return reject(400, `Confirmation required: enter the calculated TagID exactly: ${expressionTag.id}.`);
    }

    const target = catalog.tags.find(item => item.id === expressionTag.writeBackTargetTagId);
    if (!target || target.kind === 'expression') return reject(400, 'The write-back destination must be an existing physical tag.', target);
    if (req.body?.confirmTargetTagId !== target.id) {
      return reject(400, `Confirmation required: enter the destination TagID exactly: ${target.id}.`, target);
    }
    if (!plcWritesEnabled(config)) return reject(403, 'PLC writes are globally disabled for this instance.', target);
    const source = catalog.sources.find(item => item.id === target.sourceId);
    if (!source || source.enabled === false || target.enabled === false || source.writeEnabled !== true || target.writeEnabled !== true) {
      return reject(403, 'The destination device and tag must be enabled and authorized for writes.', target);
    }

    const latest = new Map(poller.getLatestValues().map(item => [String(item.tagId).toLowerCase(), item])).get(expressionTag.id.toLowerCase());
    if (!latest || latest.quality !== 'GOOD') return reject(409, 'The calculated tag has no latest GOOD value.', target);

    const requestKey = `write-back:${target.id}`;
    const lastAt = recentWriteRequests.get(requestKey) || 0;
    if (Date.now() - lastAt < 500) return reject(429, 'Wait half a second before writing to the same destination again.', target);
    recentWriteRequests.set(requestKey, Date.now());

    try {
      const { validateAndCoerceWriteValue } = require('../services/write-value');
      const value = validateAndCoerceWriteValue(target, latest.value);
      const result = await poller.writeTag(target.id, value);
      logger.warn('Audit: calculated result sent to PLC', {
        expressionTagId: expressionTag.id,
        targetTagId: target.id,
        sourceId: source.id,
        driver: source.driver,
        address: target.address,
        dataType: target.dataType,
        value,
        protocolResult: result.result?.protocolCode || result.result?.statusCode || 'accepted'
      });
      return res.json({
        ok: true,
        expressionTagId: expressionTag.id,
        targetTagId: target.id,
        value,
        message: 'The calculated value was sent to the PLC. No read-back verification was performed.',
        result: result.result
      });
    } catch (error) {
      logger.warn('Audit: calculated PLC write-back failed', {
        expressionTagId: expressionTag.id,
        targetTagId: target.id,
        sourceId: source.id,
        address: target.address,
        message: error?.message || String(error)
      });
      return res.status(502).json({ error: error?.message || 'Calculated PLC write-back failed.' });
    }
  }));

  app.delete('/api/tags/:id', asyncRoute(async (req, res) => {
    const catalog = await store.get();
    if (!catalog.tags.some(tag => tag.id === req.params.id)) return res.status(404).json({ error: 'Tag not found.' });
    catalog.tags = catalog.tags.filter(tag => tag.id !== req.params.id);
    await store.save(catalog);
    await poller.reload();
    res.json({ ok: true });
  }));

  app.use('/api', (err, _req, res, _next) => {
    logger.error('Administration API error', { message: err?.message || String(err) });
    const status = /invalid|requires|missing|must be|duplicate|not supported|reference|cannot|expression|write|read-only|cycle|range|symbol/i.test(err?.message || '') ? 400 : 500;
    res.status(status).json({ error: err?.message || 'Internal API error.' });
  });

  return {
    app,
    listen() {
      return new Promise((resolve, reject) => {
        const server = app.listen(Number(config.web.port), bindHost, () => resolve(server));
        server.once('error', reject);
      });
    }
  };
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

module.exports = { createWebServer, plcWritesEnabled };
