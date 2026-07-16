const gravityPresenter = require('./gravityPresenter');
const logger = require('./utils/logger')('gravity-push');

const GRAVITY_PUSH_CONFIG = {
  enabled: true,
  apiUrl: 'http://localhost:8787/api/internal/gravity',
  internalApiToken: 'ka_internal_M3MYTtJ60kQtKR45aJu8u6HoaVvbVjln',
  ranges: ['today', 'near', 'all'],
  timeoutMs: 8000
};

const RANGE_TO_SOURCE = {
  today: '0dte',
  near: 'weekly',
  all: 'all'
};

const MARKET_OPEN_SEC = 9.5 * 3600;
const MARKET_DAY_SEC = 6.5 * 3600;

function hasGravityMap(source) {
  return Boolean(
    source &&
    Array.isArray(source.strikes) &&
    Array.isArray(source.realtimeStrikeGexMillions) &&
    Array.isArray(source.globalStrikeGexMillions) &&
    source.strikes.length > 0 &&
    source.realtimeStrikeGexMillions.length > 0 &&
    source.globalStrikeGexMillions.length > 0
  );
}

function getStateSource(point, fallbackSource) {
  const todaySource = point && point.gexData && point.gexData['0dte'];
  if (hasGravityMap(todaySource)) return todaySource;

  const allSource = point && point.gexData && point.gexData.all;
  if (hasGravityMap(allSource)) return allSource;

  return fallbackSource;
}

function currentTimePct(point) {
  const sec = Number(point && point.sec);
  if (!Number.isFinite(sec)) return 0;
  return Math.max(0, Math.min(100, ((sec - MARKET_OPEN_SEC) / MARKET_DAY_SEC) * 100));
}

function formatCurrentTime(point) {
  if (point && typeof point.time === 'string') {
    return point.time.length === 5 ? `${point.time}:00` : point.time;
  }
  return '09:30:00';
}

function buildPayload({ ticker, date, point, range }) {
  const sourceKey = RANGE_TO_SOURCE[range];
  const source = point && point.gexData && point.gexData[sourceKey];
  if (!hasGravityMap(source)) return null;

  const stateSource = getStateSource(point, source);
  const snapshot = gravityPresenter.toMap(source);

  return {
    ticker,
    range,
    date,
    state: {
      selectedTicker: ticker,
      isRunning: true,
      currentTime: formatCurrentTime(point),
      currentTimePct: currentTimePct(point),
      speedMultiplier: 1,
      spot: Number(point.spot) || 0,
      has0Dte: hasGravityMap(point && point.gexData && point.gexData['0dte']),
      latestGravity: gravityPresenter.toMetrics(stateSource)
    },
    snapshot: {
      ...snapshot,
      spot: Number(point.spot) || 0
    }
  };
}

async function postPayload(payload) {
  logger.info('忽略，暂时不推送数据库...');

  return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GRAVITY_PUSH_CONFIG.timeoutMs);

  try {
    const response = await fetch(GRAVITY_PUSH_CONFIG.apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GRAVITY_PUSH_CONFIG.internalApiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function pushHistoryPoint({ ticker, date, point }) {
  if (!GRAVITY_PUSH_CONFIG.enabled) return;

  const payloads = GRAVITY_PUSH_CONFIG.ranges
    .map(range => buildPayload({ ticker, date, point, range }))
    .filter(Boolean);

  if (payloads.length === 0) {
    logger.warn(`[GravityPush] Skip ${ticker} ${point && point.time}: no valid gravity maps.`);
    return;
  }

  const results = await Promise.allSettled(payloads.map(postPayload));
  const failed = results.filter(result => result.status === 'rejected');
  if (failed.length > 0) {
    logger.warn(`[GravityPush] ${ticker} ${point.time} failed ${failed.length}/${payloads.length}: ${failed[0].reason.message}`);
    return;
  }

  logger.info(`[GravityPush] ${ticker} ${point.time} pushed ${payloads.length} range(s).`);
}

module.exports = {
  GRAVITY_PUSH_CONFIG,
  pushHistoryPoint
};
