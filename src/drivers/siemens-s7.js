const { decodeSiemensValue, normalizeDataType } = require('./value-decode');
const { validateAndCoerceWriteValue } = require('../services/write-value');
const { validateSiemensTagAddress } = require('./siemens-address');

class SiemensS7Driver {
  constructor(source, tags) {
    this.source = source;
    this.tags = tags;
    this.client = null;
    this.connected = false;
    this.addresses = new Map(tags.map(tag => [tag.id, tag.address]));
    this.connecting = null;
    this.readSnapshot = null;
    this.readSnapshotAt = 0;
    this.readSnapshotReady = false;
  }

  async connect() {
    if (this.connected && this.client) return;
    if (this.connecting) return this.connecting;
    if (this.client) await this.close();
    this.connecting = new Promise((resolve, reject) => {
      const nodes7 = require('nodes7');
      const client = new nodes7({ silent: true });
      this.client = client;
      let settled = false;
      const timeoutMs = Number(this.source.timeoutMs || 5000);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.connected = false;
        try { client.dropConnection(() => undefined); } catch {}
        reject(new Error(`Timed out connecting to Siemens S7 at ${this.source.host}`));
      }, timeoutMs + 1000);
      client.initiateConnection({
        host: this.source.host,
        port: Number(this.source.port || 102),
        rack: Number(this.source.rack ?? 0),
        slot: Number(this.source.slot ?? 1),
        timeout: timeoutMs,
        debug: false
      }, error => {
        if (settled) { try { client.dropConnection(() => undefined); } catch {} return; }
        settled = true;
        clearTimeout(timer);
        if (error) { this.connected = false; reject(error instanceof Error ? error : new Error(String(error))); return; }
        client.setTranslationCB(key => this.addresses.get(key));
        client.addItems(this.tags.map(tag => tag.id));
        this.connected = true;
        resolve();
      });
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async read(tag) {
    await this.connect();



    const cacheMs = Math.max(0, Number(this.source.readCacheMs ?? 50));
    if (!this.readSnapshot || (this.readSnapshotReady && Date.now() - this.readSnapshotAt > cacheMs)) {
      this.readSnapshotReady = false;
      this.readSnapshot = new Promise((resolve, reject) => {
        this.client.readAllItems((anythingBad, result) => {
          if (!result || typeof result !== 'object') return reject(new Error('Siemens S7 returned an empty response.'));
          resolve({ values: result, anythingBad: Boolean(anythingBad) });
        });
      }).then(snapshot => {
        this.readSnapshotAt = Date.now();
        this.readSnapshotReady = true;
        return snapshot;
      }).catch(error => { this.readSnapshot = null; this.readSnapshotReady = false; throw error; });
    }
    let snapshot;
    try { snapshot = await this.readSnapshot; }
    catch (error) { this.connected = false; throw error; }
    const value = snapshot.values[tag.id];
    if (value === undefined || value === null || (typeof value === 'number' && !Number.isFinite(value))) {


      throw new Error(`Could not read Siemens tag ${tag.address}; check the address syntax, rack/slot, and PLC access${snapshot.anythingBad ? ' (the library reported invalid quality for at least one item)' : ''}.`);
    }
    return decodeSiemensValue(value, tag);
  }

  async write(tag, value) {
    if (this.source.writeEnabled !== true || tag.writeEnabled !== true) {
      throw new Error('Siemens write blocked: enable writeEnabled on both the device and the tag.');
    }
    if (tag.kind === 'expression') throw new Error('Expression tags cannot be written to a PLC.');
    const type = normalizeDataType(tag.dataType);
    const supportedTypes = new Set(['BOOL', 'UINT8', 'UINT16', 'INT16', 'UINT32', 'INT32', 'FLOAT32', 'FLOAT64', 'STRING', 'UTF8']);
    if (!supportedTypes.has(type)) {
      throw new Error(`Siemens writes via nodes7 are not enabled for ${tag.dataType}. Use BOOL, BYTE, WORD, INT, DWORD, DINT, REAL, or STRING.`);
    }
    value = validateAndCoerceWriteValue(tag, value);
    validateSiemensTagAddress(tag.address, tag.dataType, { write: true });
    await this.connect();
    if (typeof this.client.writeItems !== 'function') throw new Error('The nodes7 library does not expose writeItems().');
    const timeoutMs = Number(this.source.timeoutMs || 5000);
    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(new Error(`Timed out writing Siemens tag ${tag.id}.`)), timeoutMs);
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve();
      };
      try {

        this.client.writeItems(tag.id, value, anythingBad => {
          if (anythingBad instanceof Error) return finish(anythingBad);
          if (anythingBad) return finish(new Error(`nodes7 could not confirm the write to  ${tag.address}.`));
          finish();
        });
      } catch (error) { finish(error); }
    });
    this.readSnapshot = null;
    this.readSnapshotReady = false;
    this.logger?.warn('PLC write acknowledged by Siemens S7', { sourceId: this.source.id, tagId: tag.id, address: tag.address, dataType: tag.dataType });
    return { accepted: true };
  }

  async close() {
    const client = this.client;
    this.client = null;
    this.connected = false;
    this.readSnapshot = null;
    this.readSnapshotAt = 0;
    this.readSnapshotReady = false;
    if (client && typeof client.dropConnection === 'function') {
      await new Promise(resolve => {
        try { client.dropConnection(() => resolve()); } catch { resolve(); }
        setTimeout(resolve, 1000).unref?.();
      });
    }
  }
}

module.exports = { SiemensS7Driver };
