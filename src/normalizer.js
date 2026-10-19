function normalize({ gatewayName, tag, source, rawValue, quality = 'GOOD' }) {
  const effectiveSource = source || { id: tag.sourceId || 'derived', name: 'Calculated tag', driver: 'expression' };
  return {
    timestampUtc: new Date(),
    gatewayId: gatewayName,
    plcId: effectiveSource.id,
    sourceId: effectiveSource.id,
    tagId: tag.id,
    address: tag.kind === 'expression' ? 'EXPRESSION' : tag.address,
    dataType: tag.dataType,
    valueJson: JSON.stringify(rawValue),
    quality,
    errorMessage: null
  };
}

function normalizeError({ gatewayName, tag, source, error }) {
  const effectiveSource = source || { id: tag.sourceId || 'derived', name: 'Calculated tag', driver: 'expression' };
  return {
    timestampUtc: new Date(),
    gatewayId: gatewayName,
    plcId: effectiveSource.id,
    sourceId: effectiveSource.id,
    tagId: tag.id,
    address: tag.kind === 'expression' ? 'EXPRESSION' : tag.address,
    dataType: tag.dataType,
    valueJson: null,
    quality: 'BAD',
    errorMessage: String(error?.message || error).slice(0, 1000)
  };
}

module.exports = { normalize, normalizeError };
