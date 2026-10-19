const { DriverManager } = require('./driver-manager');
const { normalize, normalizeError } = require('../normalizer');
const { insertSample } = require('../database');
const { evaluateExpression, listExpressionReferences } = require('./expression-engine');
const { validateAndCoerceWriteValue } = require('./write-value');

class Poller {
  constructor(config, pool, store, logger, dataloggerManager = null) {
    this.config = config;
    this.pool = pool;
    this.store = store;
    this.logger = logger;
    this.dataloggerManager = dataloggerManager;
    this.manager = null;
    this.catalog = null;
    this.timer = null;
    this.stopping = true;
    this.cyclePromise = null;
    this.nextPollAt = new Map();
    this.consoleLastAt = new Map();
    this.latestValues = new Map();


    this.autoWriteStatuses = new Map();
    this.autoWriteLastSuccess = new Map();
    this.autoWriteLastAttempt = new Map();
    this.autoWriteInFlight = new Set();
    this.autoWritePromises = new Set();
    this.stats = { startedAt: new Date().toISOString(), totalReads: 0, goodReads: 0, badReads: 0, sqlErrors: 0, writesSucceeded: 0, lastSampleAt: null };
  }

  async reload() {
    await this.stop();
    if (this.manager) await this.manager.close();
    this.catalog = await this.store.get();
    this.manager = new DriverManager(this.catalog, this.logger, this.config.gateway.retry_interval_ms);
    await this.manager.connectAll();
    const now = Date.now();
    this.nextPollAt.clear();

    const validKeys = new Set(this.catalog.tags.filter(tag => tag.enabled !== false).map(tag => tag.id.toLowerCase()));
    for (const key of this.latestValues.keys()) if (!validKeys.has(key)) this.latestValues.delete(key);
    const activeAutoExpressions = new Set(this.catalog.tags
      .filter(tag => tag.enabled !== false && tag.kind === 'expression' && tag.autoWriteEnabled === true)
      .map(tag => tag.id.toLowerCase()));
    for (const key of this.autoWriteStatuses.keys()) if (!activeAutoExpressions.has(key)) this.autoWriteStatuses.delete(key);
    for (const key of this.autoWriteLastSuccess.keys()) if (!activeAutoExpressions.has(key)) this.autoWriteLastSuccess.delete(key);
    for (const key of this.autoWriteLastAttempt.keys()) if (!activeAutoExpressions.has(key)) this.autoWriteLastAttempt.delete(key);
    for (const tag of this.catalog.tags) if (tag.enabled !== false) this.nextPollAt.set(tag.id, now);
    this.stopping = false;
    this.schedule(10);
  }

