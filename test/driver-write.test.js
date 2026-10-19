const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const Module = require('node:module');
const { OmronFinsDriver } = require('../src/drivers/omron-fins');
const { SiemensS7Driver } = require('../src/drivers/siemens-s7');
const { ModbusDriver } = require('../src/drivers/modbus');
const { AllenBradleyDriver } = require('../src/drivers/allen-bradley');
const { OpcUaClientDriver } = require('../src/drivers/opcua-client');

test('all drivers block writes when device write permission is disabled', async () => {
  const cases = [
    new OmronFinsDriver({ id: 'o', host: '127.0.0.1', writeEnabled: false }),
    new SiemensS7Driver({ id: 's', host: '127.0.0.1', writeEnabled: false }, []),
    new ModbusDriver({ id: 'm', driver: 'modbus-tcp', host: '127.0.0.1', writeEnabled: false }),
    new AllenBradleyDriver({ id: 'a', host: '127.0.0.1', writeEnabled: false }),
    new OpcUaClientDriver({ id: 'u', endpoint: 'opc.tcp://127.0.0.1:4840', writeEnabled: false })
  ];
  for (const driver of cases) {
    await assert.rejects(driver.write({ id: 'setpoint', address: 'Value', dataType: 'WORD', writeEnabled: true }, 1), /write blocked/);
    assert.equal(driver.client, null, 'must not open communication when writing is blocked');
  }
});

test('Modbus writes only with explicit authorization and writable areas', async () => {
  const originalLoad = Module._load;
  const calls = [];
  class MockModbusRTU {
    setTimeout() {}
    connectTCP(_host, _options, callback) { callback(); }
    async setID(unit) { calls.push(['setID', unit]); }
    async writeRegister(address, value) { calls.push(['writeRegister', address, value]); return { address, value }; }
    async writeRegisters(address, values) { calls.push(['writeRegisters', address, values]); return { address, values }; }
    async writeCoil(address, value) { calls.push(['writeCoil', address, value]); return { address, value }; }
    async readHoldingRegisters() { throw new Error('An implicit read should not occur.'); }
    close(callback) { callback?.(); }
  }
  Module._load = function(request, parent, isMain) { if (request === 'modbus-serial') return MockModbusRTU; return originalLoad.call(this, request, parent, isMain); };
  try {
    const driver = new ModbusDriver({ id: 'mb', driver: 'modbus-tcp', host: '127.0.0.1', writeEnabled: true, timeoutMs: 200 });
    const tag = { id: 'speed', address: '12', dataType: 'WORD', registerType: 'holding', unitId: 1, writeEnabled: true };
    const result = await driver.write(tag, 1234);
    assert.equal(result.accepted, true);
    assert.ok(calls.some(call => call[0] === 'writeRegister' && call[1] === 12 && call[2] === 1234));
    await assert.rejects(driver.write({ ...tag, registerType: 'input' }, 2), /read-only/);
    await driver.close();
  } finally { Module._load = originalLoad; }
});

test('Omron validates endCode before acknowledging a write', async () => {
  const originalLoad = Module._load;
  const calls = [];
  class MockClient extends EventEmitter {
    connect() { setImmediate(() => this.emit('open')); }
    write(address, values, callback) { calls.push(['write', address, values]); callback(null, { timeout: false, error: false, response: { endCode: '0000' } }); }
    disconnect() {}
  }
  Module._load = function(request, parent, isMain) { if (request === 'omron-fins') return { FinsClient: () => new MockClient() }; return originalLoad.call(this, request, parent, isMain); };
  try {
    const driver = new OmronFinsDriver({ id: 'omron', host: '127.0.0.1', port: 9600, protocol: 'tcp', writeEnabled: true }, [], { warn() {} });
    const result = await driver.write({ id: 'D00108', address: 'D00108', dataType: 'WORD', writeEnabled: true }, 1234);
    assert.deepEqual(calls, [['write', 'D00108', [1234]]]);
    assert.equal(result.protocolCode, '0000');
    await driver.close();
  } finally { Module._load = originalLoad; }
});

test('Omron does not acknowledge a write without a response endCode', async () => {
  const originalLoad = Module._load;
  class MockClient extends EventEmitter {
    connect() { setImmediate(() => this.emit('open')); }
    write(_address, _values, callback) { callback(null, Buffer.from([0, 0])); }
    disconnect() {}
  }
  Module._load = function(request, parent, isMain) { if (request === 'omron-fins') return { FinsClient: () => new MockClient() }; return originalLoad.call(this, request, parent, isMain); };
  try {
    const driver = new OmronFinsDriver({ id: 'omron', host: '127.0.0.1', port: 9600, protocol: 'tcp', writeEnabled: true }, [], { warn() {} });
    await assert.rejects(driver.write({ id: 'D00108', address: 'D00108', dataType: 'WORD', writeEnabled: true }, 1234), /explicit endCode/);
    await driver.close();
  } finally { Module._load = originalLoad; }
});
