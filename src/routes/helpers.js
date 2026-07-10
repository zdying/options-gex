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

async function getClientGravityState(ticker) {
  const defaultTicker = BUILTIN_TICKERS[0] || 'SPY';
  ticker = (ticker || defaultTicker).toUpperCase();
  const state = getTickerState(ticker);
  const gravityReference = await marketScheduler.getCurrentRegime();

  if (!state) {
    return gravityPresenter.statePayload({ ticker, gravityReference }, ticker);
  }

  return gravityPresenter.statePayload({
    ticker: state.ticker,
    isRunning: state.isRunning,
    currentTime: timeUtils.formatTime(state.currentTimeSeconds),
    currentTimePct: ((state.currentTimeSeconds - 9.5 * 3600) / (6.5 * 3600)) * 100,
    spot: state.spot,
    latestMetrics: state.latestGex,
    has0Dte: has0DteData(state),
    gravityReference
  }, ticker);
}

module.exports = {
  getClientGravityState,
  getLatestHistoryForTicker,
  getLatestTradeDateWithData,
  getLatestTradesCountForTicker,
  getTickerState,
  safeReadJson
};
