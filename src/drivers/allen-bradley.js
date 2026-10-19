const { normalizeDataType } = require('./value-decode');
const { validateAndCoerceWriteValue } = require('../services/write-value');

function withTimeout(promise, timeoutMs, description) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timeout ${description}.`)), timeoutMs);
      timer.unref?.();
    })
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

function waitForControllerConnect(client, host, slot, timeoutMs) {
  return withTimeout((async () => {

    let settle;
    const eventConnection = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    const events = [];
    const finish = error => {
      for (const [name, listener] of events) client.removeListener?.(name, listener);
      if (error) settle.reject(error instanceof Error ? error : new Error(String(error)));
      else settle.resolve();
    };
    if (typeof client.on === 'function') {
      for (const name of ['Connected', 'connected']) {
        const listener = () => finish();
        client.on(name, listener);
        events.push([name, listener]);
      }
      const onError = error => finish(error || new Error(`Error connecting to Allen-Bradley at ${host}:44818`));
      client.on('error', onError);
      events.push(['error', onError]);
    }
    try {
      const result = client.connect(host, slot);
      if (result && typeof result.then === 'function') {
        result.then(() => finish(), finish);
      } else if (client.connected === true) {
        finish();
      }
    } catch (error) { finish(error); }
    if (typeof client.on !== 'function' && client.connected !== true) {
      throw new Error('The EtherNet/IP API did not report a connection or return a promise.');
    }
    return eventConnection;
  })(), timeoutMs, `connecting to Allen-Bradley at ${host}:44818`);
}

function readLegacyTag(client, tagObject, timeoutMs) {
  return withTimeout(new Promise((resolve, reject) => {
    try {
      if (typeof client.readTag !== 'function') return reject(new Error('The EtherNet/IP v1 API does not expose readTag(tag).'));
      const callback = (error, value) => error ? reject(error) : resolve(value);
      const result = client.readTag.length >= 2
        ? client.readTag(tagObject, callback)
        : client.readTag(tagObject);
      if (result && typeof result.then === 'function') result.then(resolve, reject);
      else if (client.readTag.length < 2 && result !== undefined) resolve(result);
    } catch (error) { reject(error); }
  }), timeoutMs, `leyendo tag Logix ${tagObject.name || tagObject.program || ''}`);
}

function normalizeReadValue(value, tagAddress) {
  if (value === undefined || value === null) throw new Error(`Allen-Bradley returned no value for Logix tag ${tagAddress}.`);
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return value.toString('hex');
  if (Array.isArray(value) || typeof value === 'object') return JSON.stringify(value);
  return value;
}

class AllenBradleyDriver {
  constructor(source, _tags, logger) {
    this.source = source;
    this.logger = logger;
    this.client = null;
    this.connected = false;
    this.connecting = null;
    this.api = null;
  }

  async connect() {
    if (this.connected && this.client) return;
    if (this.connecting) return this.connecting;
    if (this.client) await this.close();

    this.connecting = (async () => {
      const ethernetIp = require('ethernet-ip');
      const timeoutMs = Number(this.source.timeoutMs || 10000);
      if (typeof ethernetIp.PLC === 'function') {

        const client = new ethernetIp.PLC();
        this.client = client;
        this.api = 'v2';
        try {
          await withTimeout(client.connect(this.source.host, { slot: Number(this.source.slot ?? 0) }), timeoutMs,
            `connecting to Allen-Bradley at ${this.source.host}:44818`);
        } catch (error) {
          try { await client.disconnect?.(); } catch {}
          this.client = null;
          this.connected = false;
          this.api = null;
          throw error;
        }
      } else if (typeof ethernetIp.Controller === 'function' && typeof ethernetIp.Tag === 'function') {
        const client = new ethernetIp.Controller();
        this.client = client;
        this.api = 'v1';
        try {
          await waitForControllerConnect(client, this.source.host, Number(this.source.slot ?? 0), timeoutMs);
        } catch (error) {
          try { await client.disconnect?.(); } catch {}
          this.client = null;
          this.connected = false;
          this.api = null;
          throw error;
        }
      } else {
        throw new Error('The ethernet-ip library exposes neither a compatible PLC v2 API nor a Controller/Tag v1 API.');
      }
      this.connected = true;
      this.logger?.info('Allen-Bradley driver connected', { sourceId: this.source.id, api: this.api, host: this.source.host });
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async read(tag) {
    await this.connect();
    const timeoutMs = Number(this.source.timeoutMs || 10000);
    try {
      let value;
      if (this.api === 'v2') {
        value = await withTimeout(this.client.read(tag.address), timeoutMs, `leyendo tag Logix ${tag.address}`);
      } else {
        const ethernetIp = require('ethernet-ip');
        const tagObject = new ethernetIp.Tag(tag.address);
        const result = await readLegacyTag(this.client, tagObject, timeoutMs);
        value = result && Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : tagObject.value;
      }
      return normalizeReadValue(value, tag.address);
    } catch (error) {
      if (/ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|timeout|socket|disconnect|not connected|closed/i.test(error?.message || '')) this.connected = false;
      throw error;
    }
  }

  async write(tag, value) {
    if (this.source.writeEnabled !== true || tag.writeEnabled !== true) {
      throw new Error('Allen-Bradley write blocked: enable writeEnabled on both the device and the tag.');
    }
    if (tag.kind === 'expression') throw new Error('Expression tags cannot be written to a PLC.');
    value = validateAndCoerceWriteValue(tag, value);
    const normalizedType = normalizeDataType(tag.dataType);
    const wireValue = ['UINT64', 'INT64'].includes(normalizedType) ? BigInt(value) : value;
    await this.connect();
    const timeoutMs = Number(this.source.timeoutMs || 10000);
    try {
      if (this.api === 'v2') {

        const currentValue = await withTimeout(this.client.read(tag.address), timeoutMs, `reading CIP tag type for ${tag.address}`);
        if (currentValue === undefined || currentValue === null) throw new Error(`Could not determine the CIP type of tag ${tag.address}; nothing was written.`);
        await withTimeout(this.client.write(tag.address, wireValue), timeoutMs, `writing Logix tag ${tag.address}`);
      } else {
        const ethernetIp = require('ethernet-ip');
        const tagObject = new ethernetIp.Tag(tag.address);
        const readResult = await readLegacyTag(this.client, tagObject, timeoutMs);
        const existingValue = readResult && Object.prototype.hasOwnProperty.call(readResult, 'value') ? readResult.value : tagObject.value;
        if (existingValue === undefined || existingValue === null) throw new Error(`Could not determine the CIP type of tag ${tag.address}; nothing was written.`);
        tagObject.value = wireValue;
        if (typeof this.client.writeTag !== 'function') throw new Error('The EtherNet/IP v1 API does not expose writeTag().');
        await withTimeout(this.client.writeTag(tagObject), timeoutMs, `writing Logix tag ${tag.address}`);
      }
      return { accepted: true, api: this.api };
    } catch (error) {
      if (/timeout|ECONNRESET|ECONNREFUSED|socket|disconnect|not connected|closed/i.test(error?.message || '')) this.connected = false;
      throw error;
    }
  }

  async close() {
    const client = this.client;
    this.client = null;
    this.connected = false;
    this.api = null;
    if (client && typeof client.disconnect === 'function') {
      try { await client.disconnect(); } catch {  }
    }
  }
}

module.exports = { AllenBradleyDriver };
