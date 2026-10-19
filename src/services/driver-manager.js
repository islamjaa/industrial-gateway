const { createDriver } = require('../drivers');

class DriverManager {
  constructor(catalog, logger, retryIntervalMs = 5000) {
    this.catalog = catalog;
    this.logger = logger;
    this.retryIntervalMs = retryIntervalMs;
    this.states = new Map();
    const tagsBySource = new Map();
    for (const tag of catalog.tags.filter(item => item.enabled !== false && item.kind !== 'expression')) {
      if (!tagsBySource.has(tag.sourceId)) tagsBySource.set(tag.sourceId, []);
      tagsBySource.get(tag.sourceId).push(tag);
    }
    for (const source of catalog.sources.filter(item => item.enabled !== false)) {
      const tags = tagsBySource.get(source.id) || [];
      if (!tags.length) continue;
      this.states.set(source.id, {
        source,
        tags,
        driver: createDriver(source, tags, logger),
        status: 'disconnected',
        lastError: null,
        lastConnectedAt: null,
        retryAt: 0,
        connecting: null,
        operationQueue: Promise.resolve()
      });
    }
  }

  async connectAll() {
    await Promise.all([...this.states.values()].map(state => this.ensureConnected(state, true).catch(() => undefined)));
  }

  async ensureConnected(state, force = false) {
    if (state.driver.connected) {
      state.status = 'connected';
      return;
    }
    if (state.connecting) return state.connecting;
    if (!force && Date.now() < state.retryAt) {
      const seconds = Math.max(1, Math.ceil((state.retryAt - Date.now()) / 1000));
      throw new Error(`Source ${state.source.id} disconnected; next retry in ${seconds} s${state.lastError ? ` (${state.lastError})` : ''}`);
    }
    state.connecting = (async () => {
      state.status = 'connecting';
      try {
        await state.driver.connect();
        state.status = 'connected';
        state.lastError = null;
        state.lastConnectedAt = new Date().toISOString();
        state.retryAt = 0;
        this.logger.info('Source connected', { sourceId: state.source.id, driver: state.source.driver, host: state.source.host || state.source.endpoint || state.source.portPath });
      } catch (error) {
        state.status = 'disconnected';
        state.lastError = error?.message || String(error);
        state.retryAt = Date.now() + this.retryIntervalMs;
        this.logger.warn('Source connection failed', { sourceId: state.source.id, driver: state.source.driver, message: state.lastError });
        throw error;
      } finally {
        state.connecting = null;
      }
    })();
    return state.connecting;
  }

  enqueue(state, operation) {
    const task = state.operationQueue.then(operation, operation);
    state.operationQueue = task.catch(() => undefined);
    return task;
  }

  async read(tag) {
    const state = this.states.get(tag.sourceId);
    if (!state) throw new Error(`No active driver for source ${tag.sourceId}.`);
    return this.enqueue(state, async () => {
      await this.ensureConnected(state);
      try {
        const value = await state.driver.read(tag);
        state.status = state.driver.connected === false ? 'disconnected' : 'connected';
        state.lastError = null;
        return value;
      } catch (error) {
        state.lastError = error?.message || String(error);
        if (state.driver.connected === false || /ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|timeout|timed out|not connected|socket|port is not open/i.test(state.lastError)) {
          state.status = 'disconnected';
          state.retryAt = Date.now() + this.retryIntervalMs;
        }
        throw error;
      }
    });
  }

  async write(tag, value) {
    if (tag.kind === 'expression') throw new Error('Expression tags cannot be written directly to a PLC.');
    const state = this.states.get(tag.sourceId);
    if (!state) throw new Error(`No active driver for source ${tag.sourceId}.`);
    if (state.source.writeEnabled !== true || tag.writeEnabled !== true) throw new Error('Writing is not enabled on both the device and the tag.');
    if (typeof state.driver.write !== 'function') throw new Error(`The driver ${state.source.driver} does not implement writing for this configuration.`);
    return this.enqueue(state, async () => {
      await this.ensureConnected(state);
      try {
        const result = await state.driver.write(tag, value);
        state.status = state.driver.connected === false ? 'disconnected' : 'connected';
        state.lastError = null;
        this.logger.warn('PLC write acknowledged by driver', {
          sourceId: state.source.id,
          driver: state.source.driver,
          tagId: tag.id,
          address: tag.address,
          dataType: tag.dataType,
          result: result?.protocolCode || result?.statusCode || 'accepted'
        });
        return result;
      } catch (error) {
        state.lastError = error?.message || String(error);
        this.logger.error('PLC write failed', { sourceId: state.source.id, driver: state.source.driver, tagId: tag.id, address: tag.address, message: state.lastError });
        throw error;
      }
    });
  }

  getStatus() {
    return [...this.states.values()].map(state => ({
      id: state.source.id,
      name: state.source.name,
      driver: state.source.driver,
      status: state.status,
      tags: state.tags.length,
      lastConnectedAt: state.lastConnectedAt,
      lastError: state.lastError
    }));
  }

  async close() {
    await Promise.all([...this.states.values()].map(async state => {
      try { await state.driver.close(); } catch (error) {
        this.logger.warn('Error closing driver', { sourceId: state.source.id, message: error?.message || String(error) });
      }
      state.status = 'disconnected';
    }));
    this.states.clear();
  }
}

module.exports = { DriverManager };
