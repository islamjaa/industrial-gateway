const { decodeWords, wordCountForType, normalizeDataType } = require('./value-decode');
const { encodeRegisterWords, validateAndCoerceWriteValue } = require('../services/write-value');

function openWithCallback(client, method, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error instanceof Error ? error : new Error(String(error)));
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error(`Timeout opening Modbus connection (${method}).`)), timeoutMs);
    try {
      const result = client[method](...args, finish);

      if (result && typeof result.then === 'function') result.then(() => finish(), finish);
    } catch (error) {
      finish(error);
    }
  });
}

class ModbusDriver {
  constructor(source) {
    this.source = source;
    this.client = null;
    this.connected = false;
    this.connecting = null;
    this.queue = Promise.resolve();
  }

  async connect() {
    if (this.connected && this.client) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      if (this.client) { try { await this.close(); } catch {} }
      const ModbusRTU = require('modbus-serial');
      const client = new ModbusRTU();
      client.setTimeout(Number(this.source.timeoutMs || 3000));
      this.client = client;
      const timeoutMs = Number(this.source.timeoutMs || 3000);
      try {
        if (this.source.driver === 'modbus-rtu') {
          await openWithCallback(client, 'connectRTUBuffered', [this.source.portPath, {
            baudRate: Number(this.source.baudRate || 9600),
            dataBits: Number(this.source.dataBits || 8),
            stopBits: Number(this.source.stopBits || 1),
            parity: String(this.source.parity || 'none').toLowerCase()
          }], timeoutMs + 1000);
        } else {
          await openWithCallback(client, 'connectTCP', [this.source.host, { port: Number(this.source.port || 502) }], timeoutMs + 1000);
        }
      } catch (error) {
        try { await this.close(); } catch {}
        throw error;
      }
      this.connected = true;
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async read(tag) {

    const task = this.queue.then(async () => {
      await this.connect();
      const rawRegisterType = String(tag.registerType || 'holding').toLowerCase();
      const registerType = rawRegisterType === 'discreteinput' ? 'discrete-input' : rawRegisterType;
      const unitId = Number(tag.unitId ?? this.source.unitId ?? 1);
      await this.client.setID(unitId);
      const address = Number(tag.address);
      if (!Number.isInteger(address) || address < 0 || address > 65535) throw new Error(`Modbus address for ${tag.id} must be an integer offset from 0 to 65535.`);

      if (registerType === 'coil' || registerType === 'discrete-input') {
        const response = registerType === 'coil'
          ? await this.client.readCoils(address, 1)
          : await this.client.readDiscreteInputs(address, 1);
        const values = response?.data;
        if (!Array.isArray(values) || values.length < 1) throw new Error(`Empty Modbus response for ${tag.id}.`);
        if (normalizeDataType(tag.dataType) === 'BOOL') return Boolean(values[0]);
        return values[0] ? 1 : 0;
      }

      const count = wordCountForType(tag.dataType, tag.lengthWords);
      const response = registerType === 'input'
        ? await this.client.readInputRegisters(address, count)
        : await this.client.readHoldingRegisters(address, count);
      if (!Array.isArray(response?.data) || response.data.length < count) throw new Error(`Incomplete Modbus response for ${tag.id}.`);
      return decodeWords(response.data.slice(0, count), tag);
    });

    this.queue = task.catch(() => undefined);
    return task.catch(error => {
      if (/ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|timeout|timed out|not connected|socket|port is not open|Port Not Open/i.test(error?.message || '')) {
        this.connected = false;
      }
      throw error;
    });
  }

  async write(tag, value) {
    if (this.source.writeEnabled !== true || tag.writeEnabled !== true) {
      throw new Error('Modbus write blocked: enable writeEnabled on both the device and the tag.');
    }
    if (tag.kind === 'expression') throw new Error('Expression tags cannot be written to a PLC.');
    value = validateAndCoerceWriteValue(tag, value);
    const task = this.queue.then(async () => {
      await this.connect();
      const registerType = String(tag.registerType || 'holding').toLowerCase().replace('discreteinput', 'discrete-input');
      if (['input', 'discrete-input'].includes(registerType)) throw new Error(`Modbus area ${registerType} is read-only.`);
      const address = Number(tag.address);
      if (!Number.isInteger(address) || address < 0 || address > 65535) throw new Error('Modbus address must be a zero-based offset between 0 and 65535.');
      await this.client.setID(Number(tag.unitId ?? this.source.unitId ?? 1));
      if (registerType === 'coil') {
        if (normalizeDataType(tag.dataType) !== 'BOOL') throw new Error('Only BOOL values can be written to a Modbus coil.');
        const result = await this.client.writeCoil(address, Boolean(value));
        if (!result) throw new Error('Modbus returned no response when writing the coil.');
        return { accepted: true, address, registerType };
      }
      const words = encodeRegisterWords(tag, value);
      const result = words.length === 1
        ? await this.client.writeRegister(address, words[0])
        : await this.client.writeRegisters(address, words);
      if (!result) throw new Error('Modbus returned no response when writing the register.');
      return { accepted: true, address, registerType, words: words.length };
    });
    this.queue = task.catch(() => undefined);
    return task.catch(error => {
      if (/ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|timeout|timed out|not connected|socket|port is not open|Port Not Open/i.test(error?.message || '')) this.connected = false;
      throw error;
    });
  }

  async close() {
    const client = this.client;
    this.client = null;
    this.connected = false;
    if (client && typeof client.close === 'function') {
      await new Promise(resolve => {
        try { client.close(() => resolve()); setTimeout(resolve, 500).unref?.(); }
        catch { resolve(); }
      });
    }
  }
}

module.exports = { ModbusDriver };
