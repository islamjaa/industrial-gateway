const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const Module = require('node:module');
const { OmronFinsDriver } = require('../src/drivers/omron-fins');

test('Omron FINS validates endCode and returns an unsigned WORD', async () => {
  const originalLoad = Module._load;
  const calls = [];
  class MockClient extends EventEmitter {
    connect() { setImmediate(() => this.emit('open')); }
    read(address, count, callback) {
      calls.push(['read', address, count]);
      callback(null, { timeout: false, error: false, response: { endCode: '0000', values: [-30651], endCodeDescription: 'Normal Completion.' } });
    }
    disconnect() { calls.push(['disconnect']); }
  }
  Module._load = function(request, parent, isMain) {
    if (request === 'omron-fins') return { FinsClient: (port, host, options) => { calls.push(['FinsClient', port, host, options.protocol]); return new MockClient(); } };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const driver = new OmronFinsDriver({ id: 'omron', host: '127.0.0.1', port: 9600, protocol: 'tcp' }, [], { warn() {} });
    assert.equal(await driver.read({ id: 'D00108', address: 'D00108', dataType: 'UINT16' }), 34885);
    assert.deepEqual(calls.find(call => call[0] === 'read'), ['read', 'D00108', 1]);
    await driver.close();
    assert.equal(calls.some(call => /write/i.test(call[0])), false);
  } finally {
    Module._load = originalLoad;
  }
});

test('Omron rejects unsuccessful FINS end codes', async () => {
  const originalLoad = Module._load;
  class MockClient extends EventEmitter {
    connect() { setImmediate(() => this.emit('open')); }
    read(_address, _count, callback) { callback(null, { timeout: false, error: false, response: { endCode: '2108', values: [] } }); }
    disconnect() {}
  }
  Module._load = function(request, parent, isMain) {
    if (request === 'omron-fins') return { FinsClient: () => new MockClient() };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const driver = new OmronFinsDriver({ id: 'omron', host: '127.0.0.1', port: 9600, protocol: 'tcp' }, [], { warn() {} });
    await assert.rejects(driver.read({ id: 'D00108', address: 'D00108', dataType: 'UINT16' }), /FINS 2108/);
    await driver.close();
  } finally {
    Module._load = originalLoad;
  }
});
