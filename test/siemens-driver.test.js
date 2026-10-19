const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { SiemensS7Driver } = require('../src/drivers/siemens-s7');

test('Siemens S7 maps the tag ID to its address and returns a normalized value', async () => {
  const originalLoad = Module._load;
  const calls = [];
  class MockS7 {
    initiateConnection(options, callback) { calls.push(['connect', options.host, options.rack, options.slot]); setImmediate(() => callback()); }
    setTranslationCB(fn) { this.translate = fn; }
    addItems(items) { calls.push(['addItems', items]); }
    readAllItems(callback) { callback(false, { temperature: 42.5 }); }
    dropConnection(callback) { callback?.(); }
  }
  Module._load = function(request, parent, isMain) {
    if (request === 'nodes7') return MockS7;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const tag = { id: 'temperature', address: 'DB1,REAL4', dataType: 'REAL' };
    const driver = new SiemensS7Driver({ id: 's7', host: '127.0.0.1', rack: 0, slot: 1, timeoutMs: 100 }, [tag]);
    assert.equal(await driver.read(tag), 42.5);
    assert.equal(driver.client.translate('temperature'), 'DB1,REAL4');
    assert.ok(calls.some(call => call[0] === 'addItems'));
    await driver.close();
  } finally {
    Module._load = originalLoad;
  }
});
