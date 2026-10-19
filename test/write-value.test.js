const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAndCoerceWriteValue, encodeRegisterWords } = require('../src/services/write-value');
const { decodeWords } = require('../src/drivers/value-decode');

test('validates industrial ranges and does not silently convert out-of-range values', () => {
  assert.equal(validateAndCoerceWriteValue({ dataType: 'WORD' }, '65535'), 65535);
  assert.throws(() => validateAndCoerceWriteValue({ dataType: 'WORD' }, 65536), /between 0 and 65535/);
  assert.equal(validateAndCoerceWriteValue({ dataType: 'BOOL' }, 'true'), true);
  assert.throws(() => validateAndCoerceWriteValue({ dataType: 'BOOL' }, 'maybe'), /true or false/);
});

test('encodes and decodes WORD, INT, and REAL using the same order', () => {
  for (const [dataType, value] of [['WORD', 53123], ['INT', -1200], ['REAL', 21.75]]) {
    const tag = { dataType, wordOrder: 'ABCD' };
    const words = encodeRegisterWords(tag, value);
    const decoded = decodeWords(words, tag);
    assert.equal(decoded, value);
  }
});

test('DWORD supports explicit word swap', () => {
  const tag = { dataType: 'DWORD', wordOrder: 'CDAB' };
  const words = encodeRegisterWords(tag, 0x12345678);
  assert.deepEqual(words, [0x5678, 0x1234]);
  assert.equal(decodeWords(words, tag), 0x12345678);
});

test('does not allow RAW writes without a defined type and encoding', () => {
  assert.throws(() => validateAndCoerceWriteValue({ dataType: 'RAW' }, '0102'), /not enabled/);
});

test('validates 64-bit integers without losing JavaScript precision', () => {
  assert.equal(validateAndCoerceWriteValue({ dataType: 'UINT64' }, '18446744073709551615'), '18446744073709551615');
  assert.throws(() => validateAndCoerceWriteValue({ dataType: 'UINT64' }, '-1'), /outside the range/);
});
