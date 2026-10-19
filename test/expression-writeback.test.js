const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateCatalog } = require('../src/services/catalog-store');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'src/web/server.js'), 'utf8');
function sampleCatalog() {
  return {
    version: 1,
    sources: [{ id: 's7', name: 'Siemens', driver: 'siemens-s7', enabled: true, writeEnabled: true, host: '127.0.0.1', port: 102, rack: 0, slot: 1 }],
    tags: [
      { id: 'setpoint', name: 'Consigna', kind: 'physical', sourceId: 's7', address: 'DB1,WORD0', dataType: 'WORD', enabled: true, writeEnabled: true, pollIntervalMs: 1000 },
      { id: 'computed', name: 'Calculated setpoint', kind: 'expression', expression: 'tag("setpoint") + 1', dataType: 'WORD', enabled: true, writeBackEnabled: true, writeBackTargetTagId: 'setpoint', pollIntervalMs: 1000 }
    ]
  };
}

test('catalog validates the physical destination for expression write-back', () => {
  const catalog = validateCatalog(sampleCatalog());
  const expr = catalog.tags.find(tag => tag.id === 'computed');
  assert.equal(expr.writeBackEnabled, true);
  assert.equal(expr.writeBackTargetTagId, 'setpoint');
  assert.equal(expr.writeEnabled, false, 'a calculated tag never gets physical writeEnabled');
});

test('catalog allows revoking target write permission without invalidating the catalog', () => {
  const catalog = sampleCatalog();
  catalog.tags[0].writeEnabled = false;
  const validated = validateCatalog(catalog);
  assert.equal(validated.tags.find(tag => tag.id === 'computed').writeBackTargetTagId, 'setpoint');
});

test('catalog rejects write-back without a destination and calculated destinations', () => {
  const noTarget = sampleCatalog();
  noTarget.tags[1].writeBackTargetTagId = '';
  assert.throws(() => validateCatalog(noTarget), /requires a configured physical destination tag/);
  const expressionTarget = sampleCatalog();
  expressionTarget.tags.push({ id: 'computed2', name: 'Another expression', kind: 'expression', expression: 'tag("setpoint") * 2', dataType: 'WORD', enabled: true, writeBackEnabled: false, pollIntervalMs: 1000 });
  expressionTarget.tags[1].writeBackTargetTagId = 'computed2';
  assert.throws(() => validateCatalog(expressionTarget), /must be a physical tag/);
});

test('the write-back API requires source and destination confirmation and a GOOD result', () => {
  assert.match(server, /app\.post\('\/api\/tags\/:id\/write-back'/);
  assert.match(server, /confirmExpressionId/);
  assert.match(server, /confirmTargetTagId/);
  assert.match(server, /latest\.quality !== 'GOOD'/);
  assert.match(server, /Audit: calculated result sent to PLC/);
});
