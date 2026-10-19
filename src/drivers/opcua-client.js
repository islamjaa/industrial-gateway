const { validateAndCoerceWriteValue } = require('../services/write-value');

class OpcUaClientDriver {
  constructor(source) {
    this.source = source;
    this.client = null;
    this.session = null;
    this.connected = false;
    this.connecting = null;
  }

  async connect() {
    if (this.connected && this.session) return;
    if (this.connecting) return this.connecting;
    if (this.session || this.client) await this.close();
    this.connecting = (async () => {
      const { OPCUAClient, MessageSecurityMode, SecurityPolicy } = require('node-opcua');
      const clientOptions = {
        endpointMustExist: false,
        connectionStrategy: { initialDelay: 1000, maxDelay: 10000, maxRetry: 3 },
        securityMode: MessageSecurityMode[this.source.securityMode || 'None'] ?? MessageSecurityMode.None,
        securityPolicy: SecurityPolicy[this.source.securityPolicy || 'None'] ?? SecurityPolicy.None,
        requestedSessionTimeout: Number(this.source.sessionTimeoutMs || 10000)
      };
      const client = OPCUAClient.create(clientOptions);
      this.client = client;
      await client.connect(this.source.endpoint);
      let identity;
      const username = this.source.usernameEnv ? process.env[this.source.usernameEnv] : undefined;
      const password = this.source.passwordEnv ? process.env[this.source.passwordEnv] : undefined;
      if (username || password) {
        if (!username || !password) throw new Error(`Missing environment variables ${this.source.usernameEnv} or ${this.source.passwordEnv} for OPC UA.`);
        identity = { userName: username, password };
      }
      const session = await client.createSession(identity);
      this.client = client;
      this.session = session;
      this.connected = true;
    })().catch(async error => {
      this.connected = false;
      if (this.session) { try { await this.session.close(); } catch {} }
      if (this.client) { try { await this.client.disconnect(); } catch {} }
      this.session = null;
      this.client = null;
      throw error;
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async read(tag) {
    await this.connect();
    const { AttributeIds } = require('node-opcua');
    let dataValue;
    try { dataValue = await this.session.read({ nodeId: tag.address, attributeId: AttributeIds.Value }); }
    catch (error) { if (/ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|socket|disconnect|channel/i.test(error?.message || '')) this.connected = false; throw error; }
    if (!dataValue?.statusCode || dataValue.statusCode.isBad()) {
      throw new Error(`OPC UA read error for ${tag.address}: ${dataValue?.statusCode?.toString?.() || 'invalid response'}`);
    }
    const value = dataValue.value?.value;
    if (value === undefined) throw new Error(`OPC UA returned no value for ${tag.address}.`);
    if (typeof value === 'bigint') return value.toString();
    if (Buffer.isBuffer(value)) return value.toString('hex');
    if (Array.isArray(value)) return JSON.stringify(value);
    return value;
  }

  async write(tag, value) {
    if (this.source.writeEnabled !== true || tag.writeEnabled !== true) {
      throw new Error('OPC UA write blocked: enable writeEnabled on both the device and the tag.');
    }
    if (tag.kind === 'expression') throw new Error('Expression tags cannot be written to a PLC.');
    value = validateAndCoerceWriteValue(tag, value);
    await this.connect();
    const { AttributeIds, DataType, StatusCodes } = require('node-opcua');
    const type = String(tag.dataType || '').toUpperCase();
    const mapping = {
      BOOL: DataType.Boolean, BIT: DataType.Boolean,
      WORD: DataType.UInt16, UINT16: DataType.UInt16, UINT: DataType.UInt16,
      INT: DataType.Int16, INT16: DataType.Int16,
      DWORD: DataType.UInt32, UINT32: DataType.UInt32,
      DINT: DataType.Int32, INT32: DataType.Int32,
      REAL: DataType.Float, FLOAT32: DataType.Float,
      LREAL: DataType.Double, FLOAT64: DataType.Double,
      STRING: DataType.String, UTF8: DataType.String
    };
    const dataType = mapping[type];
    if (dataType === undefined) throw new Error(`OPC UA write for type ${type} is not implemented by this adapter. Use BOOL, WORD/INT, DWORD/DINT, REAL/LREAL, or STRING.`);
    const statusCode = await this.session.write({
      nodeId: tag.address,
      attributeId: AttributeIds.Value,
      value: { statusCode: StatusCodes.Good, value: { dataType, value } }
    });
    if (!statusCode || (typeof statusCode.isGood === 'function' && !statusCode.isGood())) {
      throw new Error(`The OPC UA server rejected the write to ${tag.address}: ${statusCode?.toString?.() || 'empty response'}`);
    }
    return { accepted: true, statusCode: statusCode.toString?.() || 'Good' };
  }

  async close() {
    const session = this.session;
    const client = this.client;
    this.session = null;
    this.client = null;
    this.connected = false;
    if (session) { try { await session.close(); } catch {} }
    if (client) { try { await client.disconnect(); } catch {} }
  }
}

module.exports = { OpcUaClientDriver };
