const express = require('express');
const gexService = require('../gexService');
const { sortedTickers } = require('../tickerConfig');
const { getLatestTradesCountForTicker } = require('./helpers');

const router = express.Router();

router.get('/tickers', (req, res) => {
  const result = sortedTickers.map(t => {
    const ticker = t.name.toUpperCase();
    const liveCount = gexService.liveTickerCounts[ticker] || 0;
    return {
      name: t.name,
      count: liveCount > 0 ? liveCount : getLatestTradesCountForTicker(ticker)
    };
  });
  res.json(result);
});

module.exports = router;
