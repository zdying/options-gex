const path = require('path');
const express = require('express');
const gravityRoutes = require('./routes/gravity');
const tickerRoutes = require('./routes/tickers');
const { isAuthorizedRequest } = require('./utils/auth');
const logger = require('./utils/logger')('app');
const marketScheduler = require('./marketScheduler');

const app = express();
const PORT = process.env.PORT || 3080;

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://app.kairalert.pro');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  return next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

app.use('/api', async (req, res, next) => {
  const { ok, payload } = await isAuthorizedRequest(req);
  if (!ok) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  req.currentUser = payload;
  return next();
});

app.use('/api', tickerRoutes);
app.use('/api', gravityRoutes);

marketScheduler.start();

app.listen(PORT, () => {
  logger.info(`==========================================`);
  logger.info(`GEX Structure Engine is running at:`);
  logger.info(`http://localhost:${PORT}`);
  logger.info(`==========================================`);
});

module.exports = app;
