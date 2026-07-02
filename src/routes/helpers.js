const fs = require('fs');
const path = require('path');
const engine = require('../engine');
const gravityPresenter = require('../presenter/gravityPresenter');
const logger = require('../utils/logger')('routes');

function getTickerState(ticker) {
  const defaultTicker = engine.BUILTIN_TICKERS[0] || 'SPY';
  ticker = (ticker || defaultTicker).toUpperCase();
  let state = engine.tickerStates[ticker];
  if (!state) state = engine.tickerStates[defaultTicker];
  if (!state) {
    const keys = Object.keys(engine.tickerStates);
    if (keys.length > 0) state = engine.tickerStates[keys[0]];
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
  const liveDataRoot = path.join(__dirname, '../../data/live_data');
  if (!fs.existsSync(liveDataRoot)) return null;

  try {
    const dates = fs.readdirSync(liveDataRoot)
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort((a, b) => b.localeCompare(a));

    for (const dateStr of dates) {
      const tickerDir = path.join(liveDataRoot, dateStr, ticker);
      const openChainPath = path.join(tickerDir, 'optionchains_open.json');
      if (fs.existsSync(openChainPath)) return dateStr;
    }
  } catch (e) {
    logger.error(`[GEX API] Error finding latest trade date for ${ticker}:`, e);
  }
  return null;
}

function getLatestHistoryForTicker(ticker) {
  const latestDateStr = getLatestTradeDateWithData(ticker);
  if (!latestDateStr) return { date: null, history: [] };

  const historyPath = path.join(__dirname, '../../data/live_data', latestDateStr, ticker, 'history.json');
  const history = safeReadJson(historyPath, []);
  return {
    date: latestDateStr,
    history: Array.isArray(history) ? history : []
  };
}

function getLatestTradesCountForTicker(ticker) {
  const latestDateStr = getLatestTradeDateWithData(ticker);
  if (!latestDateStr) return 0;

  const tradesPath = path.join(__dirname, '../../data/live_data', latestDateStr, ticker, 'trades.json');
  const trades = safeReadJson(tradesPath, []);
  return Array.isArray(trades) ? trades.length : 0;
}

async function getClientGravityState(ticker) {
  const defaultTicker = engine.BUILTIN_TICKERS[0] || 'SPY';
  ticker = (ticker || defaultTicker).toUpperCase();
  const state = getTickerState(ticker);
  const gravityReference = await engine.getCurrentRegime();

  if (!state) {
    return gravityPresenter.statePayload({ ticker, gravityReference }, ticker);
  }

  return gravityPresenter.statePayload({
    ticker: state.ticker,
    isRunning: state.isRunning,
    currentTime: engine.secondsToTimeString(state.currentTimeSeconds),
    currentTimePct: ((state.currentTimeSeconds - 9.5 * 3600) / (6.5 * 3600)) * 100,
    spot: state.spot,
    latestMetrics: state.latestGex,
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
