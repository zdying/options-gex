const fs = require('fs');
const gexService = require('../gexService');
const marketScheduler = require('../marketScheduler');
const gravityPresenter = require('../gravityPresenter');
const paths = require('../paths');
const { BUILTIN_TICKERS } = require('../tickerConfig');
const timeUtils = require('../utils/timeUtils');
const logger = require('../utils/logger')('routes');

function getTickerState(ticker) {
  const defaultTicker = BUILTIN_TICKERS[0] || 'SPY';
  ticker = (ticker || defaultTicker).toUpperCase();
  let state = gexService.tickerStates[ticker];
  if (!state) state = gexService.tickerStates[defaultTicker];
  if (!state) {
    const keys = Object.keys(gexService.tickerStates);
    if (keys.length > 0) state = gexService.tickerStates[keys[0]];
  }
  return state;
}

function safeReadJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    logger.warn(`[Cache] Failed to read JSON cache ${filePath}: ${e.message}`);
    return fallback;
  }
}

function getLatestTradeDateWithData(ticker) {
  const liveDataRoot = paths.LIVE_DATA_ROOT;
  if (!fs.existsSync(liveDataRoot)) return null;

  try {
    const dates = fs.readdirSync(liveDataRoot)
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort((a, b) => b.localeCompare(a));

    for (const dateStr of dates) {
      if (fs.existsSync(paths.openChainPath(dateStr, ticker))) return dateStr;
    }
  } catch (e) {
    logger.error(`[GEX API] Error finding latest trade date for ${ticker}:`, e);
  }
  return null;
}

function getLatestHistoryForTicker(ticker) {
  const latestDateStr = getLatestTradeDateWithData(ticker);
  if (!latestDateStr) return { date: null, history: [] };

  const history = safeReadJson(paths.historyPath(latestDateStr, ticker), []);
  return {
    date: latestDateStr,
    history: Array.isArray(history) ? history : []
  };
}

function getLatestTradesCountForTicker(ticker) {
  const latestDateStr = getLatestTradeDateWithData(ticker);
  if (!latestDateStr) return 0;

  const trades = safeReadJson(paths.tradesPath(latestDateStr, ticker), []);
  return Array.isArray(trades) ? trades.length : 0;
}

function has0DteData(state) {
  const zeroDteMatrix = state && state.matrixViews && state.matrixViews['0dte'];
  if (Array.isArray(zeroDteMatrix) && zeroDteMatrix.length > 0) {
    return true;
  }

  const zeroDteSummary = state && state.gexSummary && state.gexSummary['0dte'];
  return Boolean(
    zeroDteSummary &&
    Array.isArray(zeroDteSummary.strikes) &&
    zeroDteSummary.strikes.length > 0
  );
}

function hasGravityMapData(map) {
  return Boolean(
    map &&
    Array.isArray(map.strikes) &&
    map.strikes.length > 0 &&
    Array.isArray(map.liveGravityCurve) &&
    Array.isArray(map.openingGravityCurve)
  );
}

function formatMapTime(sec) {
  const time = timeUtils.formatTime(Number(sec) || 0);
  return time.slice(0, 5);
}

function getLatestHistoryPointForExpiry(state, expiry) {
  const history = Array.isArray(state && state.history) ? state.history : [];
  for (let i = history.length - 1; i >= 0; i--) {
    const point = history[i];
    if (point && point.gexData && point.gexData[expiry]) {
      return point;
    }
  }
  return null;
}

function withGravityMapMeta(map, meta = {}) {
  if (!map) return null;
  return {
    date: meta.date || timeUtils.getEstDate(),
    time: meta.time || formatMapTime(meta.sec),
    sec: Number.isFinite(Number(meta.sec)) ? Number(meta.sec) : null,
    spot: Number.isFinite(Number(meta.spot)) ? Number(meta.spot) : null,
    ...map
  };
}

