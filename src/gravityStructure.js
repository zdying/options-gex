/**
 * @file gravityStructure.js
 * @description Score the visual clarity of the current gravity curve without changing role selection.
 */

const STRUCTURE_RANGE_PCT = 0.03;
const STRUCTURE_DOMINANCE_CLEAR = 1.35;
const STRUCTURE_STRONG_PEAK_RATIO = 0.6;
const STRUCTURE_SIGNIFICANT_PEAK_RATIO = 0.2;
const STRUCTURE_MAX_STRONG_PEAKS = 3;
const STRUCTURE_MAX_SIGN_FLIPS = 1;
const STRUCTURE_CONFIRM_SEC = 5 * 60;

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

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
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

function buildStructureRows(summary = {}, spot) {
  const strikes = Array.isArray(summary.strikes) ? summary.strikes : [];
  const gexValues = getRealtimeGexValues(summary);
  if (!Number.isFinite(spot) || spot <= 0) return [];

  return strikes
    .map((strike, index) => {
      const strikeValue = finite(strike, NaN);
      const gex = finite(gexValues[index], NaN);
      if (!Number.isFinite(strikeValue) || strikeValue <= 0 || !Number.isFinite(gex) || gex === 0) {
        return null;
      }
      const distanceRatio = (strikeValue - spot) / spot;
      if (Math.abs(distanceRatio) > STRUCTURE_RANGE_PCT) return null;
      return {
        strike: strikeValue,
        gex,
        absGex: Math.abs(gex),
        distancePct: distanceRatio * 100
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.strike - b.strike);
}

function countSignFlips(rows, thresholdAbsGex) {
  let previousSign = 0;
  let flips = 0;
  rows.forEach(row => {
    if (row.absGex < thresholdAbsGex) return;
    const sign = row.gex > 0 ? 1 : row.gex < 0 ? -1 : 0;
    if (sign !== 0 && previousSign !== 0 && sign !== previousSign) flips += 1;
    if (sign !== 0) previousSign = sign;
  });
  return flips;
}

function classifyStructure({ isClear, dominance, strongPeakCount, signFlipCount }) {
  if (isClear) {
    return {
      type: 'CLEAR',
      label: '结构清晰',
      reason: '主峰较明显，强峰数量少，曲线方向较一致'
    };
  }
  if (signFlipCount > STRUCTURE_MAX_SIGN_FLIPS) {
    return {
      type: 'FRAGMENTED',
      label: '结构破碎',
      reason: '现价附近正负引力反复切换，方向不统一'
    };
  }
  if (strongPeakCount > STRUCTURE_MAX_STRONG_PEAKS) {
    return {
      type: 'RANGE_TUG',
      label: '区间拉扯',
      reason: '现价附近强峰较多，容易上下拉扯'
    };
  }
  if (dominance !== null && dominance < STRUCTURE_DOMINANCE_CLEAR) {
    return {
      type: 'WEAK_EDGE',
      label: '优势不明显',
      reason: '主峰相对第二峰优势不足'
    };
  }
  return {
    type: 'WEAK',
    label: '结构一般',
    reason: '图形结构有一定参考价值，但优势不够集中'
  };
}

function scoreStructure({ dominance, strongPeakCount, signFlipCount, clearMinutes }) {
  const dominanceScore = dominance === null
    ? 0
    : dominance >= STRUCTURE_DOMINANCE_CLEAR
      ? 35 + clamp((dominance - STRUCTURE_DOMINANCE_CLEAR) / 0.65, 0, 1) * 15
      : clamp((dominance - 1) / (STRUCTURE_DOMINANCE_CLEAR - 1), 0, 1) * 35;
  const peakScore = strongPeakCount <= 1
    ? 25
    : strongPeakCount === 2
      ? 22
      : strongPeakCount === 3
        ? 16
        : Math.max(0, 16 - (strongPeakCount - 3) * 8);
  const flipScore = signFlipCount === 0
    ? 20
    : signFlipCount === 1
      ? 12
      : Math.max(0, 12 - (signFlipCount - 1) * 8);
  const continuityScore = Number.isFinite(clearMinutes)
    ? clamp(clearMinutes / 5, 0, 1) * 10
    : 0;
  return round(clamp(dominanceScore + peakScore + flipScore + continuityScore, 0, 100), 0);
}

function analyzeStructureSnapshot(summary = {}, spot) {
  const rows = buildStructureRows(summary, spot);
  if (rows.length < 2) {
    return {
      available: false,
      isClear: false,
      score: 0,
      type: 'INSUFFICIENT',
      label: '结构不足',
      reason: '现价附近可用引力峰不足',
      rangePct: round(STRUCTURE_RANGE_PCT * 100, 2),
      dominance: null,
      strongPeakCount: rows.length,
      signFlipCount: 0,
      topPeak: null,
      secondPeak: null
    };
  }

  const sortedByStrength = [...rows].sort((a, b) => b.absGex - a.absGex);
  const topPeak = sortedByStrength[0];
  const secondPeak = sortedByStrength[1];
  const dominance = secondPeak && secondPeak.absGex > 0 ? topPeak.absGex / secondPeak.absGex : null;
  const strongPeakCount = rows.filter(row => row.absGex >= topPeak.absGex * STRUCTURE_STRONG_PEAK_RATIO).length;
  const signFlipCount = countSignFlips(rows, topPeak.absGex * STRUCTURE_SIGNIFICANT_PEAK_RATIO);
  const isClear = dominance !== null &&
    dominance >= STRUCTURE_DOMINANCE_CLEAR &&
    strongPeakCount <= STRUCTURE_MAX_STRONG_PEAKS &&
    signFlipCount <= STRUCTURE_MAX_SIGN_FLIPS;
  const classification = classifyStructure({ isClear, dominance, strongPeakCount, signFlipCount });

  return {
    available: true,
    isClear,
    ...classification,
    rangePct: round(STRUCTURE_RANGE_PCT * 100, 2),
    dominance: round(dominance, 2),
    strongPeakCount,
    signFlipCount,
    topPeak: {
      strike: round(topPeak.strike, 2),
      gravityMillions: round(topPeak.gex / 1e6, 2),
      distancePct: round(topPeak.distancePct, 2),
      sign: topPeak.gex > 0 ? 'positive' : 'negative'
    },
    secondPeak: {
      strike: round(secondPeak.strike, 2),
      gravityMillions: round(secondPeak.gex / 1e6, 2),
      distancePct: round(secondPeak.distancePct, 2),
      sign: secondPeak.gex > 0 ? 'positive' : 'negative'
    }
  };
}

function getHistorySourceForStructure(point, context = {}) {
  if (!point || !point.gexData) return null;
  const expiry = context.expiry || 'all';
  return point.gexData[expiry] || null;
}

function calculateClearMinutes(context = {}, currentSnapshot) {
  if (!currentSnapshot || !currentSnapshot.isClear || !Array.isArray(context.history)) return 0;
  const currentSec = Number(context.currentSec);
  if (!Number.isFinite(currentSec)) return 0;

  const history = context.history
    .filter(point => Number(point && point.sec) <= currentSec)
    .sort((a, b) => Number(b.sec) - Number(a.sec));
  let earliestSec = null;

  for (const point of history) {
    const source = getHistorySourceForStructure(point, context);
    const pointSpot = finite(point && point.spot, NaN);
    if (!source || !Number.isFinite(pointSpot) || pointSpot <= 0) break;
    const snapshot = analyzeStructureSnapshot(source, pointSpot);
    if (!snapshot.isClear) break;
    earliestSec = Number(point.sec);
  }

  if (!Number.isFinite(earliestSec)) return 0;
  return Math.max(1, Math.floor((currentSec - earliestSec) / 60) + 1);
}

function buildStructure(summary = {}, spot, context = {}) {
  const snapshot = analyzeStructureSnapshot(summary, spot);
  const clearMinutes = calculateClearMinutes(context, snapshot);
  return {
    ...snapshot,
    score: snapshot.available
      ? scoreStructure({
        dominance: snapshot.dominance,
        strongPeakCount: snapshot.strongPeakCount,
        signFlipCount: snapshot.signFlipCount,
        clearMinutes
      })
      : 0,
    clearMinutes,
    confirmed: clearMinutes >= STRUCTURE_CONFIRM_SEC / 60,
    rules: {
      rangePct: round(STRUCTURE_RANGE_PCT * 100, 2),
      dominanceClear: STRUCTURE_DOMINANCE_CLEAR,
      strongPeakRatio: STRUCTURE_STRONG_PEAK_RATIO,
      maxStrongPeaks: STRUCTURE_MAX_STRONG_PEAKS,
      maxSignFlips: STRUCTURE_MAX_SIGN_FLIPS,
      confirmMinutes: STRUCTURE_CONFIRM_SEC / 60
    }
  };
}

module.exports = {
  buildStructure
};
