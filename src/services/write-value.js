const { normalizeDataType } = require('../drivers/value-decode');

function validateAndCoerceWriteValue(tag, input) {
  const type = normalizeDataType(tag.dataType);
  if (type === 'BOOL') {
    if (input === true || input === false) return input;
    if (input === 1 || input === 0 || input === '1' || input === '0') return Number(input) === 1;
    if (typeof input === 'string' && /^(true|false)$/i.test(input.trim())) return input.trim().toLowerCase() === 'true';
    throw new Error('BOOL value must be true or false.');
  }
  if (type === 'STRING' || type === 'UTF8') {
    if (typeof input !== 'string') throw new Error('STRING value must be text.');
    if (input.length > 1000) throw new Error('Text cannot exceed 1000 characters.');
    if (type === 'UTF8' || tag.lengthWords) {
      const byteLength = Buffer.byteLength(input, 'utf8');
      const capacity = Number(tag.lengthWords || 0) * 2;
      if (capacity && byteLength > capacity) throw new Error(`Text uses ${byteLength} bytes while the tag supports ${capacity}.`);
    }
    return input;
  }
  if (type === 'RAW') throw new Error('RAW writes are not enabled. Use an explicit type to validate the value.');
  if (['UINT64', 'INT64'].includes(type)) {
    let n;
    try { n = BigInt(String(input)); } catch { throw new Error(`Value for ${type} must be a decimal integer.`); }
    const min = type === 'INT64' ? -(2n ** 63n) : 0n;
    const max = type === 'INT64' ? (2n ** 63n) - 1n : (2n ** 64n) - 1n;
    if (n < min || n > max) throw new Error(`Value is outside the range for ${type}.`);
    return n.toString();
  }
  const value = typeof input === 'number' ? input : (typeof input === 'string' && input.trim() !== '' ? Number(input) : NaN);
  if (!Number.isFinite(value)) throw new Error(`Value ${type} must be a finite number.`);
  const integerRanges = {
    UINT8: [0, 255], INT8: [-128, 127],
    UINT16: [0, 65535], INT16: [-32768, 32767],
    UINT32: [0, 4294967295], INT32: [-2147483648, 2147483647]
  };
  if (integerRanges[type]) {
    const [min, max] = integerRanges[type];
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Value must be an integer between ${min} and ${max} for ${type}.`);
  } else if (type === 'FLOAT32') {
    if (Math.abs(value) > 3.402823466e38) throw new Error('Value is outside the range for REAL/FLOAT32.');
  } else if (type !== 'FLOAT64') {
    throw new Error(`Writing does not support type ${tag.dataType}.`);
  }
  return value;
}

function applyByteOrder(buffer, wordOrder = 'ABCD') {
  const order = String(wordOrder || 'ABCD').toUpperCase();
  const bytes = Buffer.from(buffer);
  if (order === 'ABCD') return bytes;
  if (order === 'BADC') {
    for (let i = 0; i + 1 < bytes.length; i += 2) [bytes[i], bytes[i + 1]] = [bytes[i + 1], bytes[i]];
  } else if (order === 'CDAB') {
    if (bytes.length % 4 !== 0) throw new Error('CDAB requires a byte count that is a multiple of four.');
    for (let i = 0; i + 3 < bytes.length; i += 4) {
      [bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]] = [bytes[i + 2], bytes[i + 3], bytes[i], bytes[i + 1]];
    }
  } else if (order === 'DCBA') {
    bytes.reverse();
  } else throw new Error(`Invalid wordOrder: ${order}.`);
  return bytes;
}

function encodeRegisterWords(tag, value) {
  const type = normalizeDataType(tag.dataType);
  const widths = { UINT16: 2, INT16: 2, BOOL: 2, UINT32: 4, INT32: 4, FLOAT32: 4, UINT64: 8, INT64: 8, FLOAT64: 8 };
  let buffer;
  if (type === 'STRING' || type === 'UTF8') {
    const lengthWords = Number(tag.lengthWords);
    if (!Number.isInteger(lengthWords) || lengthWords < 1 || lengthWords > 2048) throw new Error('To write text, set lengthWords between 1 and 2048.');
    buffer = Buffer.alloc(lengthWords * 2);
    Buffer.from(value, 'utf8').copy(buffer);
  } else {
    const width = widths[type];
    if (!width) throw new Error(`Cannot encode ${type} as registers.`);
    buffer = Buffer.alloc(width);
    if (type === 'BOOL') buffer.writeUInt16BE(value ? 1 : 0, 0);
    else if (type === 'UINT16') buffer.writeUInt16BE(value, 0);
    else if (type === 'INT16') buffer.writeInt16BE(value, 0);
    else if (type === 'UINT32') buffer.writeUInt32BE(value, 0);
    else if (type === 'INT32') buffer.writeInt32BE(value, 0);
    else if (type === 'FLOAT32') buffer.writeFloatBE(value, 0);
    else if (type === 'FLOAT64') buffer.writeDoubleBE(value, 0);
    else if (type === 'UINT64') buffer.writeBigUInt64BE(BigInt(value), 0);
    else if (type === 'INT64') buffer.writeBigInt64BE(BigInt(value), 0);
  }
  const physicalBytes = applyByteOrder(buffer, tag.wordOrder || 'ABCD');
  const words = [];
  for (let i = 0; i < physicalBytes.length; i += 2) words.push(physicalBytes.readUInt16BE(i));
  return words;
}

module.exports = { validateAndCoerceWriteValue, encodeRegisterWords };