function getClientGravityMap(ticker, range = 'all') {
  const selectedRange = gravityPresenter.normalizeRange(range, 'all');
  const expiry = gravityPresenter.mapRangeToExpiry(selectedRange);
  const todayStr = timeUtils.getEstDate();
  const state = getTickerState(ticker);
  if (!state) return null;

  const spot = state.spot;
  const isMarketClosed = state.currentTimeSeconds >= 16 * 3600 || marketScheduler.currentSystemRegime === 'IDLE';

  if (state.gexSummary && state.gexSummary[expiry] && state.gexSummary[expiry].strikes && state.gexSummary[expiry].strikes.length > 0) {
    const latestPoint = getLatestHistoryPointForExpiry(state, expiry);
    return withGravityMapMeta(gravityPresenter.toMap(state.gexSummary[expiry]), {
      date: (latestPoint && latestPoint.date) || state.historyDate || todayStr,
      time: latestPoint && latestPoint.time,
      sec: latestPoint ? latestPoint.sec : state.currentTimeSeconds,
      spot: latestPoint ? latestPoint.spot : spot
    });
  }

  if (isMarketClosed) {
    const latestHistory = getLatestHistoryForTicker(ticker);
    if (latestHistory.history.length > 0) {
      const lastPoint = latestHistory.history[latestHistory.history.length - 1];
      if (lastPoint.gexData && lastPoint.gexData[expiry]) {
        logger.info(`[Gravity API] Returned cached ${selectedRange} gravity map from ${latestHistory.date} history for ${ticker}.`);
        return withGravityMapMeta(gravityPresenter.toMap(lastPoint.gexData[expiry]), {
          date: lastPoint.date || latestHistory.date,
          time: lastPoint.time,
          sec: lastPoint.sec,
          spot: lastPoint.spot
        });
      }
    }
  }

  if (state.calculatedMatrix && state.calculatedMatrix.length > 0) {
    const matrixViews = gexService.buildExpiryViews(state.calculatedMatrix, todayStr);
    state.matrixViews = matrixViews;
    state.gexSummary = gexService.buildGexSummaries(matrixViews, spot);
    const map = gravityPresenter.toMap(state.gexSummary[expiry]);
    return hasGravityMapData(map)
      ? withGravityMapMeta(map, {
        date: todayStr,
        sec: state.currentTimeSeconds,
        spot
      })
      : null;
  }

  return null;
}

async function getClientGravityState(ticker, requestedRange = 'today') {
  const defaultTicker = BUILTIN_TICKERS[0] || 'SPY';
  ticker = (ticker || defaultTicker).toUpperCase();
  const state = getTickerState(ticker);
  const gravityReference = await marketScheduler.getCurrentRegime();
  const normalizedRange = gravityPresenter.normalizeRange(requestedRange, 'today');

  if (!state) {
    const emptyState = gravityPresenter.statePayload({ ticker, gravityReference }, ticker);
    const selectedRange = normalizedRange === 'today' ? 'near' : normalizedRange;
    return {
      ...emptyState,
      selectedRange,
      gravityMap: null
    };
  }

  const clientState = gravityPresenter.statePayload({
    ticker: state.ticker,
    isRunning: state.isRunning,
    currentTime: timeUtils.formatTime(state.currentTimeSeconds),
    currentTimePct: ((state.currentTimeSeconds - 9.5 * 3600) / (6.5 * 3600)) * 100,
    spot: state.spot,
    latestMetrics: state.latestGex,
    has0Dte: has0DteData(state),
    gravityReference
  }, ticker);
  const selectedRange = clientState.has0Dte === false && normalizedRange === 'today'
    ? 'near'
    : normalizedRange;

  return {
    ...clientState,
    selectedRange,
    gravityMap: getClientGravityMap(ticker, selectedRange)
  };
}

module.exports = {
  getClientGravityMap,
  getClientGravityState,
  getLatestHistoryForTicker,
  getLatestTradeDateWithData,
  getLatestTradesCountForTicker,
  getTickerState,
  safeReadJson
};
