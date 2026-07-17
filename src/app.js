const path = require('path');
const fs = require('fs');
const https = require('https');
const express = require('express');
const gravityRoutes = require('./routes/gravity');
const tickerRoutes = require('./routes/tickers');
const { isAuthorizedRequest } = require('./utils/auth');
const logger = require('./utils/logger')('app');
const marketScheduler = require('./marketScheduler');
const env = require('./env');

const app = express();
const PORT = process.env.PORT || 3080;
const SSL_KEY_PATH = process.env.SSL_KEY_PATH || path.join(__dirname, '../certs/server.key');
const SSL_CERT_PATH = process.env.SSL_CERT_PATH || path.join(__dirname, '../certs/server.crt');

function originMatchesAllowed(origin, allowedOrigin) {
  if (origin === allowedOrigin) return true;
  if (!allowedOrigin || !allowedOrigin.endsWith(':*')) return false;

  try {
    const originUrl = new URL(origin);
    const allowedUrl = new URL(allowedOrigin.slice(0, -2));
    return originUrl.protocol === allowedUrl.protocol &&
      originUrl.hostname === allowedUrl.hostname;
  } catch (error) {
    return false;
  }
}

function isAllowedCorsOrigin(origin) {
  if (!origin) return false;
  const allowedOrigins = Array.isArray(env.CORS_ALLOWED_ORIGINS) ? env.CORS_ALLOWED_ORIGINS : [];
  return allowedOrigins.some(allowedOrigin => originMatchesAllowed(origin, allowedOrigin));
}

app.use((req, res, next) => {
  res.setHeader('X-Powered-By', 'KA_2.0');
  const origin = req.headers.origin;
  if (isAllowedCorsOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
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
  logger.info(`Allowed CORS origins: ${env.CORS_ALLOWED_ORIGINS.join(', ')}`);
  logger.info(`==========================================`);
});

module.exports = app;
