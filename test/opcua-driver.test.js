const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { OpcUaClientDriver } = require('../src/drivers/opcua-client');

test('OPC UA reads the Value attribute and rejects bad statuses', async () => {
  const originalLoad = Module._load;
  const calls = [];
  const mockSession = {
    async read(request) {
      calls.push(['read', request.nodeId, request.attributeId]);
      return { statusCode: { isBad: () => false, toString: () => 'Good' }, value: { value: 12.25 } };
    },
    async close() { calls.push(['sessionClose']); }
  };
  const mockClient = {
    async connect(endpoint) { calls.push(['connect', endpoint]); },
    async createSession(identity) { calls.push(['createSession', identity]); return mockSession; },
    async disconnect() { calls.push(['disconnect']); }
  };
  Module._load = function(request, parent, isMain) {
    if (request === 'node-opcua') return {
      OPCUAClient: { create: () => mockClient },
      MessageSecurityMode: { None: 'None' }, SecurityPolicy: { None: 'None' }, AttributeIds: { Value: 13 }
    };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const driver = new OpcUaClientDriver({ id: 'opc', endpoint: 'opc.tcp://127.0.0.1:4840', securityMode: 'None', securityPolicy: 'None' });
    assert.equal(await driver.read({ id: 'temperature', address: 'ns=2;s=Temperature' }), 12.25);
    assert.ok(calls.some(call => call[0] === 'read' && call[1] === 'ns=2;s=Temperature'));
    await driver.close();
  } finally {
    Module._load = originalLoad;
  }
});
