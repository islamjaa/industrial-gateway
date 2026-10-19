const test = require('node:test');
const assert = require('node:assert/strict');
const { Poller } = require('../src/services/poller');
const { validateCatalog } = require('../src/services/catalog-store');

function makeCatalog(expression = 'tag("input_value") + 1') {
  return validateCatalog({
    version: 1,
    sources: [{ id: 's7', name: 'Siemens S7', driver: 'siemens-s7', host: '192.0.2.10', enabled: true, writeEnabled: true, rack: 0, slot: 1 }],
    tags: [
      { id: 'input_value', name: 'Input value', kind: 'physical', sourceId: 's7', address: 'DB1,WORD0', dataType: 'WORD', enabled: true, writeEnabled: false, pollIntervalMs: 1000 },
      { id: 'plc_target', name: 'PLC setpoint', kind: 'physical', sourceId: 's7', address: 'DB1,WORD2', dataType: 'WORD', enabled: true, writeEnabled: true, pollIntervalMs: 1000 },
      { id: 'computed_value', name: 'Calculated value', kind: 'expression', expression, dataType: 'WORD', enabled: true, autoWriteEnabled: true, writeBackTargetTagId: 'plc_target', writeBackMinIntervalMs: 250, pollIntervalMs: 1000 }
    ]
  });
}

function makePoller({ writesEnabled = true, expression } = {}) {
  const catalog = makeCatalog(expression);
  const calls = [];
  const events = [];
  const poller = new Poller(
    { gateway: { name: 'test', default_poll_interval_ms: 1000 }, writes: { enabled: writesEnabled } },
    null,
    { get: async () => catalog },
    { info: (...args) => events.push(['info', ...args]), warn: (...args) => events.push(['warn', ...args]), error: (...args) => events.push(['error', ...args]) }
  );
  poller.catalog = catalog;
  poller.manager = { write: async (tag, value) => { calls.push({ tagId: tag.id, value }); return { statusCode: 'Good' }; } };
  poller.latestValues.set('input_value', { value: 20, quality: 'GOOD', timestampUtc: new Date().toISOString() });
  poller.latestValues.set('plc_target', { value: 0, quality: 'GOOD', timestampUtc: new Date().toISOString() });
  return { poller, calls, events, expressionTag: catalog.tags.find(tag => tag.id === 'computed_value') };
}

async function waitForAutoWrite(poller) {
  for (let i = 0; i < 100 && poller.autoWriteInFlight.size; i++) {
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  await new Promise(resolve => setImmediate(resolve));
}

test('automatic synchronization writes once when a GOOD result changes and does not repeat the same value', async () => {
  const { poller, calls, expressionTag } = makePoller();
  await poller.pollExpression(expressionTag);
  await waitForAutoWrite(poller);
  assert.deepEqual(calls.map(call => call.value), [21]);
  assert.equal(poller.autoWriteStatuses.get('computed_value').state, 'sent');

  await poller.pollExpression(expressionTag);
  await waitForAutoWrite(poller);
  assert.deepEqual(calls.map(call => call.value), [21], 'must not write again if the result did not change');

  poller.latestValues.set('input_value', { value: 21, quality: 'GOOD', timestampUtc: new Date().toISOString() });
  poller.autoWriteLastAttempt.set('computed_value', Date.now() - 1000);
  await poller.pollExpression(expressionTag);
  await waitForAutoWrite(poller);
  assert.deepEqual(calls.map(call => call.value), [21, 22]);
});

test('automatic synchronization does not write if the PLC already contains the calculated value', async () => {
  const { poller, calls, expressionTag } = makePoller();
  poller.latestValues.set('plc_target', { value: 21, quality: 'GOOD', timestampUtc: new Date().toISOString() });
  await poller.pollExpression(expressionTag);
  await waitForAutoWrite(poller);
  assert.equal(calls.length, 0);
  assert.equal(poller.autoWriteStatuses.get('computed_value').state, 'synchronized');
});

test('automatic synchronization remains blocked when global write permission is disabled', async () => {
  const { poller, calls, expressionTag } = makePoller({ writesEnabled: false });
  await poller.pollExpression(expressionTag);
  await waitForAutoWrite(poller);
  assert.equal(calls.length, 0);
  assert.equal(poller.autoWriteStatuses.get('computed_value').state, 'blocked');
});

test('the catalog rejects an expression that depends on its own automatic destination', () => {
  const catalog = {
    version: 1,
    sources: [{ id: 's7', driver: 'siemens-s7', host: '192.0.2.10', enabled: true, writeEnabled: true, rack: 0, slot: 1 }],
    tags: [
      { id: 'plc_target', kind: 'physical', sourceId: 's7', address: 'DB1,WORD0', dataType: 'WORD', enabled: true, writeEnabled: true },
      { id: 'computed_value', kind: 'expression', expression: 'tag("plc_target") + 1', dataType: 'WORD', enabled: true, autoWriteEnabled: true, writeBackTargetTagId: 'plc_target' }
    ]
  };
  assert.throws(() => validateCatalog(catalog), /would create a loop/);
});
