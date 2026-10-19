function normalizeDataType(type) {
  const t = String(type || 'UINT16').toUpperCase();
  if (t === 'BYTE' || t === 'USINT') return 'UINT8';
  if (t === 'SINT' || t === 'SBYTE') return 'INT8';
  if (t === 'WORD' || t === 'UINT') return 'UINT16';
  if (t === 'INT') return 'INT16';
  if (t === 'DWORD' || t === 'UDINT') return 'UINT32';
  if (t === 'DINT') return 'INT32';
  if (t === 'REAL') return 'FLOAT32';
  if (t === 'LREAL') return 'FLOAT64';
  if (t === 'ULINT') return 'UINT64';
  if (t === 'LINT') return 'INT64';
  if (t === 'BIT') return 'BOOL';
  return t;
}

function bytesFromWords(words, wordOrder = 'ABCD') {
  const bytes = [];
  for (const value of words) {
    const n = ((Number(value) % 65536) + 65536) % 65536;
    bytes.push((n >> 8) & 255, n & 255);
  }
  const order = String(wordOrder || 'ABCD').toUpperCase();
  if (order === 'BADC') {
    for (let i = 0; i < bytes.length; i += 2) [bytes[i], bytes[i + 1]] = [bytes[i + 1], bytes[i]];
  } else if (order === 'CDAB' && bytes.length >= 4) {
    for (let i = 0; i + 3 < bytes.length; i += 4) {
      [bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]] = [bytes[i + 2], bytes[i + 3], bytes[i], bytes[i + 1]];
    }
  } else if (order === 'DCBA') {
    bytes.reverse();
  } else if (order !== 'ABCD') {
    throw new Error(`Invalid wordOrder: ${order}. Use ABCD, BADC, CDAB, or DCBA.`);
  }
  return Buffer.from(bytes);
}

function decodeWords(words, tag = {}) {
  if (!Array.isArray(words) || words.length === 0) throw new Error('No registers are available to decode.');
  const type = normalizeDataType(tag.dataType || tag.type);
  const raw = bytesFromWords(words, tag.wordOrder || 'ABCD');
  const bit = Number.isInteger(tag.bit) ? tag.bit : 0;
  if (type === 'BOOL') return Boolean(((Number(words[0]) & 0xffff) >> bit) & 1);
  if (type === 'UINT8') return raw.readUInt8(Number(tag.byteIndex ?? 0));
  if (type === 'INT8') return raw.readInt8(Number(tag.byteIndex ?? 0));
  if (type === 'UINT16') return raw.readUInt16BE(0);
  if (type === 'INT16') return raw.readInt16BE(0);
  if (type === 'UINT32') return raw.readUInt32BE(0);
  if (type === 'INT32') return raw.readInt32BE(0);
  if (type === 'FLOAT32') return raw.readFloatBE(0);
  if (type === 'UINT64') return raw.readBigUInt64BE(0).toString();
  if (type === 'INT64') return raw.readBigInt64BE(0).toString();
  if (type === 'FLOAT64') return raw.readDoubleBE(0);
  if (type === 'STRING' || type === 'UTF8') return raw.toString('utf8').replace(/\0+$/g, '');
  if (type === 'RAW') return raw.toString('hex');
  throw new Error(`Data type is not supported by the register decoder: ${type}`);
}

function wordCountForType(type, explicitLength) {
  const normalized = normalizeDataType(type);
  const fixedWidths = {
    UINT8: 1, INT8: 1, UINT16: 1, INT16: 1, BOOL: 1,
    UINT32: 2, INT32: 2, FLOAT32: 2,
    UINT64: 4, INT64: 4, FLOAT64: 4
  };
  if (Object.prototype.hasOwnProperty.call(fixedWidths, normalized)) {
    const expected = fixedWidths[normalized];
    if (explicitLength !== undefined && Number(explicitLength) !== expected) {
      throw new Error(`Type ${normalized} requires exactly ${expected} word(s); do not set lengthWords=${explicitLength}.`);
    }
    return expected;
  }
  if (['STRING', 'UTF8', 'RAW'].includes(normalized)) {
    if (!Number.isInteger(Number(explicitLength)) || Number(explicitLength) < 1 || Number(explicitLength) > 2048) {
      throw new Error(`${normalized} requires lengthWords between 1 and 2048.`);
    }
    return Number(explicitLength);
  }
  throw new Error(`Length is unknown for data type ${type}.`);
}

function decodeSiemensValue(value, tag) {
  if (value === undefined || value === null) throw new Error(`Siemens returned no value for ${tag.id}.`);
  const type = normalizeDataType(tag.dataType);
  if (type === 'BOOL') return Boolean(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return value.toString('hex');
  return JSON.stringify(value);
}

module.exports = { normalizeDataType, decodeWords, wordCountForType, decodeSiemensValue };
