#!/usr/bin/env node

const { performance } = require('perf_hooks');
const {
  fetchOptionChainUntilExpiration,
  normalizeMmy
} = require('../src/benzingaOptionChainStream');

const API_KEY = '2RiuR92vjytxS8r93w3c8WTpGSd3y9Gk';
const DEFAULT_TICKERS = ['SPY', 'QQQ', 'AAPL', 'TSLA', 'IWM'];
const DEFAULT_TARGET_MMY = '20260731';
const TIMEOUT_MS = 60000;
const REQUEST_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0',
  Connection: 'close'
};

function usage() {
  console.log('Usage: node scripts/benchmark_benzinga_optionchain_stream.js [targetMmy] [tickers]');
  console.log('Example: node scripts/benchmark_benzinga_optionchain_stream.js 20260731 SPY,QQQ,AAPL,TSLA,IWM');
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    process.exit(0);
  }

  const targetMmy = normalizeMmy(argv[2] || DEFAULT_TARGET_MMY);
  if (!targetMmy) {
    throw new Error('targetMmy must be YYYYMMDD or YYYY-MM-DD');
  }

  const tickers = (argv[3] || DEFAULT_TICKERS.join(','))
    .split(',')
    .map(t => t.trim().toUpperCase())
    .filter(Boolean);

  if (tickers.length === 0) {
    throw new Error('At least one ticker is required');
  }

  return { targetMmy, tickers };
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

function formatMs(ms) {
  return `${Math.round(ms)}ms`;
}

function getFirstTickerChain(data, ticker) {
  const optionChains = data && data.optionChains;
  if (!Array.isArray(optionChains)) return null;
  return optionChains.find(item => String(item && item.symbol || '').toUpperCase() === ticker)
    || optionChains[0]
    || null;
}

function cropFullData(data, ticker, targetMmy) {
  const tickerChain = getFirstTickerChain(data, ticker);
  const chains = Array.isArray(tickerChain && tickerChain.chains)
    ? tickerChain.chains
    : [];

  return {
    optionChains: [
      {
        symbol: ticker,
        chains: chains.filter(group => {
          const mmy = normalizeMmy(group && group.mmy);
          return !mmy || mmy <= targetMmy;
        })
      }
    ]
  };
}

function countContracts(data) {
  const tickerChain = data && data.optionChains && data.optionChains[0];
  const chains = Array.isArray(tickerChain && tickerChain.chains) ? tickerChain.chains : [];
  return chains.reduce((sum, group) => {
    const calls = Array.isArray(group.calls) ? group.calls.length : 0;
    const puts = Array.isArray(group.puts) ? group.puts.length : 0;
    return sum + calls + puts;
  }, 0);
}

async function fetchFullOptionChain(ticker) {
  const url = `https://data-api.benzinga.com/rest/v1/optionchain?apikey=${API_KEY}&symbols=${encodeURIComponent(ticker)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = performance.now();

  try {
    const response = await fetch(url, {
      headers: REQUEST_HEADERS,
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Benzinga optionchain returned status ${response.status}`);
    }

    const text = await response.text();
    const readMs = performance.now() - startedAt;
    const parseStartedAt = performance.now();
    const data = JSON.parse(text);
    const parseMs = performance.now() - parseStartedAt;

    return {
      data,
      bytes: Buffer.byteLength(text),
      readMs,
      parseMs
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function benchmarkTicker(ticker, targetMmy) {
  const fullStartedAt = performance.now();
  const full = await fetchFullOptionChain(ticker);
  const fullTotalMs = performance.now() - fullStartedAt;
  const croppedFull = cropFullData(full.data, ticker, targetMmy);

  const streamStartedAt = performance.now();
  const streamed = await fetchOptionChainUntilExpiration({
    symbol: ticker,
    targetMmy,
    headers: REQUEST_HEADERS,
    timeoutMs: TIMEOUT_MS
  });
  const streamTotalMs = performance.now() - streamStartedAt;

  const fullChains = croppedFull.optionChains[0].chains;
  const streamChains = streamed.data.optionChains[0].chains;
  const same = JSON.stringify(fullChains) === JSON.stringify(streamChains);

  return {
    ticker,
    same,
    fullChains: fullChains.length,
    streamChains: streamChains.length,
    fullContracts: countContracts(croppedFull),
    streamContracts: countContracts(streamed.data),
    fullBytes: full.bytes,
    streamBytes: streamed.meta.readBytes,
    fullTotalMs,
    fullReadMs: full.readMs,
    fullParseMs: full.parseMs,
    streamTotalMs,
    streamStoppedEarly: streamed.meta.stoppedEarly,
    streamMatchedTarget: streamed.meta.matchedTarget
  };
}

function printResult(result) {
  const savedBytes = result.fullBytes - result.streamBytes;
  const savedPct = result.fullBytes > 0 ? (savedBytes / result.fullBytes * 100).toFixed(1) : '0.0';
  const speedup = result.streamTotalMs > 0 ? (result.fullTotalMs / result.streamTotalMs).toFixed(2) : '-';

  console.log([
    result.same ? 'OK ' : 'BAD',
    result.ticker.padEnd(5),
    `chains ${String(result.streamChains).padStart(2)}/${String(result.fullChains).padEnd(2)}`,
    `contracts ${String(result.streamContracts).padStart(5)}/${String(result.fullContracts).padEnd(5)}`,
    `full ${formatMs(result.fullTotalMs).padStart(7)} ${formatBytes(result.fullBytes).padStart(8)}`,
    `stream ${formatMs(result.streamTotalMs).padStart(7)} ${formatBytes(result.streamBytes).padStart(8)}`,
    `saved ${String(savedPct).padStart(5)}%`,
    `speed ${speedup}x`,
    `target ${result.streamMatchedTarget ? 'hit' : 'miss'}`,
    `abort ${result.streamStoppedEarly ? 'yes' : 'no'}`
  ].join(' | '));
}

async function main() {
  const { targetMmy, tickers } = parseArgs(process.argv);

  console.log(`Target mmy <= ${targetMmy}`);
  console.log(`Tickers: ${tickers.join(', ')}`);
  console.log('');

  const results = [];
  for (const ticker of tickers) {
    try {
      const result = await benchmarkTicker(ticker, targetMmy);
      results.push(result);
      printResult(result);
    } catch (err) {
      console.log(`ERR | ${ticker.padEnd(5)} | ${err.message}`);
    }
  }

  const passed = results.filter(r => r.same).length;
  const failed = results.filter(r => !r.same).length;
  console.log('');
  console.log(`Compare result: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
