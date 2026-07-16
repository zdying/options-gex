const express = require('express');
const gexService = require('../gexService');
const gravityPresenter = require('../gravityPresenter');
const {
  getClientGravityMap,
  getClientGravityState,
  getLatestHistoryForTicker,
  getLatestTradeDateWithData,
  getTickerState
} = require('./helpers');

const router = express.Router();

router.get('/gravity-state', async (req, res) => {
  const ticker = (req.query.ticker || 'AAPL').toUpperCase();
  const range = gravityPresenter.getRequestedRange(req, 'today');
  const state = getTickerState(ticker);
  if (state) {
    if (!state.latestGex || !state.history || state.history.length === 0) {
      const latestHistory = getLatestHistoryForTicker(ticker);
      if (latestHistory.history.length > 0) {
        const lastPoint = latestHistory.history[latestHistory.history.length - 1];
        state.history = latestHistory.history;
        state.historyDate = latestHistory.date;
        state.spot = lastPoint.spot || state.spot;
        state.latestGex = gexService.getPrimaryGexMetrics(lastPoint.gexData) || state.latestGex;
        if (lastPoint.gexData) {
          state.gexSummary = lastPoint.gexData;
        }
      }
    }
  }
  res.json(await getClientGravityState(ticker, range));
});

router.get('/gravity-map', async (req, res) => {
  const ticker = (req.query.ticker || 'AAPL').toUpperCase();
  const range = gravityPresenter.getRequestedRange(req);
  res.json(getClientGravityMap(ticker, range) || gravityPresenter.emptyMap());
});

router.get('/gravity-history', (req, res) => {
  const ticker = (req.query.ticker || 'AAPL').toUpperCase();
  const range = gravityPresenter.getRequestedRange(req);

  const state = gexService.tickerStates[ticker];
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
        state.historyDate = latestHistory.date;
        const lastPoint = historyPoints[historyPoints.length - 1];
        state.spot = lastPoint.spot || state.spot;
        state.latestGex = gexService.getPrimaryGexMetrics(lastPoint.gexData) || state.latestGex;
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
