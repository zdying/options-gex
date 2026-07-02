const sortedTickers = [
  { name: 'SPY', count: 0 },
  { name: 'QQQ', count: 0 },
  { name: 'MU', count: 0 },
  { name: 'AAPL', count: 0 },
  { name: 'NVDA', count: 0 },
  { name: 'TSLA', count: 0 },
  { name: 'MSFT', count: 0 },
  { name: 'AMZN', count: 0 }
];

const BUILTIN_TICKERS = sortedTickers.map(t => t.name.toUpperCase());

module.exports = {
  sortedTickers,
  BUILTIN_TICKERS
};
