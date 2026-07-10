function mapRangeToExpiry(range = 'all') {
  const normalized = String(range || 'all').toLowerCase();
  if (normalized === 'today') return '0dte';
  if (normalized === 'near') return 'weekly';
  return 'all';
}

function getRequestedRange(req) {
  return req.query.range || 'all';
}

function emptyMap() {
  return {
    strikes: [],
    liveGravityCurve: [],
    openingGravityCurve: [],
    upperGravity: null,
    lowerGravity: null,
    gravityAxis: null,
    openingUpperGravity: null,
    openingLowerGravity: null,
    openingGravityAxis: null,
    openingGravity: 0,
    liveGravity: 0,
    gravityShift: 0
  };
}

function toMetrics(source = {}) {
  source = source || {};
  const openingGravity = Number(source.globalTotalGex) || 0;
  const liveGravity = Number(source.realtimeTotalGex) || 0;
  const rawShift = Number(source.gexChange);

  return {
    openingGravity,
    liveGravity,
    gravityShift: Number.isFinite(rawShift) ? rawShift : liveGravity - openingGravity,
    openingUpperGravity: source.globalCallWall || null,
    openingLowerGravity: source.globalPutWall || null,
    openingGravityAxis: source.globalZeroGamma || null,
    upperGravity: source.realtimeCallWall || null,
    lowerGravity: source.realtimePutWall || null,
    gravityAxis: source.realtimeZeroGamma || null
  };
}

function toMap(source = {}) {
  source = source || {};
  return {
    strikes: Array.isArray(source.strikes) ? source.strikes : [],
    liveGravityCurve: Array.isArray(source.realtimeStrikeGexMillions) ? source.realtimeStrikeGexMillions : [],
    openingGravityCurve: Array.isArray(source.globalStrikeGexMillions) ? source.globalStrikeGexMillions : [],
    liveGravityRaw: Array.isArray(source.strikeGexRealtime) ? source.strikeGexRealtime : [],
    openingGravityRaw: Array.isArray(source.strikeGexGlobal) ? source.strikeGexGlobal : [],
    ...toMetrics(source)
  };
}

function toReference(source = {}) {
  if (!source) return null;
  const score = Number(source.score);

  return {
    score: Number.isFinite(score) ? score : 0,
    level: source.level || (score >= 80 ? '高' : score >= 50 ? '中' : '低'),
    message: source.message || '引力位不是预测目标，而是需要重点观察的关键价格。',
    reasons: Array.isArray(source.reasons) ? source.reasons : []
  };
}

function metricsForHistoryPoint(historyPoint, range = 'all') {
  const expiry = mapRangeToExpiry(range);
  const source = historyPoint && historyPoint.gexData && historyPoint.gexData[expiry];
  return toMetrics(source);
}

function mapForHistoryPoint(historyPoint, range = 'all') {
  const expiry = mapRangeToExpiry(range);
  const source = historyPoint && historyPoint.gexData && historyPoint.gexData[expiry];
  return source ? toMap(source) : null;
}

function statePayload(input = {}, fallbackTicker = 'SPY') {
  if (!input) {
    return {
      selectedTicker: fallbackTicker,
      isRunning: false,
      currentTime: '09:30:00',
      currentTimePct: 0,
      speedMultiplier: 1,
      spot: 0,
      has0Dte: false,
      latestGravity: null,
      gravityReference: null
    };
  }

  return {
    selectedTicker: input.ticker || fallbackTicker,
    isRunning: Boolean(input.isRunning),
    currentTime: input.currentTime || '09:30:00',
    currentTimePct: Number(input.currentTimePct) || 0,
    speedMultiplier: 1,
    spot: input.spot || 0,
    has0Dte: Boolean(input.has0Dte),
    latestGravity: toMetrics(input.latestMetrics),
    gravityReference: toReference(input.gravityReference)
  };
}

module.exports = {
  emptyMap,
  getRequestedRange,
  mapForHistoryPoint,
  mapRangeToExpiry,
  metricsForHistoryPoint,
  statePayload,
  toMap,
  toMetrics
};
