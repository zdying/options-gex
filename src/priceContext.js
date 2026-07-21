/**
 * @file priceContext.js
 * @description Lightweight price context for gravity role selection.
 */

const STRUCTURE_LOOKBACK_SEC = 30 * 60;
const RANGE_LOOKBACK_SEC = 20 * 60;
const RANGE_BOX_LOOKBACK_SEC = 20 * 60;
const RANGE_BOX_MIN_POINTS = 8;
const RANGE_BOX_CONFIRM_POINTS = 3;
const RANGE_BOX_MAX_ATR_MULTIPLIER = 5;
const RANGE_BOX_TOUCH_FRACTION = 0.18;
const RANGE_BOX_MAX_TREND_RATIO = 0.72;
const RANGE_BOX_RELEVANT_HEIGHT_MULTIPLIER = 0.9;
const RANGE_BOX_STALE_SEC = 12 * 60;
const RANGE_BOX_BREAK_STALE_SEC = 9 * 60;
const RANGE_BOX_CONTINUATION_STALE_SEC = 7 * 60;
const PRICE_STATE_SMOOTH_LOOKBACK_POINTS = 5;
const PRICE_STATE_MIN_FAMILY_COUNT = 2;
const PRICE_STATE_HOLD_POINTS = 2;
const VWAP_SLOPE_LOOKBACK_SEC = 5 * 60;
const VWAP_REACTION_LOOKBACK_SEC = 5 * 60;
const EMA_FAST_PERIOD = 20;
const EMA_SLOW_PERIOD = 60;
const MA_SLOPE_LOOKBACK_SEC = 5 * 60;
const MA_NEAR_PCT = 0.0008;
const MA_TANGLE_PCT = 0.0015;
const MOMENTUM_PERIODS = [
  { key: 'pct3m', minutes: 3, threshold: 0.0008, weight: 0.3 },
  { key: 'pct5m', minutes: 5, threshold: 0.0012, weight: 0.35 },
  { key: 'pct10m', minutes: 10, threshold: 0.002, weight: 0.35 }
];
const MODULE_WEIGHTS = {
  marketState: 0.35,
  structure: 0.2,
  movingAverage: 0.2,
  vwap: 0.15,
  momentum: 0.1
};
const TOTAL_MODULE_WEIGHT = Object.values(MODULE_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
const PRICE_BUFFER_PCT = 0.0005;
const VWAP_NEAR_PCT = 0.0007;
const PIVOT_NEIGHBORS = 2;

function finite(value, fallback = NaN) {
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

function firstFinite(...values) {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return NaN;
}

function nested(point, key) {
  if (!point || typeof point !== 'object') return null;
  return point[key] && typeof point[key] === 'object' ? point[key] : null;
}

function readField(point, names) {
  const candle = nested(point, 'candle') || nested(point, 'ohlcv') || nested(point, 'bar') || {};
  const quote = nested(point, 'quote') || {};
  for (const name of names) {
    const value = firstFinite(point && point[name], candle[name], quote[name]);
    if (Number.isFinite(value)) return value;
  }
  return NaN;
}

function hasAnyField(point, names) {
  const candle = nested(point, 'candle') || nested(point, 'ohlcv') || nested(point, 'bar') || {};
  const quote = nested(point, 'quote') || {};
  return names.some(name => (
    point && point[name] !== undefined ||
    candle[name] !== undefined ||
    quote[name] !== undefined
  ));
}

function normalizePoint(point) {
  const sec = finite(point && point.sec, NaN);
  const close = firstFinite(
    readField(point, ['close', 'c']),
    point && point.spot,
    point && point.price,
    point && point.last
  );
  const open = firstFinite(readField(point, ['open', 'o']), close);
  const high = firstFinite(readField(point, ['high', 'h']), close);
  const low = firstFinite(readField(point, ['low', 'l']), close);
  const volume = firstFinite(readField(point, ['volume', 'v']), NaN);
  const vwap = firstFinite(readField(point, ['vwap', 'vw']), NaN);
  const hasOhlc = hasAnyField(point, ['open', 'o']) &&
    hasAnyField(point, ['high', 'h']) &&
    hasAnyField(point, ['low', 'l']) &&
    hasAnyField(point, ['close', 'c']);

  if (!Number.isFinite(sec) || !Number.isFinite(close) || close <= 0) {
    return null;
  }

  return {
    sec,
    open,
    high: Math.max(high, low, close),
    low: Math.min(high, low, close),
    close,
    volume,
    vwap,
    hasOhlc
  };
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .map(normalizePoint)
    .filter(Boolean)
    .sort((a, b) => a.sec - b.sec);
}

function buildSeries(context = {}) {
  const currentSec = Number.isFinite(Number(context.currentSec))
    ? Number(context.currentSec)
    : NaN;
  const currentSpot = finite(context.spot, NaN);
  const points = normalizeHistory(context.history);

  if (Number.isFinite(currentSec) && Number.isFinite(currentSpot) && currentSpot > 0) {
    const currentPoint = {
      sec: currentSec,
      open: currentSpot,
      high: currentSpot,
      low: currentSpot,
      close: currentSpot,
      volume: NaN,
      vwap: NaN,
      hasOhlc: false
    };
    const existingIndex = points.findIndex(point => point.sec === currentSec);
    if (existingIndex >= 0) {
      const merged = {
        ...currentPoint,
        ...points[existingIndex],
        close: currentSpot
      };
      points[existingIndex] = {
        ...merged,
        high: Math.max(merged.high, merged.low, merged.close),
        low: Math.min(merged.high, merged.low, merged.close)
      };
    } else {
      points.push(currentPoint);
    }
  }

  const bounded = Number.isFinite(currentSec)
    ? points.filter(point => point.sec <= currentSec)
    : points;

  return attachMovingAverages(attachComputedVwap(bounded.sort((a, b) => a.sec - b.sec)));
}

function attachComputedVwap(points) {
  let cumulativePriceVolume = 0;
  let cumulativeVolume = 0;

  return points.map(point => {
    const explicitVwap = finite(point.vwap, NaN);
    const volume = finite(point.volume, NaN);
    if (Number.isFinite(explicitVwap) && explicitVwap > 0) {
      if (Number.isFinite(volume) && volume > 0) {
        const typicalPrice = (point.high + point.low + point.close) / 3;
        cumulativePriceVolume += typicalPrice * volume;
        cumulativeVolume += volume;
      }
      return point;
    }
    if (!Number.isFinite(volume) || volume <= 0) {
      return point;
    }

    const typicalPrice = (point.high + point.low + point.close) / 3;
    cumulativePriceVolume += typicalPrice * volume;
    cumulativeVolume += volume;
    return {
      ...point,
      vwap: cumulativeVolume > 0 ? cumulativePriceVolume / cumulativeVolume : point.vwap
    };
  });
}

function attachMovingAverages(points) {
  let emaFast = null;
  let emaSlow = null;
  const fastK = 2 / (EMA_FAST_PERIOD + 1);
  const slowK = 2 / (EMA_SLOW_PERIOD + 1);

  return points.map((point, index) => {
    emaFast = emaFast === null ? point.close : point.close * fastK + emaFast * (1 - fastK);
    emaSlow = emaSlow === null ? point.close : point.close * slowK + emaSlow * (1 - slowK);
    return {
      ...point,
      ema20: emaFast,
      ema60: emaSlow,
      ema20Ready: index + 1 >= EMA_FAST_PERIOD,
      ema60Ready: index + 1 >= EMA_SLOW_PERIOD
    };
  });
}

function findPointAtOrBefore(points, sec) {
  let result = null;
  for (const point of points) {
    if (point.sec <= sec) result = point;
    if (point.sec > sec) break;
  }
  return result;
}

function pctChange(from, to) {
  if (!Number.isFinite(from) || from <= 0 || !Number.isFinite(to) || to <= 0) return null;
  return (to - from) / from;
}

function getWindow(points, currentSec, lookbackSec) {
  if (!Array.isArray(points) || !Number.isFinite(currentSec)) return [];
  const startSec = currentSec - lookbackSec;
  return points.filter(point => point.sec >= startSec && point.sec <= currentSec);
}

function median(values) {
  const sorted = values.filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function detectPivots(points) {
  const highs = [];
  const lows = [];
  if (!Array.isArray(points) || points.length < PIVOT_NEIGHBORS * 2 + 1) {
    return { highs, lows };
  }

  for (let i = PIVOT_NEIGHBORS; i < points.length - PIVOT_NEIGHBORS; i++) {
    const point = points[i];
    const left = points.slice(i - PIVOT_NEIGHBORS, i);
    const right = points.slice(i + 1, i + PIVOT_NEIGHBORS + 1);
    const surroundingHigh = Math.max(...left.concat(right).map(item => item.high));
    const surroundingLow = Math.min(...left.concat(right).map(item => item.low));

    if (point.high > surroundingHigh) {
      highs.push({ sec: point.sec, value: point.high });
    }
    if (point.low < surroundingLow) {
      lows.push({ sec: point.sec, value: point.low });
    }
  }

  return { highs, lows };
}

function compareSwings(highs, lows, spot) {
  const buffer = spot * PRICE_BUFFER_PCT;
  if (highs.length < 2 || lows.length < 2) {
    return {
      available: false,
      pattern: 'insufficient',
      score: 0,
      lastHigh: highs.length ? round(highs[highs.length - 1].value, 2) : null,
      lastLow: lows.length ? round(lows[lows.length - 1].value, 2) : null
    };
  }

  const previousHigh = highs[highs.length - 2];
  const lastHigh = highs[highs.length - 1];
  const previousLow = lows[lows.length - 2];
  const lastLow = lows[lows.length - 1];
  const higherHigh = lastHigh.value > previousHigh.value + buffer;
  const higherLow = lastLow.value > previousLow.value + buffer;
  const lowerHigh = lastHigh.value < previousHigh.value - buffer;
  const lowerLow = lastLow.value < previousLow.value - buffer;

  let pattern = 'mixed';
  let score = 0;
  if (higherHigh && higherLow) {
    pattern = 'HH_HL';
    score = 0.45;
  } else if (lowerHigh && lowerLow) {
    pattern = 'LH_LL';
    score = -0.45;
  } else if (higherLow && !lowerHigh) {
    pattern = 'higher_low';
    score = 0.18;
  } else if (lowerHigh && !higherLow) {
    pattern = 'lower_high';
    score = -0.18;
  }

  return {
    available: true,
    pattern,
    score,
    previousHigh: round(previousHigh.value, 2),
    lastHigh: round(lastHigh.value, 2),
    previousLow: round(previousLow.value, 2),
    lastLow: round(lastLow.value, 2)
  };
}

function analyzeRange(points, current) {
  const prior = points.filter(point => point.sec < current.sec);
  if (prior.length < 3) {
    return {
      available: false,
      status: 'insufficient',
      score: 0,
      high: null,
      low: null
    };
  }

  const high = Math.max(...prior.map(point => point.high));
  const low = Math.min(...prior.map(point => point.low));
  const range = high - low;
  const buffer = current.close * PRICE_BUFFER_PCT;
  const mid = (high + low) / 2;
  let status = 'inside';
  let score = 0;

  if (current.close > high + buffer) {
    status = 'breakout_up';
    score = 0.55;
  } else if (current.close < low - buffer) {
    status = 'breakout_down';
    score = -0.55;
  } else if (range > 0 && current.close >= mid + range * 0.2) {
    status = 'upper_half';
    score = 0.12;
  } else if (range > 0 && current.close <= mid - range * 0.2) {
    status = 'lower_half';
    score = -0.12;
  }

  return {
    available: true,
    status,
    score,
    high: round(high, 2),
    low: round(low, 2),
    mid: round(mid, 2)
  };
}

function structureReason(swing, range) {
  if (range.status === 'breakout_up') return '价格突破近端区间上沿';
  if (range.status === 'breakout_down') return '价格跌破近端区间下沿';
  if (swing.pattern === 'HH_HL') return '短线高点和低点同步抬高';
  if (swing.pattern === 'LH_LL') return '短线高点和低点同步降低';
  if (swing.pattern === 'higher_low') return '低点抬高但结构尚未完全走强';
  if (swing.pattern === 'lower_high') return '高点降低但结构尚未完全走弱';
  if (range.status === 'upper_half') return '价格处在近端区间上半部';
  if (range.status === 'lower_half') return '价格处在近端区间下半部';
  return '价格结构暂时偏拉扯';
}

function analyzeStructure(points, current) {
  const window = getWindow(points, current.sec, STRUCTURE_LOOKBACK_SEC);
  const rangeWindow = getWindow(points, current.sec, RANGE_LOOKBACK_SEC);
  const pivots = detectPivots(window);
  const swing = compareSwings(pivots.highs, pivots.lows, current.close);
  const range = analyzeRange(rangeWindow, current);
  const available = window.length >= 5 || range.available;

  if (!available) {
    return {
      available: false,
      score: 0,
      label: '结构不足',
      reason: '历史价格不足，无法判断HH/HL或区间突破',
      swing,
      range
    };
  }

  const score = clamp(swing.score + range.score, -1, 1);
  return {
    available: true,
    score: round(score, 3),
    label: score >= 0.22 ? '结构偏多' : score <= -0.22 ? '结构偏空' : '结构拉扯',
    reason: structureReason(swing, range),
    swing,
    range
  };
}

function analyzeCandle(points, current) {
  if (!current.hasOhlc) {
    return {
      available: false,
      score: 0,
      expanded: false,
      closeLocation: null,
      reason: '缺少OHLC，K线实体扩张暂不参与'
    };
  }

  const previousBodies = points
    .filter(point => point.sec < current.sec && point.hasOhlc)
    .slice(-10)
    .map(point => Math.abs(point.close - point.open) / point.close);
  const currentBody = Math.abs(current.close - current.open) / current.close;
  const medianBody = median(previousBodies);
  const range = current.high - current.low;
  const closeLocation = range > 0 ? (current.close - current.low) / range : 0.5;
  const expanded = medianBody !== null && currentBody >= medianBody * 1.35;
  let score = 0;

  if (expanded && current.close > current.open && closeLocation >= 0.65) {
    score = 0.25;
  } else if (expanded && current.close < current.open && closeLocation <= 0.35) {
    score = -0.25;
  } else if (closeLocation >= 0.75) {
    score = 0.1;
  } else if (closeLocation <= 0.25) {
    score = -0.1;
  }

  return {
    available: true,
    score,
    expanded,
    bodyPct: round(currentBody * 100, 3),
    medianBodyPct: round((medianBody || 0) * 100, 3),
    closeLocation: round(closeLocation, 2),
    reason: expanded ? '当前K线实体相对前序放大' : '当前K线实体未明显放大'
  };
}

function analyzeMomentum(points, current) {
  if (!Array.isArray(points) || points.length < 2) {
    return {
      available: false,
      score: 0,
      label: '动量不足',
      reason: '历史价格不足，无法计算3/5/10分钟动量',
      pct3m: null,
      pct5m: null,
      pct10m: null,
      candle: analyzeCandle(points || [], current)
    };
  }

  let weightedScore = 0;
  let totalWeight = 0;
  const values = {};

  MOMENTUM_PERIODS.forEach(period => {
    const prior = findPointAtOrBefore(points, current.sec - period.minutes * 60);
    const fallback = points[0] && points[0].sec < current.sec ? points[0] : null;
    const source = prior || fallback;
    const pct = pctChange(source && source.close, current.close);
    values[period.key] = pct === null ? null : round(pct * 100, 3);
    if (pct === null) return;
    weightedScore += clamp(pct / period.threshold, -1, 1) * period.weight;
    totalWeight += period.weight;
  });

  const candle = analyzeCandle(points, current);
  let score = totalWeight > 0 ? weightedScore / totalWeight : 0;
  if (candle.available) {
    score = clamp(score * 0.8 + candle.score * 0.2, -1, 1);
  }

  return {
    available: totalWeight > 0,
    score: round(score, 3),
    label: score >= 0.25 ? '动量偏多' : score <= -0.25 ? '动量偏空' : '动量中性',
    reason: score >= 0.25
      ? '短周期收益率偏正'
      : score <= -0.25
        ? '短周期收益率偏负'
        : '短周期收益率没有明显方向',
    ...values,
    candle
  };
}

function countLevelCrosses(points, levelKey) {
  let previousSign = 0;
  let crosses = 0;
  points.forEach(point => {
    const level = finite(point && point[levelKey], NaN);
    if (!Number.isFinite(level) || level <= 0) return;
    const diff = point.close - level;
    const sign = Math.abs(diff / point.close) <= MA_NEAR_PCT ? 0 : diff > 0 ? 1 : -1;
    if (sign !== 0 && previousSign !== 0 && sign !== previousSign) crosses += 1;
    if (sign !== 0) previousSign = sign;
  });
  return crosses;
}

function detectMaReaction(points, current, levelKey) {
  const level = finite(current && current[levelKey], NaN);
  if (!Number.isFinite(level) || level <= 0) return 'none';
  const recent = getWindow(points, current.sec, VWAP_REACTION_LOOKBACK_SEC);
  const touched = recent.some(point => {
    const pointLevel = finite(point && point[levelKey], NaN);
    if (!Number.isFinite(pointLevel) || pointLevel <= 0) return false;
    const band = pointLevel * MA_NEAR_PCT;
    return point.low <= pointLevel + band && point.high >= pointLevel - band;
  });
  if (!touched) return 'none';

  const prior = findPointAtOrBefore(points, current.sec - 3 * 60) || points[0] || null;
  const pct3m = pctChange(prior && prior.close, current.close);
  const name = levelKey === 'ema60' ? 'ema60' : 'ema20';
  if (current.close > level && Number.isFinite(pct3m) && pct3m > 0) return `${name}_bounce`;
  if (current.close < level && Number.isFinite(pct3m) && pct3m < 0) return `${name}_reject`;
  return 'none';
}

function analyzeMovingAverage(points, current) {
  const ema20 = finite(current && current.ema20, NaN);
  const ema60 = finite(current && current.ema60, NaN);
  if (!Number.isFinite(ema20) || !Number.isFinite(ema60) || points.length < 5) {
    return {
      available: false,
      score: 0,
      label: '均线不足',
      reason: '历史价格不足，EMA20/EMA60暂不参与',
      ema20: null,
      ema60: null,
      position: 'unavailable',
      alignment: 'unavailable',
      slope: 'unavailable',
      reaction: 'none',
      tangled: false
    };
  }

  const nearFast = Math.abs(current.close - ema20) / current.close <= MA_NEAR_PCT;
  const nearSlow = Math.abs(current.close - ema60) / current.close <= MA_NEAR_PCT;
  const position = nearFast || nearSlow
    ? 'near'
    : current.close > ema20 && current.close > ema60
      ? 'above_both'
      : current.close < ema20 && current.close < ema60
        ? 'below_both'
        : 'between';
  const alignment = Math.abs(ema20 - ema60) / current.close <= MA_TANGLE_PCT
    ? 'mixed'
    : ema20 > ema60 ? 'bullish' : 'bearish';
  const past = findPointAtOrBefore(points, current.sec - MA_SLOPE_LOOKBACK_SEC);
  const ema20SlopePct = pctChange(past && past.ema20, ema20);
  const ema60SlopePct = pctChange(past && past.ema60, ema60);
  const fastSlope = ema20SlopePct === null || Math.abs(ema20SlopePct) <= PRICE_BUFFER_PCT ? 'flat' : ema20SlopePct > 0 ? 'up' : 'down';
  const slowSlope = ema60SlopePct === null || Math.abs(ema60SlopePct) <= PRICE_BUFFER_PCT ? 'flat' : ema60SlopePct > 0 ? 'up' : 'down';
  const slope = fastSlope === slowSlope
    ? fastSlope
    : fastSlope === 'flat' ? slowSlope : slowSlope === 'flat' ? fastSlope : 'mixed';
  const recent = getWindow(points, current.sec, RANGE_BOX_LOOKBACK_SEC);
  const fastCrosses = countLevelCrosses(recent, 'ema20');
  const slowCrosses = countLevelCrosses(recent, 'ema60');
  const tangled = alignment === 'mixed' ||
    (fastCrosses >= 3 && slowCrosses >= 2) ||
    (Math.abs(ema20 - ema60) / current.close <= MA_TANGLE_PCT && slope === 'flat');
  const fastReaction = detectMaReaction(points, current, 'ema20');
  const slowReaction = detectMaReaction(points, current, 'ema60');
  const reaction = fastReaction !== 'none' ? fastReaction : slowReaction;

  let score = 0;
  if (position === 'above_both') score += 0.35;
  if (position === 'below_both') score -= 0.35;
  if (alignment === 'bullish') score += 0.25;
  if (alignment === 'bearish') score -= 0.25;
  if (slope === 'up') score += 0.2;
  if (slope === 'down') score -= 0.2;
  if (reaction.endsWith('_bounce')) score += 0.2;
  if (reaction.endsWith('_reject')) score -= 0.2;
  if (tangled) score *= 0.35;
  score = clamp(score, -1, 1);

  return {
    available: true,
    score: round(score, 3),
    label: score >= 0.25 ? '均线偏多' : score <= -0.25 ? '均线偏空' : '均线拉扯',
    reason: movingAverageReason(position, alignment, slope, reaction, tangled),
    ema20: round(ema20, 2),
    ema60: round(ema60, 2),
    ema20SlopePct: ema20SlopePct === null ? null : round(ema20SlopePct * 100, 3),
    ema60SlopePct: ema60SlopePct === null ? null : round(ema60SlopePct * 100, 3),
    position,
    alignment,
    slope,
    reaction,
    tangled,
    fastCrosses,
    slowCrosses
  };
}

function movingAverageReason(position, alignment, slope, reaction, tangled) {
  if (reaction === 'ema20_bounce') return '价格回踩EMA20后重新走强';
  if (reaction === 'ema60_bounce') return '价格回踩EMA60后重新走强';
  if (reaction === 'ema20_reject') return '价格反抽EMA20后再次转弱';
  if (reaction === 'ema60_reject') return '价格反抽EMA60后再次转弱';
  if (tangled) return 'EMA20/EMA60缠绕，价格处在均线拉扯区';
  if (position === 'above_both' && alignment === 'bullish' && slope === 'up') return '价格在EMA20/EMA60上方，均线多头排列且上行';
  if (position === 'below_both' && alignment === 'bearish' && slope === 'down') return '价格在EMA20/EMA60下方，均线空头排列且下行';
  if (position === 'above_both') return '价格站在EMA20/EMA60上方';
  if (position === 'below_both') return '价格压在EMA20/EMA60下方';
  return '价格位于EMA20/EMA60之间，方向优势不明显';
}

function analyzeVwap(points, current) {
  const currentVwap = finite(current && current.vwap, NaN);
  if (!Number.isFinite(currentVwap) || currentVwap <= 0) {
    return {
      available: false,
      score: 0,
      label: 'VWAP不可用',
      reason: '缺少VWAP或成交量，VWAP状态暂不参与',
      value: null,
      position: 'unavailable',
      slope: 'unavailable',
      distancePct: null,
      reaction: 'unavailable'
    };
  }

  const distanceRatio = (current.close - currentVwap) / current.close;
  const position = Math.abs(distanceRatio) <= VWAP_NEAR_PCT
    ? 'near'
    : distanceRatio > 0 ? 'above' : 'below';
  const past = findPointAtOrBefore(points.filter(point => Number.isFinite(point.vwap)), current.sec - VWAP_SLOPE_LOOKBACK_SEC);
  const slopePct = pctChange(past && past.vwap, currentVwap);
  const slope = slopePct === null || Math.abs(slopePct) <= PRICE_BUFFER_PCT
    ? 'flat'
    : slopePct > 0 ? 'up' : 'down';
  const recent = getWindow(points, current.sec, VWAP_REACTION_LOOKBACK_SEC)
    .filter(point => Number.isFinite(point.vwap) && point.vwap > 0);
  const touched = recent.some(point => {
    const band = point.vwap * VWAP_NEAR_PCT;
    return point.low <= point.vwap + band && point.high >= point.vwap - band;
  });
  const pct3m = pctChange((findPointAtOrBefore(points, current.sec - 3 * 60) || points[0] || {}).close, current.close);
  let reaction = 'none';
  if (position === 'above' && touched && Number.isFinite(pct3m) && pct3m > 0) {
    reaction = 'support_bounce';
  } else if (position === 'below' && touched && Number.isFinite(pct3m) && pct3m < 0) {
    reaction = 'resistance_reject';
  }

  let score = 0;
  if (position === 'above') score += 0.45;
  if (position === 'below') score -= 0.45;
  if (slope === 'up') score += 0.25;
  if (slope === 'down') score -= 0.25;
  if (reaction === 'support_bounce') score += 0.3;
  if (reaction === 'resistance_reject') score -= 0.3;
  score = clamp(score, -1, 1);

  return {
    available: true,
    score: round(score, 3),
    label: score >= 0.25 ? 'VWAP偏多' : score <= -0.25 ? 'VWAP偏空' : 'VWAP中性',
    reason: vwapReason(position, slope, reaction),
    value: round(currentVwap, 2),
    position,
    slope,
    slopePct: slopePct === null ? null : round(slopePct * 100, 3),
    distancePct: round(distanceRatio * 100, 3),
    reaction
  };
}

function vwapReason(position, slope, reaction) {
  if (reaction === 'support_bounce') return '价格回踩VWAP后重新站上';
  if (reaction === 'resistance_reject') return '价格反抽VWAP后再次转弱';
  if (position === 'above' && slope === 'up') return '价格位于VWAP上方且VWAP上行';
  if (position === 'below' && slope === 'down') return '价格位于VWAP下方且VWAP下行';
  if (position === 'above') return '价格位于VWAP上方';
  if (position === 'below') return '价格位于VWAP下方';
  return '价格贴近VWAP，方向优势不明显';
}

function medianRangePct(points) {
  return median((points || []).map(point => {
    if (!point || !Number.isFinite(point.close) || point.close <= 0) return NaN;
    return Math.max(0, point.high - point.low) / point.close;
  }));
}

function countMidCrosses(points, mid) {
  let previousSign = 0;
  let crosses = 0;
  points.forEach(point => {
    const diff = point.close - mid;
    const sign = diff > 0 ? 1 : diff < 0 ? -1 : 0;
    if (sign !== 0 && previousSign !== 0 && sign !== previousSign) crosses += 1;
    if (sign !== 0) previousSign = sign;
  });
  return crosses;
}

function countBoxTouches(window, high, low, height) {
  const band = Math.max(height * RANGE_BOX_TOUCH_FRACTION, (window[0] && window[0].close || high) * PRICE_BUFFER_PCT);
  return window.reduce((result, point) => {
    if (point.high >= high - band || point.close >= high - band) result.upperTouches += 1;
    if (point.low <= low + band || point.close <= low + band) result.lowerTouches += 1;
    return result;
  }, { upperTouches: 0, lowerTouches: 0 });
}

function buildRangeBoxCandidate(window, current, maxHeightPct) {
  if (!Array.isArray(window) || window.length < RANGE_BOX_MIN_POINTS) return null;
  const closeHigh = Math.max(...window.map(point => point.close));
  const closeLow = Math.min(...window.map(point => point.close));
  const wickHigh = Math.max(...window.map(point => point.high));
  const wickLow = Math.min(...window.map(point => point.low));
  const height = closeHigh - closeLow;
  const heightPct = height / current.close;
  if (!Number.isFinite(heightPct) || heightPct <= 0 || heightPct > maxHeightPct) return null;

  const first = window[0];
  const last = window[window.length - 1];
  const netMovePct = Math.abs(last.close - first.close) / current.close;
  const trendRatio = heightPct > 0 ? netMovePct / heightPct : 1;
  if (trendRatio > RANGE_BOX_MAX_TREND_RATIO) return null;

  const mid = (closeHigh + closeLow) / 2;
  const midCrosses = countMidCrosses(window, mid);
  const aboveMidCount = window.filter(point => point.close > mid).length;
  const belowMidCount = window.filter(point => point.close < mid).length;
  const balanced = aboveMidCount >= 2 && belowMidCount >= 2;
  const touchStats = countBoxTouches(window, closeHigh, closeLow, height);
  const minTouches = window.length >= 12 ? 2 : 1;
  if (touchStats.upperTouches < minTouches || touchStats.lowerTouches < minTouches) return null;
  if ((!balanced && midCrosses === 0) || (window.length >= 12 && midCrosses === 0)) return null;

  const quality = clamp(
    1 -
    heightPct / maxHeightPct * 0.45 -
    trendRatio * 0.3 +
    Math.min(midCrosses, 3) * 0.08 +
    (balanced ? 0.12 : 0) +
    Math.min(touchStats.upperTouches + touchStats.lowerTouches, 6) * 0.025,
    0,
    1
  );

  return {
    available: true,
    high: round(closeHigh, 2),
    low: round(closeLow, 2),
    wickHigh: round(wickHigh, 2),
    wickLow: round(wickLow, 2),
    mid: round(mid, 2),
    heightPct: round(heightPct * 100, 3),
    durationMinutes: window.length,
    startSec: first.sec,
    endSec: last.sec,
    startClose: round(first.close, 2),
    endClose: round(last.close, 2),
    midCrosses,
    ...touchStats,
    trendRatio: round(trendRatio, 2),
    quality: round(quality, 3)
  };
}

function findRangeBox(points, current, excludeRecent = 0) {
  const prior = points.filter(point => point.sec < current.sec);
  const usable = excludeRecent > 0 ? prior.slice(0, Math.max(0, prior.length - excludeRecent)) : prior;
  if (usable.length < RANGE_BOX_MIN_POINTS) return null;

  const recentForAtr = usable.slice(-30);
  const atrPct = medianRangePct(recentForAtr) || PRICE_BUFFER_PCT * 2;
  const maxHeightPct = clamp(atrPct * RANGE_BOX_MAX_ATR_MULTIPLIER, 0.0016, 0.006);
  const lengths = [8, 10, 12, 15, 18, 20].filter(length => usable.length >= length);
  const candidates = lengths
    .map(length => buildRangeBoxCandidate(usable.slice(-length), current, maxHeightPct))
    .filter(Boolean);
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => (
    b.durationMinutes - a.durationMinutes ||
    b.quality - a.quality ||
    a.heightPct - b.heightPct
  ))[0];
}

function rangeBoxPosition(points, current, box) {
  if (!box) return 'unknown';
  const window = getWindow(points, current.sec, STRUCTURE_LOOKBACK_SEC);
  if (window.length < 5) return 'middle';
  const high = Math.max(...window.map(point => point.high));
  const low = Math.min(...window.map(point => point.low));
  const span = high - low;
  if (span <= 0) return 'middle';
  const boxMid = Number(box.mid);
  const location = (boxMid - low) / span;
  if (location >= 0.65) return 'high';
  if (location <= 0.35) return 'low';
  return 'middle';
}

function rangeLocation(close, box) {
  const high = Number(box && box.high);
  const low = Number(box && box.low);
  const span = high - low;
  if (!Number.isFinite(span) || span <= 0) return 'inside';
  const location = (close - low) / span;
  if (location >= 0.7) return 'near_upper';
  if (location <= 0.3) return 'near_lower';
  return 'middle';
}

function recentBreakCount(points, box, direction, buffer) {
  const recent = points.slice(-RANGE_BOX_CONFIRM_POINTS);
  const high = Number(box.high);
  const low = Number(box.low);
  return recent.reduce((count, point) => {
    if (direction === 'up' && point.close > high + buffer) return count + 1;
    if (direction === 'down' && point.close < low - buffer) return count + 1;
    return count;
  }, 0);
}

function closeLocation(point) {
  const range = point.high - point.low;
  return range > 0 ? (point.close - point.low) / range : 0.5;
}

function breakoutModuleSupport(direction, context = {}) {
  const modules = [
    context.movingAverage,
    context.vwap,
    context.momentum
  ].filter(module => module && module.available && Number.isFinite(Number(module.score)));
  const sign = direction === 'up' ? 1 : -1;
  let supportCount = 0;
  let opposeCount = 0;

  modules.forEach(module => {
    const score = Number(module.score) * sign;
    if (score >= 0.22) supportCount += 1;
    if (score <= -0.28) opposeCount += 1;
  });

  return {
    supportCount,
    opposeCount,
    supported: supportCount >= 2 || (supportCount >= 1 && opposeCount === 0),
    opposed: opposeCount >= 2 || (opposeCount >= 1 && supportCount === 0)
  };
}

function hasEffectiveBreak(point, box, direction, buffer) {
  const high = Number(box.high);
  const low = Number(box.low);
  const height = high - low;
  const location = closeLocation(point);
  if (direction === 'up') {
    const distance = point.close - high;
    return point.close > high + buffer &&
      (distance >= height * 0.12 || location >= 0.56);
  }
  const distance = low - point.close;
  return point.close < low - buffer &&
    (distance >= height * 0.12 || location <= 0.44);
}

function recentEffectiveBreakCount(points, box, direction, buffer) {
  return points.slice(-RANGE_BOX_CONFIRM_POINTS).reduce((count, point) => (
    hasEffectiveBreak(point, box, direction, buffer) ? count + 1 : count
  ), 0);
}

function isStrongBreak(current, box, direction) {
  const high = Number(box.high);
  const low = Number(box.low);
  const height = high - low;
  if (!Number.isFinite(height) || height <= 0) return false;
  return direction === 'up'
    ? current.close - high >= height * 0.25
    : low - current.close >= height * 0.25;
}

function breakRetainedRatio(points, current, box, direction) {
  const high = Number(box.high);
  const low = Number(box.low);
  const afterBreak = points.filter(point => point.sec > Number(box.endSec) && point.sec <= current.sec);
  if (afterBreak.length === 0) return null;

  if (direction === 'up') {
    const bestClose = Math.max(...afterBreak.map(point => point.close));
    const maxDistance = bestClose - high;
    const currentDistance = current.close - high;
    if (!Number.isFinite(maxDistance) || maxDistance <= 0) return null;
    return round(clamp(currentDistance / maxDistance, 0, 1), 3);
  }

  const bestClose = Math.min(...afterBreak.map(point => point.close));
  const maxDistance = low - bestClose;
  const currentDistance = low - current.close;
  if (!Number.isFinite(maxDistance) || maxDistance <= 0) return null;
  return round(clamp(currentDistance / maxDistance, 0, 1), 3);
}

function isBoxRelevantToCurrent(box, current) {
  const high = Number(box && box.high);
  const low = Number(box && box.low);
  const height = high - low;
  if (!Number.isFinite(height) || height <= 0) return false;
  const extension = Math.max(height * RANGE_BOX_RELEVANT_HEIGHT_MULTIPLIER, current.close * 0.0009);
  return current.close >= low - extension && current.close <= high + extension;
}

function rangeBoxAgeSec(box, current) {
  const endSec = Number(box && box.endSec);
  if (!Number.isFinite(endSec) || !Number.isFinite(current && current.sec)) return Infinity;
  return current.sec - endSec;
}

function isFreshRangeBox(box, current, maxAgeSec = RANGE_BOX_STALE_SEC) {
  const ageSec = rangeBoxAgeSec(box, current);
  return ageSec >= 0 && ageSec <= maxAgeSec;
}

function findPersistentRangeBox(points, current) {
  const offsets = [3, 5, 8, 10, 12];
  const boxes = offsets
    .map(offset => findRangeBox(points, current, offset))
    .filter(box => box && isFreshRangeBox(box, current) && isBoxRelevantToCurrent(box, current));
  if (boxes.length === 0) return null;

  return boxes.sort((a, b) => (
    b.endSec - a.endSec ||
    b.durationMinutes - a.durationMinutes ||
    b.quality - a.quality
  ))[0];
}

function buildAvailableRangeState(points, current, box, context) {
  if (!box) return null;
  return {
    available: true,
    ...buildRangeState(points, current, box, context)
  };
}

function isRangeStateFresh(state, current) {
  if (!state || !state.box) return false;
  const type = String(state.type || '');
  if (!isFreshRangeBox(state.box, current)) return false;
  if (type.includes('_continuation')) {
    return isFreshRangeBox(state.box, current, RANGE_BOX_CONTINUATION_STALE_SEC);
  }
  if (
    type.includes('_attempt') ||
    type.includes('_confirmed') ||
    type.includes('_retest') ||
    type.endsWith('_failed')
  ) {
    return isFreshRangeBox(state.box, current, RANGE_BOX_BREAK_STALE_SEC);
  }
  return true;
}

function shouldPreferImmediateRangeState(state, current) {
  if (!state || !isRangeStateFresh(state, current)) return false;
  const type = String(state.type || '');
  return type === 'range_rotation' ||
    type.endsWith('_failed') ||
    type.includes('_attempt');
}

function shouldPreferBreakState(state, current) {
  if (!state || !isRangeStateFresh(state, current)) return false;
  const type = String(state.type || '');
  return type.includes('_confirmed') ||
    type.includes('_retest') ||
    type.includes('_continuation') ||
    type.endsWith('_failed');
}

function getBreakStateKind(points, current, box, direction, buffer, context) {
  const recentWithCurrent = points.filter(point => point.sec <= current.sec);
  const rawCount = recentBreakCount(recentWithCurrent, box, direction, buffer);
  const effectiveCount = recentEffectiveBreakCount(recentWithCurrent, box, direction, buffer);
  const support = breakoutModuleSupport(direction, context);
  const strongBreak = isStrongBreak(current, box, direction);
  const retainedRatio = breakRetainedRatio(recentWithCurrent, current, box, direction);
  const retainedEnough = retainedRatio === null || retainedRatio >= 0.45;
  const confirmed = effectiveCount >= 3 ||
    (effectiveCount >= 2 && !support.opposed && (support.supported || strongBreak));
  const effectiveConfirmed = confirmed && retainedEnough;
  const continuation = effectiveConfirmed &&
    rawCount >= 3 &&
    strongBreak &&
    support.supportCount >= 1 &&
    (retainedRatio === null || retainedRatio >= 0.58);
  const retest = effectiveConfirmed && !strongBreak && (
    direction === 'up'
      ? current.low <= Number(box.high) + buffer * 1.5
      : current.high >= Number(box.low) - buffer * 1.5
  );

  return {
    rawCount,
    effectiveCount,
    support,
    strongBreak,
    retainedRatio,
    confirmed: effectiveConfirmed,
    continuation,
    retest
  };
}

function buildRangeState(points, current, box, context = {}) {
  const high = Number(box.high);
  const low = Number(box.low);
  const mid = Number(box.mid);
  const buffer = Math.max(current.close * PRICE_BUFFER_PCT, (high - low) * 0.08);
  const above = current.close > high + buffer;
  const below = current.close < low - buffer;
  const recentWithCurrent = points.filter(point => point.sec <= current.sec);
  const area = rangeBoxPosition(points, current, box);
  const location = rangeLocation(current.close, box);
  const boxLabel = area === 'high' ? '高位横盘' : area === 'low' ? '低位横盘' : '中位横盘';

  if (above) {
    const kind = getBreakStateKind(points, current, box, 'up', buffer, context);
    const type = kind.continuation
      ? 'range_breakout_up_continuation'
      : kind.retest
        ? 'range_breakout_up_retest'
        : kind.confirmed ? 'range_breakout_up_confirmed' : 'range_breakout_up_attempt';
    const label = kind.continuation
      ? '上破后延续'
      : kind.retest
        ? '上破后回踩'
        : kind.confirmed ? '箱体上破确认' : '箱体上破尝试';
    return {
      type,
      label,
      direction: 'up',
      score: kind.continuation ? 0.78 : kind.confirmed ? 0.66 : 0.42,
      reason: kind.continuation
        ? `价格站稳箱体上沿${round(high, 2)}后继续向上释放`
        : kind.retest
          ? `价格上破后回踩箱体上沿${round(high, 2)}附近`
          : kind.confirmed
            ? `价格有效站在箱体上沿${round(high, 2)}上方`
        : `价格正在尝试突破箱体上沿${round(high, 2)}`,
      keyLevel: round(high, 2),
      invalidation: `跌回箱体上沿${round(high, 2)}下方`,
      box,
      boxPosition: area,
      rangeLocation: 'above',
      breakStats: kind
    };
  }

  if (below) {
    const kind = getBreakStateKind(points, current, box, 'down', buffer, context);
    const type = kind.continuation
      ? 'range_breakdown_down_continuation'
      : kind.retest
        ? 'range_breakdown_down_retest'
        : kind.confirmed ? 'range_breakdown_down_confirmed' : 'range_breakdown_down_attempt';
    const label = kind.continuation
      ? '下破后延续'
      : kind.retest
        ? '下破后反抽'
        : kind.confirmed ? '箱体下破确认' : '箱体下破尝试';
    return {
      type,
      label,
      direction: 'down',
      score: kind.continuation ? -0.78 : kind.confirmed ? -0.66 : -0.42,
      reason: kind.continuation
        ? `价格跌破箱体下沿${round(low, 2)}后继续向下释放`
        : kind.retest
          ? `价格下破后反抽箱体下沿${round(low, 2)}附近`
          : kind.confirmed
            ? `价格有效压在箱体下沿${round(low, 2)}下方`
            : `价格正在尝试跌破箱体下沿${round(low, 2)}`,
      keyLevel: round(low, 2),
      invalidation: `重新收回箱体下沿${round(low, 2)}上方`,
      box,
      boxPosition: area,
      rangeLocation: 'below',
      breakStats: kind
    };
  }

  const recentBefore = recentWithCurrent.slice(-4, -1);
  const hadUpBreak = recentBefore.some(point => point.close > high + buffer);
  const hadDownBreak = recentBefore.some(point => point.close < low - buffer);
  if (hadUpBreak) {
    return {
      type: 'range_breakout_up_failed',
      label: '向上突破失败',
      direction: 'down',
      score: -0.38,
      reason: `价格突破箱体上沿${round(high, 2)}后又跌回箱体内`,
      keyLevel: round(high, 2),
      invalidation: `重新站上箱体上沿${round(high, 2)}`,
      box,
      boxPosition: area,
      rangeLocation: location
    };
  }
  if (hadDownBreak) {
    return {
      type: 'range_breakdown_down_failed',
      label: '向下跌破失败',
      direction: 'up',
      score: 0.38,
      reason: `价格跌破箱体下沿${round(low, 2)}后又收回箱体内`,
      keyLevel: round(low, 2),
      invalidation: `重新跌破箱体下沿${round(low, 2)}`,
      box,
      boxPosition: area,
      rangeLocation: location
    };
  }

  const score = location === 'near_upper' ? 0.08 : location === 'near_lower' ? -0.08 : 0;
  return {
    type: 'range_rotation',
    label: boxLabel,
    direction: 'flat',
    score,
    reason: `${boxLabel}，价格仍在${round(low, 2)}-${round(high, 2)}箱体内运行`,
    keyLevel: location === 'near_upper' ? round(high, 2) : location === 'near_lower' ? round(low, 2) : round(mid, 2),
    invalidation: `突破${round(high, 2)}或跌破${round(low, 2)}后重新评估`,
    box,
    boxPosition: area,
    rangeLocation: location
  };
}

function fallbackMarketState(points, current, structure, movingAverage, momentum) {
  const prior5m = findPointAtOrBefore(points, current.sec - 5 * 60) || points[0] || null;
  const pct5m = pctChange(prior5m && prior5m.close, current.close);
  const maScore = movingAverage && movingAverage.available ? movingAverage.score : 0;
  const structureScore = structure && structure.available ? structure.score : 0;
  const momentumScore = momentum && momentum.available ? momentum.score : 0;
  const combined = clamp(maScore * 0.45 + structureScore * 0.35 + momentumScore * 0.2, -1, 1);

  if ((combined >= 0.35 && Number(pct5m) >= -0.001) || (Number(pct5m) > 0.003 && momentumScore > 0)) {
    return {
      available: true,
      type: 'trend_up',
      label: '上涨段',
      direction: 'up',
      score: Math.max(0.42, combined),
      reason: '价格结构、均线或动量共同偏上',
      keyLevel: structure && structure.range ? structure.range.low : null,
      invalidation: structure && structure.range && structure.range.low !== null
        ? `跌破近端低点${structure.range.low}`
        : '跌破最近回踩低点',
      box: null,
      boxPosition: 'none',
      rangeLocation: 'none'
    };
  }

  if ((combined <= -0.35 && Number(pct5m) <= 0.001) || (Number(pct5m) < -0.003 && momentumScore < 0)) {
    return {
      available: true,
      type: 'trend_down',
      label: '下跌段',
      direction: 'down',
      score: Math.min(-0.42, combined),
      reason: '价格结构、均线或动量共同偏下',
      keyLevel: structure && structure.range ? structure.range.high : null,
      invalidation: structure && structure.range && structure.range.high !== null
        ? `突破近端高点${structure.range.high}`
        : '突破最近反抽高点',
      box: null,
      boxPosition: 'none',
      rangeLocation: 'none'
    };
  }

  return {
    available: true,
    type: 'range_tug',
    label: '拉扯观察',
    direction: 'flat',
    score: clamp(combined * 0.35, -0.12, 0.12),
    reason: '价格没有形成清晰趋势或有效箱体，先按拉扯处理',
    keyLevel: structure && structure.range ? structure.range.mid : null,
    invalidation: structure && structure.range && structure.range.high !== null && structure.range.low !== null
      ? `突破${structure.range.high}或跌破${structure.range.low}后重新评估`
      : '等待价格结构给出新方向',
    box: null,
    boxPosition: 'none',
    rangeLocation: 'none'
  };
}

function analyzeMarketState(points, current, structure, movingAverage, vwap, momentum) {
  const context = { movingAverage, vwap, momentum };
  const box = findRangeBox(points, current, 0);
  const currentState = buildAvailableRangeState(points, current, box, context);
  if (shouldPreferImmediateRangeState(currentState, current)) {
    return currentState;
  }

  const earlierBox = findRangeBox(points, current, RANGE_BOX_CONFIRM_POINTS);
  const earlierState = buildAvailableRangeState(points, current, earlierBox, context);
  if (shouldPreferBreakState(earlierState, current)) {
    return earlierState;
  }

  if (currentState && isRangeStateFresh(currentState, current)) {
    return currentState;
  }

  const persistentBox = findPersistentRangeBox(points, current);
  const persistentState = buildAvailableRangeState(points, current, persistentBox, context);
  if (shouldPreferBreakState(persistentState, current) || shouldPreferImmediateRangeState(persistentState, current)) {
    return persistentState;
  }

  return fallbackMarketState(points, current, structure, movingAverage, momentum);
}

function analyzeRawPriceModules(points, current) {
  const structure = analyzeStructure(points, current);
  const movingAverage = analyzeMovingAverage(points, current);
  const vwap = analyzeVwap(points, current);
  const momentum = analyzeMomentum(points, current);
  const marketState = analyzeMarketState(points, current, structure, movingAverage, vwap, momentum);
  return {
    marketState,
    structure,
    movingAverage,
    vwap,
    momentum
  };
}

function stateFamily(state) {
  const type = String(state && state.type || '');
  if (type === 'range_rotation') return 'range_rotation';
  if (type === 'range_tug') return 'range_tug';
  if (type === 'trend_up') return 'trend_up';
  if (type === 'trend_down') return 'trend_down';
  if (type === 'range_breakout_up_failed') return 'range_breakout_up_failed';
  if (type === 'range_breakdown_down_failed') return 'range_breakdown_down_failed';
  if (type.startsWith('range_breakout_up')) return 'range_breakout_up';
  if (type.startsWith('range_breakdown_down')) return 'range_breakdown_down';
  return type || 'unknown';
}

function isFailedState(state) {
  return String(state && state.type || '').endsWith('_failed');
}

function isDecisiveState(state) {
  const type = String(state && state.type || '');
  const score = Math.abs(Number(state && state.score));
  if (isFailedState(state)) return true;
  if (type.includes('_continuation')) return true;
  if (type.includes('_confirmed')) return true;
  if (type.includes('_retest')) return true;
  if (type.includes('_attempt')) {
    const breakStats = state && state.breakStats;
    return Boolean(
      breakStats &&
      breakStats.strongBreak &&
      breakStats.support &&
      breakStats.support.supportCount >= 1
    );
  }
  return (type === 'trend_up' || type === 'trend_down') && score >= 0.62;
}

function countRecentFamily(rawStates, family, lookback = 3) {
  return rawStates
    .slice(-lookback)
    .reduce((count, item) => stateFamily(item && item.state) === family ? count + 1 : count, 0);
}

function trailingFamilyRun(rawStates, family) {
  let count = 0;
  for (let i = rawStates.length - 1; i >= 0; i--) {
    if (stateFamily(rawStates[i] && rawStates[i].state) !== family) break;
    count += 1;
  }
  return count;
}

function findHoldCandidate(rawStates, currentFamily) {
  const prior = rawStates.slice(0, -1);
  for (let i = prior.length - 1; i >= 0; i--) {
    const candidate = prior[i] && prior[i].state;
    if (!candidate || isFailedState(candidate)) continue;
    const family = stateFamily(candidate);
    if (family === currentFamily) continue;
    const run = trailingFamilyRun(prior.slice(0, i + 1), family);
    if (run >= PRICE_STATE_HOLD_POINTS) return { state: candidate, family, run };
  }
  return null;
}

function dominantRangeState(rawStates) {
  const counts = new Map();
  rawStates.forEach((item, index) => {
    const state = item && item.state;
    if (!state || state.type !== 'range_rotation' || !state.label) return;
    const current = counts.get(state.label) || {
      label: state.label,
      boxPosition: state.boxPosition,
      count: 0,
      lastIndex: -1
    };
    current.count += 1;
    current.lastIndex = index;
    current.boxPosition = state.boxPosition;
    counts.set(state.label, current);
  });
  const values = [...counts.values()];
  if (values.length === 0) return null;
  return values.sort((a, b) => (
    b.count - a.count ||
    a.lastIndex - b.lastIndex
  ))[0];
}

function statePriceBuffer(state, current) {
  const high = Number(state && state.box && state.box.high);
  const low = Number(state && state.box && state.box.low);
  const height = high - low;
  if (!Number.isFinite(height) || height <= 0) {
    return current.close * PRICE_BUFFER_PCT * 3;
  }
  return Math.max(current.close * PRICE_BUFFER_PCT * 2, height * 0.18);
}

function canHoldState(candidate, rawState, current) {
  if (!candidate || !rawState || isFailedState(rawState)) return false;
  const candidateType = String(candidate.type || '');
  const rawType = String(rawState.type || '');
  const rawDirection = rawState.direction;
  const candidateDirection = candidate.direction;
  const oppositeDirectionalSwitch = candidateDirection !== 'flat' &&
    rawDirection !== 'flat' &&
    candidateDirection !== rawDirection;
  if (oppositeDirectionalSwitch && isDecisiveState(rawState)) return false;

  if (candidate.box) {
    const high = Number(candidate.box.high);
    const low = Number(candidate.box.low);
    const buffer = statePriceBuffer(candidate, current);
    if (candidateType === 'range_rotation') {
      return current.close >= low - buffer && current.close <= high + buffer;
    }
    if (candidateType.startsWith('range_breakout_up')) {
      return current.close >= high - buffer;
    }
    if (candidateType.startsWith('range_breakdown_down')) {
      return current.close <= low + buffer;
    }
  }

  if (candidateType === 'trend_up') {
    return rawType !== 'trend_down' && rawState.direction !== 'down';
  }
  if (candidateType === 'trend_down') {
    return rawType !== 'trend_up' && rawState.direction !== 'up';
  }
  return candidateType === 'range_tug' || candidateType === 'range_rotation';
}

function annotateMarketState(state, rawState, smoothed, reason) {
  if (!state) return state;
  const rawType = rawState && rawState.type;
  const rawLabel = rawState && rawState.label;
  return {
    ...state,
    smoothed: Boolean(smoothed),
    rawType: rawType || state.type,
    rawLabel: rawLabel || state.label,
    smoothingReason: reason || null
  };
}

function buildRecentRawMarketStates(points, currentRawState) {
  const startIndex = Math.max(0, points.length - PRICE_STATE_SMOOTH_LOOKBACK_POINTS);
  const result = [];
  for (let index = startIndex; index < points.length; index++) {
    const point = points[index];
    if (index === points.length - 1) {
      result.push({ sec: point.sec, close: point.close, state: currentRawState });
      continue;
    }
    const prefix = points.slice(0, index + 1);
    result.push({
      sec: point.sec,
      close: point.close,
      state: analyzeRawPriceModules(prefix, point).marketState
    });
  }
  return result;
}

function smoothMarketState(points, current, rawState) {
  if (!rawState || points.length < PRICE_STATE_HOLD_POINTS + 1) {
    return annotateMarketState(rawState, rawState, false, null);
  }
  if (isFailedState(rawState)) {
    return annotateMarketState(rawState, rawState, false, '失败状态立即生效');
  }

  const rawStates = buildRecentRawMarketStates(points, rawState);
  const currentFamily = stateFamily(rawState);
  const familyCount = countRecentFamily(rawStates, currentFamily);
  const sameFamilyRun = trailingFamilyRun(rawStates, currentFamily);

  if (rawState.type === 'range_rotation') {
    if (sameFamilyRun >= PRICE_STATE_HOLD_POINTS) {
      const dominantRange = dominantRangeState(rawStates);
      if (dominantRange && dominantRange.count >= PRICE_STATE_HOLD_POINTS && dominantRange.label !== rawState.label) {
        return annotateMarketState({
          ...rawState,
          label: dominantRange.label,
          boxPosition: dominantRange.boxPosition,
          smoothingReason: null
        }, rawState, true, '横盘区域标签短暂漂移，保持近期主导标签');
      }
    }
    return annotateMarketState(rawState, rawState, false, null);
  }

  if (isDecisiveState(rawState) || familyCount >= PRICE_STATE_MIN_FAMILY_COUNT) {
    return annotateMarketState(rawState, rawState, false, null);
  }

  const holdCandidate = findHoldCandidate(rawStates, currentFamily);
  if (holdCandidate && canHoldState(holdCandidate.state, rawState, current)) {
    return annotateMarketState(
      holdCandidate.state,
      rawState,
      true,
      `${rawState.label || rawState.type}缺少连续确认，暂时保持${holdCandidate.state.label || holdCandidate.state.type}`
    );
  }

  return annotateMarketState(rawState, rawState, false, null);
}

function applyMarketStateScore(rawScore, marketState) {
  if (!marketState || !marketState.available) return rawScore;
  const stateScore = Number(marketState.score);
  if (!Number.isFinite(stateScore)) return rawScore;

  if (marketState.type === 'range_rotation') {
    return clamp(rawScore * 0.25 + stateScore * 0.75, -0.16, 0.16);
  }
  if (marketState.type === 'range_tug') {
    return clamp(rawScore * 0.35 + stateScore * 0.65, -0.18, 0.18);
  }
  if (marketState.type.endsWith('_failed')) {
    return clamp(rawScore * 0.35 + stateScore * 0.65, -1, 1);
  }
  if (marketState.type.includes('breakout') || marketState.type.includes('breakdown')) {
    return clamp(rawScore * 0.3 + stateScore * 0.7, -1, 1);
  }
  if (marketState.type === 'trend_up' || marketState.type === 'trend_down') {
    return clamp(rawScore * 0.45 + stateScore * 0.55, -1, 1);
  }
  return clamp(rawScore * 0.55 + stateScore * 0.45, -1, 1);
}

function buildInvalidation(direction, structure, vwap, marketState) {
  if (marketState && marketState.invalidation) {
    return marketState.invalidation;
  }
  const lower = structure && structure.range ? structure.range.low : null;
  const upper = structure && structure.range ? structure.range.high : null;
  const hasVwap = Boolean(vwap && vwap.available && vwap.value);

  if (direction === 'up') {
    if (hasVwap && lower !== null) return `跌回VWAP下方并跌破近端低点${lower}`;
    if (lower !== null) return `跌破近端低点${lower}`;
    return '重新跌回近端区间内';
  }
  if (direction === 'down') {
    if (hasVwap && upper !== null) return `站回VWAP上方并突破近端高点${upper}`;
    if (upper !== null) return `突破近端高点${upper}`;
    return '重新站回近端区间内';
  }
  if (upper !== null && lower !== null) return `突破${upper}或跌破${lower}后重新评估`;
  return '等待价格结构给出新方向';
}

function classifyDirection(score) {
  if (score >= 0.55) return { state: 'Strong Bullish', direction: 'up', label: '强偏多' };
  if (score >= 0.18) return { state: 'Bullish', direction: 'up', label: '偏多' };
  if (score <= -0.55) return { state: 'Strong Bearish', direction: 'down', label: '强偏空' };
  if (score <= -0.18) return { state: 'Bearish', direction: 'down', label: '偏空' };
  return { state: 'Neutral', direction: 'flat', label: '中性/拉扯' };
}

function buildPriceContext(context = {}) {
  const points = buildSeries(context);
  const current = points.length ? points[points.length - 1] : null;
  if (!current) {
    return {
      available: false,
      state: 'Neutral',
      direction: 'flat',
      label: '价格数据不足',
      score: 0,
      confidence: 0,
      coverage: 0,
      invalidation: '等待价格数据',
      modules: {
        marketState: null,
        structure: null,
        movingAverage: null,
        vwap: null,
        momentum: null
      },
      weights: MODULE_WEIGHTS
    };
  }

  const rawModules = analyzeRawPriceModules(points, current);
  const structure = rawModules.structure;
  const movingAverage = rawModules.movingAverage;
  const vwap = rawModules.vwap;
  const momentum = rawModules.momentum;
  const marketState = context.stateSmoothing === false
    ? annotateMarketState(rawModules.marketState, rawModules.marketState, false, null)
    : smoothMarketState(points, current, rawModules.marketState);
  const modules = [
    { key: 'marketState', weight: MODULE_WEIGHTS.marketState, result: marketState },
    { key: 'structure', weight: MODULE_WEIGHTS.structure, result: structure },
    { key: 'movingAverage', weight: MODULE_WEIGHTS.movingAverage, result: movingAverage },
    { key: 'vwap', weight: MODULE_WEIGHTS.vwap, result: vwap },
    { key: 'momentum', weight: MODULE_WEIGHTS.momentum, result: momentum }
  ];
  const availableWeight = modules.reduce((sum, module) => (
    module.result && module.result.available ? sum + module.weight : sum
  ), 0);
  const weightedScore = modules.reduce((sum, module) => {
    if (!module.result || !module.result.available) return sum;
    return sum + module.result.score * module.weight;
  }, 0);
  const rawScore = availableWeight > 0 ? clamp(weightedScore / availableWeight, -1, 1) : 0;
  const score = applyMarketStateScore(rawScore, marketState);
  const coverage = availableWeight / TOTAL_MODULE_WEIGHT;
  const classification = classifyDirection(score);
  const confidenceBase = classification.direction === 'flat'
    ? Math.max(0, 0.18 - Math.abs(score)) / 0.18 * 45
    : Math.abs(score) * 70;
  const confidence = availableWeight > 0
    ? clamp(confidenceBase + coverage * 30, 0, 100)
    : 0;

  return {
    available: availableWeight > 0,
    ...classification,
    score: round(score, 3),
    rawScore: round(rawScore, 3),
    confidence: round(confidence, 0),
    coverage: round(coverage, 2),
    invalidation: buildInvalidation(classification.direction, structure, vwap, marketState),
    marketState,
    modules: {
      marketState,
      structure,
      movingAverage,
      vwap,
      momentum
    },
    weights: MODULE_WEIGHTS
  };
}

module.exports = {
  buildPriceContext
};
