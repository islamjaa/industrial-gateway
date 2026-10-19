const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateExpression, listExpressionReferences } = require('../src/services/expression-engine');
const { validateCatalog } = require('../src/services/catalog-store');

test('evaluates formulas with tag references and supported functions', () => {
  const values = new Map([
    ['temperature_in', { value: 20, quality: 'GOOD' }],
    ['temperature_out', { value: 24, quality: 'GOOD' }]
  ]);
  const expression = 'round((tag("temperature_in") + tag("temperature_out")) / 2, 1)';
  assert.equal(evaluateExpression(expression, id => values.get(id)), 22);
  assert.deepEqual(listExpressionReferences(expression), ['temperature_in', 'temperature_out']);
});

test('rejects arbitrary JavaScript and source samples without GOOD quality', () => {
  assert.throws(() => evaluateExpression('process.exit()', () => null), /Unsupported symbol|not supported|not allowed|is invalid/);
  assert.throws(() => evaluateExpression('tag("bad") + 1', () => ({ value: 10, quality: 'BAD' })), /has no GOOD value/);
  assert.throws(() => evaluateExpression('4 / 0', () => null), /Division by zero/);
});

test('catalog accepts calculated tags without a physical device', () => {
  const catalog = {
    version: 1,
    sources: [{ id: 's7_1', name: 'Siemens', driver: 'siemens-s7', host: '192.0.2.10' }],
    tags: [
      { id: 'raw_temp', sourceId: 's7_1', address: 'DB1,REAL0', dataType: 'REAL' },
      { id: 'temp_f', kind: 'expression', expression: 'tag("raw_temp") * 1.8 + 32', dataType: 'REAL' }
    ]
  };
  const valid = validateCatalog(catalog);
  assert.equal(valid.tags[1].kind, 'expression');
  assert.equal(valid.tags[1].sourceId, null);
  assert.equal(valid.tags[1].address, 'EXPRESSION');
  assert.equal(valid.tags[1].writeEnabled, false);
});

test('catalog rejects unknown references and expression cycles', () => {
  const unknown = { version: 1, sources: [], tags: [{ id: 'calc_a', kind: 'expression', expression: 'tag("missing") + 1', dataType: 'REAL' }] };
  assert.throws(() => validateCatalog(unknown), /unknown Tag ID/);
  const circular = { version: 1, sources: [], tags: [
    { id: 'calc_a', kind: 'expression', expression: 'tag("calc_b") + 1', dataType: 'REAL' },
    { id: 'calc_b', kind: 'expression', expression: 'tag("calc_a") + 1', dataType: 'REAL' }
  ] };
  assert.throws(() => validateCatalog(circular), /circular/);
});

test('does not enable writes to read-only Modbus areas', () => {
  const catalog = { version: 1, sources: [{ id: 'mb', driver: 'modbus-tcp', host: '127.0.0.1', writeEnabled: true }], tags: [
    { id: 'input_reg', sourceId: 'mb', address: '0', dataType: 'WORD', registerType: 'input', writeEnabled: true }
  ] };
  assert.throws(() => validateCatalog(catalog), /read-only area/);
});

test('advanced functions scale(), avg(), and bit() are deterministic', () => {
  assert.equal(evaluateExpression('scale(13824, 0, 27648, 0, 10)', () => null), 5);
  assert.equal(evaluateExpression('avg(10, 20, 30)', () => null), 20);
  assert.equal(evaluateExpression('bit(8, 3)', () => null), true);
  assert.equal(evaluateExpression('bit(8, 2)', () => null), false);
  assert.throws(() => evaluateExpression('scale(1, 0, 0, 0, 100)', () => null), /equal input bounds/);
});

test('respects exponentiation precedence and unary sign associativity', () => {
  assert.equal(evaluateExpression('2 ** 3 ** 2', () => null), 512);
  assert.equal(evaluateExpression('-2 ** 2', () => null), -4);
  assert.equal(evaluateExpression('2 ** -2', () => null), 0.25);
  assert.equal(evaluateExpression('(-2) ** 2', () => null), 4);
});
