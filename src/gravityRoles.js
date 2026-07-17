/**
 * @file gravityRoles.js
 * @description Derive user-facing gravity roles from existing GEX summaries and spot history.
 */

const { buildStructure } = require('./gravityStructure');

const ROLE_DISTANCE_PCT = 0.03;
const DISTANCE_WEIGHT_PCT = 0.015;
const MIN_NORMALIZED_STRENGTH = 0.08;
const TREND_5M_THRESHOLD = 0.0015;
const TREND_15M_THRESHOLD = 0.003;
const RECENT_VOL_LOOKBACK_SEC = 15 * 60;
const PIN_VOL_WEIGHT = 0.35;
const PIN_SPACING_WEIGHT = 0.12;
const PIN_MIN_PCT = 0.0015;
const PIN_MAX_SPACING_FRACTION = 0.45;
const PIN_HOLD_MULTIPLIER = 1.25;
const PIN_HOLD_MAX_SPACING_FRACTION = 0.55;
const ACTIVE_HOLD_MIN_STRENGTH = 0.3;
const SWITCH_CONFIRM_SEC = 3 * 60;

function finite(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function round(value, digits = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const scale = 10 ** digits;
  return Math.round(num * scale) / scale;
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .map(point => ({
      sec: finite(point && point.sec, NaN),
      spot: finite(point && point.spot, NaN)
    }))
    .filter(point => Number.isFinite(point.sec) && Number.isFinite(point.spot) && point.spot > 0)
    .sort((a, b) => a.sec - b.sec);
}

function findPointAtOrBefore(history, sec) {
  let result = null;
  for (const point of history) {
    if (point.sec <= sec) result = point;
    if (point.sec > sec) break;
  }
  return result;
}

function pctChange(from, to) {
  if (!Number.isFinite(from) || from <= 0 || !Number.isFinite(to) || to <= 0) return null;
  return (to - from) / from;
}

function getHistoryWindow(history, currentSec, lookbackSec) {
  if (!Array.isArray(history) || !Number.isFinite(currentSec)) return [];
  const startSec = currentSec - lookbackSec;
  return history.filter(point => point.sec >= startSec && point.sec <= currentSec);
}

function calculateRecentRangeRatio(history, currentSec, spot) {
  const window = getHistoryWindow(history, currentSec, RECENT_VOL_LOOKBACK_SEC);
  if (window.length < 2 || !Number.isFinite(spot) || spot <= 0) return 0;
  const highs = window.map(point => point.spot);
  const high = Math.max(...highs);
  const low = Math.min(...highs);
  return Math.max(0, (high - low) / spot);
}

function median(values) {
  const sorted = values.filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function calculateStrikeSpacingRatio(strikes, spot) {
  if (!Array.isArray(strikes) || strikes.length < 2 || !Number.isFinite(spot) || spot <= 0) {
    return 0;
  }
  const sorted = [...new Set(strikes.map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
  const diffs = [];
  for (let i = 1; i < sorted.length; i++) {
    const diff = sorted[i] - sorted[i - 1];
    if (diff > 0) diffs.push(diff);
  }
  const spacing = median(diffs);
  return spacing ? spacing / spot : 0;
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function calculatePinBand(row, marketContext) {
  const spacingRatio = marketContext.strikeSpacingRatio || 0;
  const recentRangeRatio = marketContext.recentRangeRatio || 0;
  const spacingCap = spacingRatio > 0 ? spacingRatio * PIN_MAX_SPACING_FRACTION : 0.006;
  const minBand = spacingRatio > 0
    ? Math.min(PIN_MIN_PCT, spacingRatio * 0.25)
    : PIN_MIN_PCT;
  const baseBand = (recentRangeRatio * PIN_VOL_WEIGHT) + (spacingRatio * PIN_SPACING_WEIGHT);
  const strengthBoost = 0.85 + 0.3 * row.strength;
  return clamp(baseBand * strengthBoost, minBand, Math.max(minBand, spacingCap));
}

function calculateHoldBand(pinBand, marketContext) {
  const spacingRatio = marketContext.strikeSpacingRatio || 0;
  const holdCap = spacingRatio > 0
    ? spacingRatio * PIN_HOLD_MAX_SPACING_FRACTION
    : pinBand * PIN_HOLD_MULTIPLIER;
  return Math.min(pinBand * PIN_HOLD_MULTIPLIER, Math.max(pinBand, holdCap));
}

function buildMarketContext(summary = {}, spot, context = {}) {
  const history = normalizeHistory(context.history);
  const currentSec = Number.isFinite(Number(context.currentSec))
    ? Number(context.currentSec)
    : (history.length ? history[history.length - 1].sec : NaN);
  const strikes = Array.isArray(summary.strikes) ? summary.strikes : [];
  return {
    history,
    currentSec,
    recentRangeRatio: calculateRecentRangeRatio(history, currentSec, spot),
    strikeSpacingRatio: calculateStrikeSpacingRatio(strikes, spot)
  };
}

function calculateTrend(context = {}) {
  const history = normalizeHistory(context.history);
  const currentSpot = finite(context.spot, history.length ? history[history.length - 1].spot : NaN);
  const currentSec = Number.isFinite(Number(context.currentSec))
    ? Number(context.currentSec)
    : (history.length ? history[history.length - 1].sec : NaN);

  if (!Number.isFinite(currentSpot) || currentSpot <= 0 || !Number.isFinite(currentSec)) {
    return {
      direction: 'flat',
      label: '方向不足',
      pct5m: null,
      pct15m: null
    };
  }

  const point5m = findPointAtOrBefore(history, currentSec - 5 * 60) || history[0] || null;
  const point15m = findPointAtOrBefore(history, currentSec - 15 * 60) || history[0] || null;
  const pct5m = pctChange(point5m && point5m.spot, currentSpot);
  const pct15m = pctChange(point15m && point15m.spot, currentSpot);

  let direction = 'flat';
  if ((Number.isFinite(pct5m) && pct5m >= TREND_5M_THRESHOLD) ||
      (Number.isFinite(pct15m) && pct15m >= TREND_15M_THRESHOLD)) {
    direction = 'up';
  } else if ((Number.isFinite(pct5m) && pct5m <= -TREND_5M_THRESHOLD) ||
      (Number.isFinite(pct15m) && pct15m <= -TREND_15M_THRESHOLD)) {
    direction = 'down';
  }

  return {
    direction,
    label: direction === 'up' ? '偏上' : direction === 'down' ? '偏下' : '横盘',
    pct5m: pct5m === null ? null : round(pct5m * 100, 2),
    pct15m: pct15m === null ? null : round(pct15m * 100, 2)
  };
}

function getRealtimeGexValues(summary = {}) {
  if (Array.isArray(summary.strikeGexRealtime) && summary.strikeGexRealtime.length > 0) {
    return summary.strikeGexRealtime;
  }
  if (Array.isArray(summary.realtimeStrikeGexMillions)) {
    return summary.realtimeStrikeGexMillions.map(value => finite(value) * 1e6);
  }
  return [];
}

function buildRows(summary = {}, spot, marketContext = {}) {
  const strikes = Array.isArray(summary.strikes) ? summary.strikes : [];
  const gexValues = getRealtimeGexValues(summary);
  const rows = strikes
    .map((strike, index) => {
      const strikeValue = finite(strike, NaN);
      const gex = finite(gexValues[index], NaN);
      if (!Number.isFinite(strikeValue) || strikeValue <= 0 || !Number.isFinite(gex)) return null;
      const distanceRatio = (strikeValue - spot) / spot;
      return {
        strike: strikeValue,
        gex,
        absGex: Math.abs(gex),
        side: strikeValue > spot ? 'above' : 'below',
        distanceRatio,
        distancePct: distanceRatio * 100
      };
    })
    .filter(Boolean);

  const maxAbsGex = rows.reduce((max, row) => Math.max(max, row.absGex), 0);
  return rows
    .map(row => {
      const strength = maxAbsGex > 0 ? row.absGex / maxAbsGex : 0;
      const distanceWeight = 1 / (1 + Math.abs(row.distanceRatio) / DISTANCE_WEIGHT_PCT);
      const pinBand = calculatePinBand({ ...row, strength }, marketContext);
      const holdBand = calculateHoldBand(pinBand, marketContext);
      const side = Math.abs(row.distanceRatio) <= pinBand ? 'near' : row.side;
      return {
        ...row,
        side,
        strength,
        score: strength * distanceWeight,
        pinBand,
        holdBand
      };
    })
    .filter(row => row.strength >= MIN_NORMALIZED_STRENGTH)
    .sort((a, b) => b.score - a.score);
}

function pickBest(rows, predicate) {
  return rows.find(predicate) || null;
}

function isInPinBand(candidate) {
  return candidate && Math.abs(candidate.distanceRatio) <= candidate.pinBand;
}

function isInHoldBand(candidate) {
  return candidate && Math.abs(candidate.distanceRatio) <= candidate.holdBand;
}

function hasTargetSwitchConfirmation(candidate, marketContext) {
  if (!candidate || !Array.isArray(marketContext.history) || !Number.isFinite(marketContext.currentSec)) {
    return false;
  }
  const window = getHistoryWindow(marketContext.history, marketContext.currentSec, SWITCH_CONFIRM_SEC);
  if (window.length < 2) return false;
  const firstDistance = Math.abs(candidate.strike - window[0].spot);
  const lastDistance = Math.abs(candidate.strike - window[window.length - 1].spot);
  const closerCount = window.reduce((count, point, index) => {
    if (index === 0) return count;
    const prevDistance = Math.abs(candidate.strike - window[index - 1].spot);
    const distance = Math.abs(candidate.strike - point.spot);
    return distance <= prevDistance ? count + 1 : count;
  }, 0);
  return lastDistance < firstDistance && closerCount >= Math.max(1, window.length - 2);
}

function pickMagnetTarget(trend, pin, holdAnchor, upper, lower, marketContext) {
  if (trend.direction === 'down') {
    if (holdAnchor) return holdAnchor;
    if (pin) return pin;
    if (lower && hasTargetSwitchConfirmation(lower, marketContext)) return lower;
    return upper || lower;
  }

  if (trend.direction === 'up') {
    if (holdAnchor && holdAnchor.distanceRatio >= 0) return holdAnchor;
    if (pin && pin.distanceRatio >= 0) return pin;
    return upper || pin || lower;
  }

  if (holdAnchor) return holdAnchor;
  return upper || pin || lower;
}

function formatCandidate(candidate, role, reason) {
  if (!candidate) return null;
  return {
    role,
    strike: round(candidate.strike, 2),
    side: candidate.side,
    score: round(candidate.score, 3),
    strength: round(candidate.strength, 3),
    distancePct: round(candidate.distancePct, 2),
    pinBandPct: round(candidate.pinBand * 100, 2),
    holdBandPct: round(candidate.holdBand * 100, 2),
    gravity: round(candidate.gex),
    gravityMillions: round(candidate.gex / 1e6, 2),
    sign: candidate.gex > 0 ? 'positive' : candidate.gex < 0 ? 'negative' : 'neutral',
    reason
  };
}

function magnetReason(candidate, pin) {
  if (candidate && pin && candidate.strike === pin.strike) {
    return '价格仍在该强引力峰吸附带内，优先观察当前Pin的拉扯';
  }
  return candidate && candidate.side === 'above'
    ? '上方强引力区，当前优先观察的牵引目标'
    : '下方强引力区，价格回落时优先观察的牵引目标';
}

function buildGravityRoles(summary = {}, context = {}) {
  const spot = finite(context.spot, NaN);
  if (!Number.isFinite(spot) || spot <= 0) {
    return {
      trend: calculateTrend(context),
      structure: buildStructure(summary, spot, context),
      magnetTarget: null,
      supportPole: null,
      pin: null,
      upperMagnetTarget: null,
      lowerMagnetTarget: null
    };
  }

  const marketContext = buildMarketContext(summary, spot, context);
  const trend = calculateTrend({ ...context, spot });
  const structure = buildStructure(summary, spot, context);
  const rows = buildRows(summary, spot, marketContext);
  const inRoleRange = row => Math.abs(row.distanceRatio) <= ROLE_DISTANCE_PCT;
  const pin = pickBest(rows, row => isInPinBand(row));
  const holdAnchor = pickBest(rows, row => isInHoldBand(row) && row.strength >= ACTIVE_HOLD_MIN_STRENGTH);
  const upper = pickBest(rows, row => row.strike > spot && inRoleRange(row));
  const lower = pickBest(rows, row => row.strike < spot && inRoleRange(row));
  const magnet = pickMagnetTarget(trend, pin, holdAnchor, upper, lower, marketContext);
  const support = lower;

  return {
    trend: {
      ...trend,
      recentRangePct: round(marketContext.recentRangeRatio * 100, 2),
      strikeSpacingPct: round(marketContext.strikeSpacingRatio * 100, 2)
    },
    structure,
    magnetTarget: formatCandidate(
      magnet,
      'MAGNET_TARGET',
      magnetReason(magnet, pin)
    ),
    supportPole: formatCandidate(
      support,
      'SUPPORT_POLE',
      support && pin && support.strike === pin.strike
        ? '现价贴近或刚站上该强引力区，优先作为当前支撑锚'
        : '价格已站上该强引力区，下方回踩时优先观察支撑'
    ),
    pin: formatCandidate(
      pin,
      'PIN',
      '现价贴近强引力峰，容易出现吸附、停留或拉扯'
    ),
    upperMagnetTarget: formatCandidate(
      upper,
      'MAGNET_TARGET',
      '上方强引力区'
    ),
    lowerMagnetTarget: formatCandidate(
      lower,
      'MAGNET_TARGET',
      '下方强引力区'
    )
  };
}

module.exports = {
  buildGravityRoles,
  calculateTrend
};
