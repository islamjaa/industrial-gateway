const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { ModbusDriver } = require('../src/drivers/modbus');

test('Modbus normalizes discrete input and uses read-only functions', async () => {
  const originalLoad = Module._load;
  const calls = [];
  class MockModbusRTU {
    setTimeout(value) { calls.push(['setTimeout', value]); }
    connectTCP(host, options, callback) { calls.push(['connectTCP', host, options.port]); queueMicrotask(() => callback()); }
    connectRTUBuffered() { throw new Error('Not expected in TCP test'); }
    setID(unit) { calls.push(['setID', unit]); }
    async readDiscreteInputs(address, count) { calls.push(['readDiscreteInputs', address, count]); return { data: [true] }; }
    async readCoils(address, count) { calls.push(['readCoils', address, count]); return { data: [true] }; }
    async readHoldingRegisters(address, count) { calls.push(['readHoldingRegisters', address, count]); return { data: [123] }; }
    async readInputRegisters(address, count) { calls.push(['readInputRegisters', address, count]); return { data: [456] }; }
    close(callback) { callback?.(); }
  }
  Module._load = function(request, parent, isMain) {
    if (request === 'modbus-serial') return MockModbusRTU;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const driver = new ModbusDriver({ id: 'mb_test', driver: 'modbus-tcp', host: '127.0.0.1', port: 502, timeoutMs: 500 });
    const value = await driver.read({ id: 'di_1', address: '0', dataType: 'BOOL', registerType: 'discreteinput' });
    assert.equal(value, true);
    assert.ok(calls.some(call => call[0] === 'readDiscreteInputs'));
    assert.equal(calls.some(call => call[0] === 'readHoldingRegisters'), false);
    await driver.close();
  } finally {
    Module._load = originalLoad;
  }
});
