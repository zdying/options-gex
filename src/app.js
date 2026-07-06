const path = require('path');
const fs = require('fs');
const https = require('https');
const express = require('express');
const gravityRoutes = require('./routes/gravity');
const tickerRoutes = require('./routes/tickers');
const { isAuthorizedRequest } = require('./utils/auth');
const logger = require('./utils/logger')('app');
const marketScheduler = require('./marketScheduler');

const app = express();
const PORT = process.env.PORT || 3080;
const SSL_KEY_PATH = process.env.SSL_KEY_PATH || path.join(__dirname, '../certs/server.key');
const SSL_CERT_PATH = process.env.SSL_CERT_PATH || path.join(__dirname, '../certs/server.crt');

app.use((req, res, next) => {
  res.setHeader('X-Powered-By', 'KA_2.0');
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

const httpsOptions = {
  key: fs.readFileSync(SSL_KEY_PATH),
  cert: fs.readFileSync(SSL_CERT_PATH)
};

https.createServer(httpsOptions, app).listen(PORT, () => {
  logger.info(`==========================================`);
  logger.info(`GEX Structure Engine is running at:`);
  logger.info(`https://localhost:${PORT}`);
  logger.info(`==========================================`);
});

module.exports = app;
