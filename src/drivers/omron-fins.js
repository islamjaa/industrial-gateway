const { decodeWords, wordCountForType } = require('./value-decode');
const { encodeRegisterWords, validateAndCoerceWriteValue } = require('../services/write-value');

function waitForOpen(client, timeoutMs, host) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`Timed out opening FINS/TCP to ${host}`)), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      client.removeListener('open', onOpen);
      client.removeListener('error', onError);
    };
    function finish(error, value) {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve(value);
    }
    const onOpen = value => finish(null, value);
    const onError = error => finish(error instanceof Error ? error : new Error(String(error)));
    client.once('open', onOpen);
    client.once('error', onError);
    try { client.connect(); } catch (error) { finish(error); }
  });
}

class OmronFinsDriver {
  constructor(source, tags, logger) {
    this.source = source;
    this.tags = tags;
    this.logger = logger;
    this.client = null;
    this.connected = false;
  }

  async connect() {
    if (this.connected && this.client) return;
    if (this.client) await this.close();
    const fins = require('omron-fins');
    this.client = fins.FinsClient(Number(this.source.port || 9600), this.source.host, {
      protocol: String(this.source.protocol || 'tcp').toLowerCase(),
      timeout: Number(this.source.timeoutMs || 5000),
      autoConnect: false,
      ...(this.source.DNA !== undefined ? { DNA: this.source.DNA } : {}),
      ...(this.source.DA1 !== undefined ? { DA1: this.source.DA1 } : {}),
      ...(this.source.DA2 !== undefined ? { DA2: this.source.DA2 } : {}),
      ...(this.source.SNA !== undefined ? { SNA: this.source.SNA } : {}),
      ...(this.source.SA1 !== undefined ? { SA1: this.source.SA1 } : {}),
      ...(this.source.SA2 !== undefined ? { SA2: this.source.SA2 } : {})
    });
    this.client.on('error', error => this.logger.warn('FINS driver reported an error', { source: this.source.id, message: error?.message || String(error) }));
    await waitForOpen(this.client, Number(this.source.timeoutMs || 5000), this.source.host);
    this.connected = true;
  }

  async read(tag) {
    await this.connect();
    const count = wordCountForType(tag.dataType, tag.lengthWords);
    let msg;
    try {
      msg = await new Promise((resolve, reject) => {
        this.client.read(tag.address, count, (error, response) => error ? reject(error) : resolve(response));
      });
    } catch (error) {
      if (/ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|not connected|socket/i.test(error?.message || '')) this.connected = false;
      throw error;
    }
    if (!msg || msg.timeout || msg.error) {
      if (msg?.timeout || /timeout|timed out|not connected|socket|ECONNRESET|EPIPE/i.test(String(msg?.error?.message || ''))) this.connected = false;
      throw new Error(`Incomplete FINS response for ${tag.address}`);
    }
    const response = msg.response || msg;
    const code = String(response.endCode ?? '0000').toUpperCase().padStart(4, '0');
    if (code !== '0000') throw new Error(`FINS ${code} at ${tag.address}: ${response.endCodeDescription || 'undocumented error'}`);
    if (!Array.isArray(response.values) || response.values.length < count) throw new Error(`FINS returned fewer than ${count} word(s) for ${tag.address}`);
    return decodeWords(response.values.slice(0, count), tag);
  }

  async write(tag, value) {
    if (this.source.writeEnabled !== true || tag.writeEnabled !== true) {
      throw new Error('FINS write blocked: enable writeEnabled on both the device and the tag.');
    }
    if (tag.kind === 'expression') throw new Error('Expression tags are calculation-only and cannot be written directly to a PLC.');
    value = validateAndCoerceWriteValue(tag, value);
    await this.connect();
    if (tag.bit !== undefined && !String(tag.address).includes('.')) {
      throw new Error('Implicit read-modify-write of a bit within a word is not allowed. Define a compatible bit address.');
    }
    const type = String(tag.dataType || '').toUpperCase();
    const payload = type === 'BOOL' && String(tag.address).includes('.')
      ? [Boolean(value)]
      : encodeRegisterWords(tag, value);
    const result = await new Promise((resolve, reject) => {
      let settled = false;
      const timeoutMs = Number(this.source.timeoutMs || 5000);
      const timer = setTimeout(() => finish(new Error(`Timed out writing ${tag.address} over FINS.`)), timeoutMs);
      const finish = (error, msg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error instanceof Error ? error : new Error(String(error)));
        else resolve(msg);
      };
      try {
        if (typeof this.client.write !== 'function') return finish(new Error('The omron-fins library does not expose write().'));
        const returned = this.client.write(tag.address, payload, (...args) => {
          if (args[0] instanceof Error) return finish(args[0]);
          if (args.length > 1 && args[0]) return finish(args[0]);
          finish(null, args.length > 1 ? args[1] : args[0]);
        });
        if (returned && typeof returned.then === 'function') returned.then(msg => finish(null, msg), finish);
      } catch (error) { finish(error); }
    });
    if (!result || result.timeout || result.error) throw new Error(`FINS did not acknowledge the write to ${tag.address}.`);
    const response = result.response || result;
    if (response.endCode === undefined || response.endCode === null || String(response.endCode).trim() === '') {
      throw new Error(`FINS did not return an explicit endCode when writing ${tag.address}; the write is not considered acknowledged.`);
    }
    const code = String(response.endCode).toUpperCase().padStart(4, '0');
    if (code !== '0000') throw new Error(`FINS ${code} when writing ${tag.address}: ${response.endCodeDescription || 'no description'}`);
    this.logger?.warn('PLC write acknowledged by FINS', { sourceId: this.source.id, tagId: tag.id, address: tag.address, dataType: tag.dataType });
    return { accepted: true, protocolCode: code };
  }

  async close() {
    const client = this.client;
    this.client = null;
    this.connected = false;
    if (client && typeof client.disconnect === 'function') {
      try { client.disconnect(); } catch {  }
    }
  }
}

module.exports = { OmronFinsDriver };
