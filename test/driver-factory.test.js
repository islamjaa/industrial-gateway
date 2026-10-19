const test = require('node:test');
const assert = require('node:assert/strict');
const { createDriver } = require('../src/drivers');

const sourceByDriver = {
  'omron-fins': { id: 'omron', driver: 'omron-fins', host: '127.0.0.1', port: 9600, protocol: 'tcp' },
  'siemens-s7': { id: 'siemens', driver: 'siemens-s7', host: '127.0.0.1', port: 102, rack: 0, slot: 1 },
  'modbus-tcp': { id: 'modbus_tcp', driver: 'modbus-tcp', host: '127.0.0.1', port: 502 },
  'modbus-rtu': { id: 'modbus_rtu', driver: 'modbus-rtu', portPath: 'COM3', baudRate: 9600 },
  'allen-bradley': { id: 'rockwell', driver: 'allen-bradley', host: '127.0.0.1', slot: 0 },
  'opcua-client': { id: 'opcua', driver: 'opcua-client', endpoint: 'opc.tcp://127.0.0.1:4840' }
};

test('factory creates all adapters without opening connections', () => {
  for (const [driver, source] of Object.entries(sourceByDriver)) {
    const instance = createDriver(source, [], { info() {}, warn() {}, error() {} });
    assert.equal(typeof instance.connect, 'function', `${driver} must expose connect()`);
    assert.equal(typeof instance.read, 'function', `${driver} must expose read()`);
    assert.equal(typeof instance.close, 'function', `${driver} must expose close()`);
  }
});
