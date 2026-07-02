const path = require('path');

const DATA_ROOT = path.join(__dirname, '../data');
const LIVE_DATA_ROOT = path.join(DATA_ROOT, 'live_data');

function liveDateDir(date) {
  return path.join(LIVE_DATA_ROOT, date);
}

function liveTickerDir(date, ticker) {
  return path.join(liveDateDir(date), String(ticker || '').toUpperCase());
}

function openChainPath(date, ticker) {
  return path.join(liveTickerDir(date, ticker), 'optionchains_open.json');
}

function tradesPath(date, ticker) {
  return path.join(liveTickerDir(date, ticker), 'trades.json');
}

function historyPath(date, ticker) {
  return path.join(liveTickerDir(date, ticker), 'history.json');
}

function optionSnapshotsDir(date, ticker) {
  return path.join(liveTickerDir(date, ticker), 'optionchains');
}

function optionSnapshotPath(date, ticker, timeStr) {
  return path.join(optionSnapshotsDir(date, ticker), `snap_${timeStr}.json`);
}

module.exports = {
  DATA_ROOT,
  LIVE_DATA_ROOT,
  liveDateDir,
  liveTickerDir,
  openChainPath,
  tradesPath,
  historyPath,
  optionSnapshotsDir,
  optionSnapshotPath
};
