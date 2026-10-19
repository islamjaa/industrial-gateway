const { createDataloggerSink } = require('./datalogger-providers');
const { parseValue } = require('./datalogger-providers');

function configSignature(config) { return JSON.stringify(config); }
function valuesEqual(a, b, deadband = 0) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= deadband;
  return Object.is(a, b);
}

class DataloggerManager {
  constructor({ store, appRoot, logger, retryIntervalMs = 5000, createSink = createDataloggerSink }) {
    this.store = store;
    this.appRoot = appRoot;
    this.logger = logger;
    this.retryIntervalMs = retryIntervalMs;
    this.createSink = createSink;
    this.outputs = new Map();
    this.stopping = false;
    this.stats = { samplesAttempted: 0, samplesWritten: 0, errors: 0, lastWriteAt: null };
  }

  async openState(config, existing = null) {
    const state = existing || { id: config.id, status: 'disconnected', lastError: null, lastWriteAt: null, writes: 0, errors: 0, lastErrorShownAt: 0 };
    state.config = config;
    state.signature = configSignature(config);
    state.enabled = config.enabled !== false;
    state.nextRetryAt = 0;
    if (!state.enabled) {
      state.status = 'disabled';
      state.lastError = null;
      state.sink = null;
      return state;
    }
    let sink;
    try {
      sink = this.createSink(config, { appRoot: this.appRoot, logger: this.logger });
      await sink.connect();
      if (config.createTableIfMissing) await sink.createTable();
      state.sink = sink;
      state.status = 'connected';
      state.lastError = null;
      this.logger.info('Data logger connected', { dataloggerId: config.id, provider: config.provider, destination: destinationLabel(config) });
    } catch (error) {
      if (sink) await sink.close().catch(() => undefined);
      state.sink = null;
      state.status = 'error';
      state.lastError = error?.message || String(error);
      state.nextRetryAt = Date.now() + this.retryIntervalMs;
      this.logger.warn('Could not connect data logger', { dataloggerId: config.id, provider: config.provider, message: state.lastError });
    }
    return state;
  }

  async applyConfig() {
    this.stopping = false;
    const document = await this.store.get();
    const old = this.outputs;
    const next = new Map();
    for (const config of document.loggers) {
      const previous = old.get(config.id);
      const sameConfig = previous && previous.signature === configSignature(config);


      const canReuse = Boolean(sameConfig && (config.enabled === false || (previous.status === 'connected' && previous.sink)));
      if (canReuse) {
        next.set(config.id, previous);
        old.delete(config.id);
      } else {
        const oldSink = previous?.sink || null;
        const state = await this.openState(config, previous || null);
        next.set(config.id, state);
        old.delete(config.id);
        if (oldSink && oldSink !== state.sink) await oldSink.close().catch(() => undefined);
      }
    }
    for (const state of old.values()) if (state.sink) await state.sink.close().catch(() => undefined);
    this.outputs = next;
    return this.getStatus();
  }

  selected(config, tag) {
    const list = config.selectedTagIds || [];
    return list.includes('*') || list.includes(tag.id);
  }

  passesTrigger(state, sample, tag) {
    const trigger = state.config.trigger || { mode: 'every-sample' };
    const key = `${state.config.id}|${tag.id}`;
    const parsed = parseValue(sample);
    const triggerState = state.triggerState || (state.triggerState = new Map());
    const previous = triggerState.get(key);
    const now = Date.now();
    let should = false;
    if (trigger.mode === 'every-sample') should = true;
    else if (trigger.mode === 'interval') should = !previous || now - previous.at >= Number(trigger.intervalMs || 1000);
    else if (trigger.mode === 'on-change') {
      should = !previous || previous.quality !== sample.quality || !valuesEqual(previous.value, parsed, Number(trigger.deadband || 0));
    }
    return should;
  }

