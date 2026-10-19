const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { AllenBradleyDriver } = require('../src/drivers/allen-bradley');

test('Allen-Bradley v1 reads with Controller/Tag without implicit writes', async () => {
  const originalLoad = Module._load;
  const calls = [];
  class MockTag { constructor(name) { this.name = name; this.value = undefined; } }
  class MockController {
    async connect(host, slot) { calls.push(['connect', host, slot]); }
    async readTag(tag) { calls.push(['readTag', tag.name]); tag.value = 23.5; return tag; }
    async disconnect() { calls.push(['disconnect']); }
    on() { return this; }
  }
  Module._load = function(request, parent, isMain) {
    if (request === 'ethernet-ip') return { Controller: MockController, Tag: MockTag };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const driver = new AllenBradleyDriver({ id: 'ab_test', driver: 'allen-bradley', host: '127.0.0.1', slot: 0 });
    const value = await driver.read({ id: 'tag_test', address: 'Temperature' });
    assert.equal(value, 23.5);
    assert.deepEqual(calls, [['connect', '127.0.0.1', 0], ['readTag', 'Temperature']]);
    await driver.close();
    assert.deepEqual(calls.at(-1), ['disconnect']);
  } finally { Module._load = originalLoad; }
});

test('Allen-Bradley v2 uses PLC.read and PLC.write with explicit permissions', async () => {
  const originalLoad = Module._load;
  const calls = [];
  class MockPLC {
    async connect(host, options) { calls.push(['connect', host, options.slot]); }
    async read(address) { calls.push(['read', address]); return 12.5; }
    async write(address, value) { calls.push(['write', address, value]); }
    async disconnect() { calls.push(['disconnect']); }
  }
  Module._load = function(request, parent, isMain) {
    if (request === 'ethernet-ip') return { PLC: MockPLC };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const source = { id: 'ab_test', driver: 'allen-bradley', host: '127.0.0.1', slot: 2, writeEnabled: true };
    const driver = new AllenBradleyDriver(source);
    const tag = { id: 'setpoint', address: 'Program:MainProgram.SetPoint', dataType: 'REAL', writeEnabled: true };
    assert.equal(await driver.read(tag), 12.5);
    assert.deepEqual(calls[0], ['connect', '127.0.0.1', 2]);
    assert.deepEqual(calls[1], ['read', tag.address]);
    assert.deepEqual(await driver.write(tag, 30.25), { accepted: true, api: 'v2' });
    assert.deepEqual(calls.slice(2), [['read', tag.address], ['write', tag.address, 30.25]]);
    await driver.close();
  } finally { Module._load = originalLoad; }
});

test('Allen-Bradley blocks writes by default before connecting', async () => {
  const driver = new AllenBradleyDriver({ id: 'ab_test', host: '192.0.2.1', writeEnabled: false });
  await assert.rejects(driver.write({ id: 'setpoint', address: 'SetPoint', writeEnabled: true, dataType: 'REAL' }, 42), /Allen-Bradley write blocked/);
  assert.equal(driver.client, null);
});
