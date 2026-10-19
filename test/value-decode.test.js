const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeWords, normalizeDataType, wordCountForType } = require('../src/drivers/value-decode');

test('normalizes industrial data type aliases', () => {
  assert.equal(normalizeDataType('WORD'), 'UINT16');
  assert.equal(normalizeDataType('REAL'), 'FLOAT32');
  assert.equal(normalizeDataType('DINT'), 'INT32');
});

test('decodes Omron UINT16 when the sign bit is set', () => {
  assert.equal(decodeWords([-30651], { dataType: 'UINT16' }), 34885);
});

test('decodes signed INT16', () => {
  assert.equal(decodeWords([65535], { dataType: 'INT16' }), -1);
});

test('decodes FLOAT32 IEEE754 in ABCD order', () => {
  const words = [0x4228, 0x0000];
  assert.equal(decodeWords(words, { dataType: 'FLOAT32' }), 42);
});

test('decodes 32-bit values with CDAB word swap', () => {
  const words = [0x0000, 0x4228];
  assert.equal(decodeWords(words, { dataType: 'FLOAT32', wordOrder: 'CDAB' }), 42);
});

test('decodes BOOL by bit index', () => {
  assert.equal(decodeWords([0b00000100], { dataType: 'BOOL', bit: 2 }), true);
  assert.equal(decodeWords([0b00000100], { dataType: 'BOOL', bit: 3 }), false);
});

test('calculates the word count for wide data types', () => {
  assert.equal(wordCountForType('UINT16'), 1);
  assert.equal(wordCountForType('FLOAT32'), 2);
  assert.equal(wordCountForType('FLOAT64'), 4);
  assert.equal(wordCountForType('STRING', 12), 12);
});


test('rejects an explicit length that conflicts with a fixed-width type', () => {
  assert.throws(() => wordCountForType('FLOAT32', 1), /requires exactly 2/);
  assert.throws(() => wordCountForType('UINT16', 2), /requires exactly 1/);
});

test('STRING requires an explicit length', () => {
  assert.throws(() => wordCountForType('STRING'), /requires lengthWords/);
  assert.equal(wordCountForType('STRING', 8), 8);
});
