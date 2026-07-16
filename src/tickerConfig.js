const sortedTickers = [
  { name: 'SPY', count: 0 },
  { name: 'QQQ', count: 0 },
  { name: 'IWM', count: 0 },
  { name: 'GLD', count: 0 },
  { name: 'SLV', count: 0 },
  { name: 'MU', count: 0 },
  { name: 'SPCX', count: 0 },
  { name: 'AAPL', count: 0 },
  { name: 'NVDA', count: 0 },
  { name: 'TSLA', count: 0 },
  { name: 'MSFT', count: 0 },
  { name: 'AMZN', count: 0 },
  { name: 'INTC', count: 0 },
  { name: 'AMD', count: 0 },
  { name: 'GOOG', count: 0 },
  { name: 'META', count: 0 },
  { name: 'NFLX', count: 0 },
  { name: 'TSM', count: 0 },
  { name: 'ORCL', count: 0 },
  { name: 'SNDK', count: 0 },
];

const BUILTIN_TICKERS = sortedTickers.map(t => t.name.toUpperCase());

module.exports = {
  sortedTickers,
  BUILTIN_TICKERS
};
