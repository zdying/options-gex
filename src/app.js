const path = require('path');
const express = require('express');
const gravityRoutes = require('./routes/gravity');
const tickerRoutes = require('./routes/tickers');
const logger = require('./utils/logger')('app');
const marketScheduler = require('./marketScheduler');

const app = express();
const PORT = process.env.PORT || 3080;

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
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
