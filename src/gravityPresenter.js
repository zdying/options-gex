const { buildGravityRoles } = require('./gravityRoles');

function mapRangeToExpiry(range = 'all') {
  const normalized = String(range || 'all').toLowerCase();
  if (normalized === 'today') return '0dte';
  if (normalized === 'near') return 'weekly';
  return 'all';
}

function normalizeRange(range, fallback = 'all') {
  const normalized = String(range || fallback || 'all').toLowerCase();
  if (['today', 'near', 'all'].includes(normalized)) return normalized;
  return fallback;
}

function getRequestedRange(req, fallback = 'all') {
  return normalizeRange(req && req.query ? req.query.range : null, fallback);
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

function roundNumber(value, decimals = 2) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Number(num.toFixed(decimals));
}

function roundNumberOrZero(value, decimals = 2) {
  const rounded = roundNumber(value, decimals);
  return rounded === null ? 0 : rounded;
}

function roundNumberArray(values, decimals = 2) {
  if (!Array.isArray(values)) return [];
  return values.map(value => roundNumberOrZero(value, decimals));
}

function toMetrics(source = {}) {
  source = source || {};
  const openingGravity = Number(source.globalTotalGex) || 0;
  const liveGravity = Number(source.realtimeTotalGex) || 0;
  const rawShift = Number(source.gexChange);

  return {
    openingGravity: roundNumberOrZero(openingGravity),
    liveGravity: roundNumberOrZero(liveGravity),
    gravityShift: roundNumberOrZero(Number.isFinite(rawShift) ? rawShift : liveGravity - openingGravity),
    openingUpperGravity: roundNumber(source.globalCallWall),
    openingLowerGravity: roundNumber(source.globalPutWall),
    openingGravityAxis: roundNumber(source.globalZeroGamma),
    upperGravity: roundNumber(source.realtimeCallWall),
    lowerGravity: roundNumber(source.realtimePutWall),
    gravityAxis: roundNumber(source.realtimeZeroGamma)
  };
}

function toMap(source = {}, context = {}) {
  source = source || {};
  return {
    strikes: roundNumberArray(source.strikes),
    liveGravityCurve: roundNumberArray(source.realtimeStrikeGexMillions),
    openingGravityCurve: roundNumberArray(source.globalStrikeGexMillions),
    // Raw GEX arrays are intentionally not exposed through gravity presenter payloads.
    // liveGravityRaw: Array.isArray(source.strikeGexRealtime) ? source.strikeGexRealtime : [],
    // openingGravityRaw: Array.isArray(source.strikeGexGlobal) ? source.strikeGexGlobal : [],
    gravityRoles: buildGravityRoles(source, context),
    ...toMetrics(source)
  };
}

function toReference(source = {}) {
  if (!source) return null;
  const score = Number(source.score);

  return {
    score: Number.isFinite(score) ? roundNumberOrZero(score) : 0,
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

function mapForHistoryPoint(historyPoint, range = 'all', history = null) {
  const expiry = mapRangeToExpiry(range);
  const source = historyPoint && historyPoint.gexData && historyPoint.gexData[expiry];
  return source ? toMap(source, {
    spot: historyPoint && historyPoint.spot,
    currentSec: historyPoint && historyPoint.sec,
    expiry,
    history
  }) : null;
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
    currentTimePct: roundNumberOrZero(input.currentTimePct),
    speedMultiplier: 1,
    spot: roundNumberOrZero(input.spot),
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
  normalizeRange,
  statePayload,
  toMap,
  toMetrics
};
