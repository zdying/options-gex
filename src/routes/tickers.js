const express = require('express');
const engine = require('../engine');
const { getLatestTradesCountForTicker } = require('./helpers');

const router = express.Router();

router.get('/tickers', (req, res) => {
  const result = engine.sortedTickers.map(t => {
    const ticker = t.name.toUpperCase();
    const liveCount = engine.liveTickerCounts[ticker] || 0;
    return {
      name: t.name,
      count: liveCount > 0 ? liveCount : getLatestTradesCountForTicker(ticker)
    };
  });
  res.json(result);
});

module.exports = router;