  markTriggerWritten(state, sample, tag) {
    const key = `${state.config.id}|${tag.id}`;
    const triggerState = state.triggerState || (state.triggerState = new Map());
    triggerState.set(key, { value: parseValue(sample), quality: sample.quality, at: Date.now() });
  }

  async ensureStateConnected(state) {
    if (state.sink) return true;
    if (Date.now() < (state.nextRetryAt || 0)) return false;
    const reopened = await this.openState(state.config, state);
    reopened.nextRetryAt = reopened.status === 'connected' ? 0 : Date.now() + this.retryIntervalMs;
    this.outputs.set(reopened.config.id, reopened);
    return Boolean(reopened.sink);
  }

  async writeSample(sample, tag) {
    const result = { attempted: 0, written: 0, errors: 0, destinations: [] };
    for (const [id, state] of this.outputs) {
      if (!state.enabled || !this.selected(state.config, tag)) continue;
      if (!this.passesTrigger(state, sample, tag)) continue;
      result.attempted += 1;
      this.stats.samplesAttempted += 1;
      try {
        if (!await this.ensureStateConnected(state)) throw new Error(state.lastError || 'Destination is temporarily disconnected.');
        await state.sink.writeSample(sample);
        this.markTriggerWritten(state, sample, tag);
        state.status = 'connected';
        state.lastError = null;
        state.lastWriteAt = new Date().toISOString();
        state.writes += 1;
        this.stats.samplesWritten += 1;
        this.stats.lastWriteAt = state.lastWriteAt;
        result.written += 1;
        result.destinations.push({ id, ok: true });
      } catch (error) {
        state.status = 'error';
        state.lastError = error?.message || String(error);
        this.stats.errors += 1;
        state.errors += 1;
        result.errors += 1;
        result.destinations.push({ id, ok: false, error: state.lastError });
        const now = Date.now();
        if (now - (state.lastErrorShownAt || 0) > 10000) {
          state.lastErrorShownAt = now;
          this.logger.error('Failed to store sample in data logger', { dataloggerId: id, provider: state.config.provider, tagId: tag.id, message: state.lastError });
        }
        if (state.sink) {
          const failedSink = state.sink;
          state.sink = null;
          state.nextRetryAt = Date.now() + this.retryIntervalMs;
          await failedSink.close().catch(() => undefined);
        } else if (!state.nextRetryAt || state.nextRetryAt <= Date.now()) {
          state.nextRetryAt = Date.now() + this.retryIntervalMs;
        }
      }
    }
    return result;
  }

  getStatus() {
    return [...this.outputs.values()].map(state => ({
      id: state.config.id, name: state.config.name, provider: state.config.provider, enabled: state.enabled,
      status: state.status, lastError: state.lastError, lastWriteAt: state.lastWriteAt || null,
      writes: state.writes || 0, errors: state.errors || 0,
      selectedTagCount: (state.config.selectedTagIds || []).includes('*') ? 'all' : (state.config.selectedTagIds || []).length,
      destination: destinationLabel(state.config), trigger: state.config.trigger
    }));
  }

  getStats() { return { ...this.stats }; }

  async close() {
    this.stopping = true;
    await Promise.all([...this.outputs.values()].map(async state => {
      if (state.sink) await state.sink.close().catch(error => this.logger.warn('Error closing data logger', { id: state.id, message: error.message }));
      state.sink = null;
      state.status = 'disconnected';
    }));
    this.outputs.clear();
  }
}

function destinationLabel(config) {
  const d = config.destination || {};
  if (config.provider === 'influxdb2') return `${d.bucket}/${d.measurement}`;
  if (config.provider === 'sqlite') return `${d.filePath || config.connection?.filePath || ''} · ${d.table}`;
  if (config.provider === 'mysql') return `${config.connection?.database}.${d.table}`;
  return `${config.connection?.database}.${d.schema ? `${d.schema}.` : ''}${d.table}`;
}

module.exports = { DataloggerManager, destinationLabel, valuesEqual };
