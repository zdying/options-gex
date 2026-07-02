const express = require('express');
const engine = require('../engine');
const gravityPresenter = require('../presenter/gravityPresenter');
const logger = require('../utils/logger')('gravityRoutes');
const {
  getClientGravityState,
  getLatestHistoryForTicker,
  getLatestTradeDateWithData,
  getTickerState
} = require('./helpers');

const router = express.Router();

router.get('/gravity-state', async (req, res) => {
  const ticker = (req.query.ticker || 'AAPL').toUpperCase();
  const state = getTickerState(ticker);
  if (state) {
    if (!state.latestGex || !state.history || state.history.length === 0) {
      const latestHistory = getLatestHistoryForTicker(ticker);
      if (latestHistory.history.length > 0) {
        const lastPoint = latestHistory.history[latestHistory.history.length - 1];
        state.history = latestHistory.history;
        state.spot = lastPoint.spot || state.spot;
        state.latestGex = engine.getPrimaryGexMetrics(lastPoint.gexData) || state.latestGex;
        if (lastPoint.gexData) {
          state.gexSummary = lastPoint.gexData;
        }
      }
    }

    const quotePrices = await engine.fetchTipRanksQuotePrices([ticker]);
    if (quotePrices[ticker]) {
      state.spot = quotePrices[ticker];
    }
  }
  res.json(await getClientGravityState(ticker));
});

router.get('/gravity-map', async (req, res) => {
  const ticker = (req.query.ticker || 'AAPL').toUpperCase();
  const range = gravityPresenter.getRequestedRange(req);
  const expiry = gravityPresenter.mapRangeToExpiry(range);
  const todayStr = engine.getEstDateStr();
  const emptySummary = gravityPresenter.emptyMap();

  const state = getTickerState(ticker);
  if (!state) {
    return res.json(emptySummary);
  }

  const spot = state.spot;
  const isMarketClosed = state.currentTimeSeconds >= 16 * 3600 || engine.currentSystemRegime === 'IDLE';

  if (state.gexSummary && state.gexSummary[expiry] && state.gexSummary[expiry].strikes && state.gexSummary[expiry].strikes.length > 0) {
    return res.json(gravityPresenter.toMap(state.gexSummary[expiry]));
  }

  if (isMarketClosed) {
    const latestHistory = getLatestHistoryForTicker(ticker);
    if (latestHistory.history.length > 0) {
      const lastPoint = latestHistory.history[latestHistory.history.length - 1];
      if (lastPoint.gexData && lastPoint.gexData[expiry]) {
        logger.info(`[Gravity API] Returned cached ${range} gravity map from ${latestHistory.date} history for ${ticker}.`);
        return res.json(gravityPresenter.toMap(lastPoint.gexData[expiry]));
      }
    }
  }

  if (state.calculatedMatrix && state.calculatedMatrix.length > 0) {
    const matrixViews = engine.buildExpiryViews(state.calculatedMatrix, todayStr);
    state.matrixViews = matrixViews;
    state.gexSummary = engine.buildGexSummaries(matrixViews, spot);
    return res.json(gravityPresenter.toMap(state.gexSummary[expiry]) || emptySummary);
  }

  return res.json(emptySummary);
});

router.get('/gravity-history', (req, res) => {
  const ticker = (req.query.ticker || 'AAPL').toUpperCase();
  const range = gravityPresenter.getRequestedRange(req);

  const state = engine.tickerStates[ticker];
  let historyPoints = [];
  let historyDate = getLatestTradeDateWithData(ticker);
  if (state) {
    historyPoints = state.history;
    if (!historyPoints || historyPoints.length === 0) {
      const latestHistory = getLatestHistoryForTicker(ticker);
      historyPoints = latestHistory.history;
      historyDate = latestHistory.date || historyDate;
      if (historyPoints.length > 0) {
        state.history = historyPoints;
        const lastPoint = historyPoints[historyPoints.length - 1];
        state.spot = lastPoint.spot || state.spot;
        state.latestGex = engine.getPrimaryGexMetrics(lastPoint.gexData) || state.latestGex;
        if (lastPoint.gexData) {
          state.gexSummary = lastPoint.gexData;
        }
      }
    }
  } else {
    const latestHistory = getLatestHistoryForTicker(ticker);
    historyPoints = latestHistory.history;
    historyDate = latestHistory.date || historyDate;
  }

  const formattedHistory = historyPoints.map(h => {
    const gravityMap = gravityPresenter.mapForHistoryPoint(h, range);
    const gravityMetrics = gravityPresenter.metricsForHistoryPoint(h, range);
    return {
      time: h.time,
      date: h.date || historyDate,
      sec: h.sec,
      spot: h.spot,
      ...gravityMetrics,
      gravityMap
    };
  });
  res.json(formattedHistory);
});

module.exports = router;