  schedule(delayMs = 100) {
    if (this.stopping) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.runCycle().catch(error => {
      this.logger.error('Unexpected poller error', { message: error?.message || String(error) });
    }), delayMs);
    this.timer.unref?.();
  }

  async runCycle() {
    if (this.stopping) return;
    if (this.cyclePromise) { this.schedule(50); return; }
    this.cyclePromise = this._runCycle();
    try { await this.cyclePromise; } finally {
      this.cyclePromise = null;
      this.schedule(this.nextDelay());
    }
  }

  async _runCycle() {
    if (!this.catalog || !this.manager) return;
    const now = Date.now();
    const dueTags = this.catalog.tags.filter(tag => tag.enabled !== false && (this.nextPollAt.get(tag.id) || 0) <= now);
    const byId = new Map(this.catalog.tags.map(tag => [tag.id.toLowerCase(), tag]));
    const depthMemo = new Map();
    const depthOf = (tag, seen = new Set()) => {
      if (tag.kind !== 'expression') return 0;
      const key = tag.id.toLowerCase();
      if (depthMemo.has(key)) return depthMemo.get(key);
      if (seen.has(key)) return 10000;
      seen.add(key);
      const refs = listExpressionReferences(tag.expression);
      const depth = refs.reduce((max, ref) => Math.max(max, depthOf(byId.get(String(ref).toLowerCase()) || {}, new Set(seen))), 0) + 1;
      depthMemo.set(key, depth);
      return depth;
    };

    dueTags.sort((a, b) => depthOf(a) - depthOf(b));
    for (const tag of dueTags) {
      if (this.stopping) break;
      this.nextPollAt.set(tag.id, Date.now() + Number(tag.pollIntervalMs || this.config.gateway.default_poll_interval_ms));
      if (tag.kind === 'expression') {
        await this.pollExpression(tag);
        continue;
      }
      const source = this.catalog.sources.find(item => item.id === tag.sourceId);
      if (!source || source.enabled === false) {
        this.latestValues.set(tag.id.toLowerCase(), { value: null, quality: 'BAD', timestampUtc: new Date().toISOString() });
        continue;
      }
      await this.pollOne(source, tag);
    }
  }

  async pollExpression(tag) {
    this.stats.totalReads += 1;
    try {
      const value = validateAndCoerceWriteValue(tag, evaluateExpression(tag.expression, id => this.latestValues.get(String(id).toLowerCase())));
      const timestampUtc = new Date().toISOString();
      this.latestValues.set(tag.id.toLowerCase(), { value, quality: 'GOOD', timestampUtc });
      const sample = normalize({ gatewayName: this.config.gateway.name, tag, rawValue: value, quality: 'GOOD' });
      const storageStatus = await this.storeSample(sample, tag);
      this.stats.goodReads += 1;
      this.stats.lastSampleAt = timestampUtc;
      this.logger.info('Expression evaluated', { tag: tag.id, expression: tag.expression, value, quality: 'GOOD', storageStatus });


      if (tag.autoWriteEnabled === true) {
        const writeTask = this.applyExpressionOutput(tag, value);
        this.autoWritePromises.add(writeTask);
        void writeTask.finally(() => this.autoWritePromises.delete(writeTask)).catch(() => undefined);
      }
    } catch (error) {
      this.stats.badReads += 1;
      this.latestValues.set(tag.id.toLowerCase(), { value: null, quality: 'BAD', timestampUtc: new Date().toISOString() });
      const sample = normalizeError({ gatewayName: this.config.gateway.name, tag, error });
      this.logger.error('Expression evaluation failed', { tag: tag.id, expression: tag.expression, message: sample.errorMessage });
      await this.storeSample(sample, tag);
    }
  }

  setAutoWriteStatus(tag, state, message, extra = {}) {
    const key = tag.id.toLowerCase();
    const previous = this.autoWriteStatuses.get(key);
    const next = {
      state,
      message: String(message || ''),
      targetTagId: tag.writeBackTargetTagId || null,
      updatedAt: new Date().toISOString(),
      ...extra
    };
    this.autoWriteStatuses.set(key, next);

    if (previous?.state !== state || previous?.message !== next.message) {
      const data = { expressionTagId: tag.id, targetTagId: next.targetTagId, state, message: next.message };
      if (state === 'error' || state === 'blocked') this.logger.warn('Automatic PLC synchronization', data);
      else this.logger.info('Automatic PLC synchronization', data);
    }
  }

  async applyExpressionOutput(expressionTag, expressionValue) {
    const key = expressionTag.id.toLowerCase();
    if (this.autoWriteInFlight.has(key)) {
      this.setAutoWriteStatus(expressionTag, 'waiting', 'A previous write is still in progress; the latest result will be evaluated when it finishes.');
      return;
    }
    this.autoWriteInFlight.add(key);
    try {
      const targetId = String(expressionTag.writeBackTargetTagId || '');
      const target = this.catalog?.tags.find(item => item.id.toLowerCase() === targetId.toLowerCase());
      if (!this.config.writes || this.config.writes.enabled !== true) {
        this.setAutoWriteStatus(expressionTag, 'blocked', 'Global writes are disabled for this instance.');
        return;
      }
      if (expressionTag.enabled === false || !target || target.kind === 'expression') {
        this.setAutoWriteStatus(expressionTag, 'blocked', 'Calculated tag must be enabled and have a valid physical destination.');
        return;
      }
      const source = this.catalog.sources.find(item => item.id === target.sourceId);
      if (!source || source.enabled === false || target.enabled === false || source.writeEnabled !== true || target.writeEnabled !== true) {
        this.setAutoWriteStatus(expressionTag, 'blocked', 'Both the device and destination tag must be enabled and authorized for writes.');
        return;
      }

      let value;
      try {
        value = validateAndCoerceWriteValue(target, expressionValue);
      } catch (error) {
        this.setAutoWriteStatus(expressionTag, 'error', `Result is incompatible with ${target.id} (${target.dataType}): ${error.message}`);
        return;
      }

      const lastSuccess = this.autoWriteLastSuccess.get(key);
      const physicalSample = this.latestValues.get(target.id.toLowerCase());
      const sameValue = (a, b) => {
        if (typeof a === 'number' && typeof b === 'number') return a === b || (Number.isNaN(a) && Number.isNaN(b));
        return Object.is(a, b) || (a !== null && b !== null && a !== undefined && b !== undefined && typeof a !== 'object' && typeof b !== 'object' && String(a) === String(b));
      };


      if (physicalSample?.quality === 'GOOD' && sameValue(physicalSample.value, value)) {
        this.autoWriteLastSuccess.set(key, { targetTagId: target.id, value, at: Date.now(), alreadyInSync: true });
        this.setAutoWriteStatus(expressionTag, 'synchronized', `The PLC already contains value ${String(value)}.`, { value });
        return;
      }

      if (lastSuccess && lastSuccess.targetTagId === target.id && sameValue(lastSuccess.value, value)) {
        this.setAutoWriteStatus(expressionTag, 'sent', `Last value ${String(value)} sent; the value has not changed.`, { value, writtenAt: new Date(lastSuccess.at).toISOString() });
        return;
      }

      const minIntervalMs = Number(expressionTag.writeBackMinIntervalMs || 1000);
      const lastAttempt = this.autoWriteLastAttempt.get(key) || 0;
      const waitMs = minIntervalMs - (Date.now() - lastAttempt);
      if (waitMs > 0) {
        this.setAutoWriteStatus(expressionTag, 'waiting', `Value changed; waiting for the minimum write interval.`, { value, retryAfterMs: waitMs });
        return;
      }

      this.autoWriteLastAttempt.set(key, Date.now());
      this.setAutoWriteStatus(expressionTag, 'writing', `Writing ${String(value)} to ${target.id}…`, { value });
      const result = await this.writeTag(target.id, value);
      const at = Date.now();
      this.autoWriteLastSuccess.set(key, { targetTagId: target.id, value, at, alreadyInSync: false });
      this.setAutoWriteStatus(expressionTag, 'sent', `Value ${String(value)} sent to ${target.id}. The driver acknowledged the write; read-back verification was not performed.`, {
        value,
        targetTagId: target.id,
        sourceId: source.id,
        writtenAt: new Date(at).toISOString(),
        protocolResult: result.result?.protocolCode || result.result?.statusCode || 'accepted'
      });
    } catch (error) {
      this.setAutoWriteStatus(expressionTag, 'error', error?.message || String(error), { value: expressionValue });
    } finally {
      this.autoWriteInFlight.delete(key);
    }
  }

  async pollOne(source, tag) {
    this.stats.totalReads += 1;
    try {
      const value = await this.manager.read(tag);
      const timestampUtc = new Date().toISOString();
      this.latestValues.set(tag.id.toLowerCase(), { value, quality: 'GOOD', timestampUtc });
      const sample = normalize({ gatewayName: this.config.gateway.name, source, tag, rawValue: value, quality: 'GOOD' });
      const storageStatus = await this.storeSample(sample, tag);
      this.stats.goodReads += 1;
      this.stats.lastSampleAt = sample.timestampUtc.toISOString();
      this.logger.info('Read successful', {
        sourceId: source.id,
        sourceName: source.name,
        driver: source.driver,
        tag: tag.id,
        address: tag.address,
        value,
        quality: 'GOOD',
        storageStatus
      });
    } catch (error) {
      this.stats.badReads += 1;
      this.latestValues.set(tag.id.toLowerCase(), { value: null, quality: 'BAD', timestampUtc: new Date().toISOString() });
      const sample = normalizeError({ gatewayName: this.config.gateway.name, source, tag, error });
      this.logger.error('Read failed', { sourceId: source.id, driver: source.driver, tag: tag.id, address: tag.address, message: sample.errorMessage });
      await this.storeSample(sample, tag);
    }
  }

  async storeSample(sample, tag) {
    if (this.dataloggerManager) {
      const result = await this.dataloggerManager.writeSample(sample, tag);
      if (result.errors) this.stats.sqlErrors += result.errors;
      if (result.written) return `${result.written} datalogger(s) OK`;
      if (result.errors) return 'DATALOGGER ERROR';
      return 'No destination selected';
    }
    if (this.pool) {
      try { await insertSample(this.pool, this.config.sqlserver.table, sample); return 'SQL OK'; }
      catch (error) { this.stats.sqlErrors += 1; this.logger.error('Failed to store sample in SQL', { tag: tag.id, message: error?.message || String(error) }); return 'SQL ERROR'; }
    }
    return 'no data logger';
  }

  async writeTag(tagId, value) {
    if (!this.catalog || !this.manager) throw new Error('The gateway has not been initialized yet.');
    const tag = this.catalog.tags.find(item => item.id === tagId);
    if (!tag) throw new Error(`Tag ${tagId} does not exist.`);
    if (tag.kind === 'expression') throw new Error('Expression tags are calculation-only and cannot be written to the PLC.');
    if (tag.enabled === false) throw new Error(`Tag ${tagId} is disabled; writing is not allowed.`);
    const source = this.catalog.sources.find(item => item.id === tag.sourceId);
    if (!source || source.enabled === false) throw new Error(`Device for ${tagId} is disabled.`);
    if (source.writeEnabled !== true || tag.writeEnabled !== true) throw new Error('Writing is not authorized for this device and tag.');
    const result = await this.manager.write(tag, value);
    this.stats.writesSucceeded += 1;
    return { tagId: tag.id, sourceId: source.id, address: tag.address, value, result };
  }

  getLatestValues() {
    return [...this.latestValues.entries()].map(([tagId, sample]) => {
      const autoWriteStatus = this.autoWriteStatuses.get(tagId);
      return { tagId, ...sample, ...(autoWriteStatus ? { autoWriteStatus } : {}) };
    });
  }

  nextDelay() {
    if (this.stopping || !this.nextPollAt.size) return 1000;
    const first = Math.min(...this.nextPollAt.values());
    return Math.max(25, Math.min(250, first - Date.now()));
  }

  async stop() {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.cyclePromise) await this.cyclePromise.catch(() => undefined);
    if (this.autoWritePromises.size) await Promise.allSettled([...this.autoWritePromises]);
  }

  getStatus() {
    return {
      running: !this.stopping,
      startedAt: this.stats.startedAt,
      totalReads: this.stats.totalReads,
      goodReads: this.stats.goodReads,
      badReads: this.stats.badReads,
      sqlErrors: this.stats.sqlErrors,
      writesSucceeded: this.stats.writesSucceeded,
      lastSampleAt: this.stats.lastSampleAt,
      sources: this.manager ? this.manager.getStatus() : [],
      dataloggers: this.dataloggerManager ? this.dataloggerManager.getStatus() : []
    };
  }
}

module.exports = { Poller };
