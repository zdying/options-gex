#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const gravityPresenter = require('../src/gravityPresenter');

const SYNC_CONFIG = {
  date: '2026-07-14',
  apiUrl: 'http://localhost:8787/api/internal/gravity',
  internalApiToken: 'ka_internal_M3MYTtJ60kQtKR45aJu8u6HoaVvbVjln',
  ranges: ['today', 'near', 'all'],
  stateRange: 'today',
  concurrency: 4
};

const MARKET_OPEN_SEC = 9.5 * 3600;
const MARKET_DAY_SEC = 6.5 * 3600;

const RANGE_TO_SOURCE = {
  today: '0dte',
  near: 'weekly',
  all: 'all'
};

function parseArgs(argv) {
  const options = {
    date: SYNC_CONFIG.date,
    dataDir: null,
    apiUrl: SYNC_CONFIG.apiUrl,
    token: SYNC_CONFIG.internalApiToken,
    tickers: null,
    ranges: SYNC_CONFIG.ranges,
    stateRange: SYNC_CONFIG.stateRange,
    concurrency: SYNC_CONFIG.concurrency,
    dryRun: false,
    limit: 0
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--date') {
      options.date = requireValue(arg, next);
      i++;
    } else if (arg === '--data-dir') {
      options.dataDir = requireValue(arg, next);
      i++;
    } else if (arg === '--api-url') {
      options.apiUrl = requireValue(arg, next);
      i++;
    } else if (arg === '--token') {
      options.token = requireValue(arg, next);
      i++;
    } else if (arg === '--tickers') {
      options.tickers = parseList(requireValue(arg, next)).map(v => v.toUpperCase());
      i++;
    } else if (arg === '--ranges') {
      options.ranges = parseList(requireValue(arg, next)).map(v => v.toLowerCase());
      i++;
    } else if (arg === '--state-range') {
      options.stateRange = requireValue(arg, next).toLowerCase();
      i++;
    } else if (arg === '--concurrency') {
      options.concurrency = Math.max(1, Number.parseInt(requireValue(arg, next), 10) || 1);
      i++;
    } else if (arg === '--limit') {
      options.limit = Math.max(0, Number.parseInt(requireValue(arg, next), 10) || 0);
      i++;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  validateRangeList(options.ranges, '--ranges');
  validateRangeList([options.stateRange], '--state-range');

  if (!options.dataDir) {
    options.dataDir = path.join(__dirname, '..', 'data', 'live_data', options.date);
  }

  return options;
}

function requireValue(name, value) {
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function parseList(value) {
  return String(value || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
}

function validateRangeList(ranges, label) {
  const invalid = ranges.filter(range => !RANGE_TO_SOURCE[range]);
  if (invalid.length > 0) {
    throw new Error(`${label} contains unsupported range(s): ${invalid.join(', ')}`);
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getTickerDirs(dataDir, requestedTickers) {
  if (!fs.existsSync(dataDir)) {
    throw new Error(`Data directory does not exist: ${dataDir}`);
  }

  const available = fs.readdirSync(dataDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name.toUpperCase())
    .sort();

  const tickers = requestedTickers || available;
  return tickers.map(ticker => {
    const tickerDir = path.join(dataDir, ticker);
    const historyPath = path.join(tickerDir, 'history.json');
    if (!fs.existsSync(historyPath)) {
      throw new Error(`Missing history.json for ${ticker}: ${historyPath}`);
    }
    return { ticker, historyPath };
  });
}

function formatCurrentTime(point) {
  if (point && typeof point.time === 'string') {
    return point.time.length === 5 ? `${point.time}:00` : point.time;
  }
  if (Number.isFinite(point && point.sec)) {
    return secondsToTime(point.sec);
  }
  return '09:30:00';
}

function secondsToTime(sec) {
  const normalized = Math.max(0, Number(sec) || 0);
  const h = Math.floor(normalized / 3600).toString().padStart(2, '0');
  const m = Math.floor((normalized % 3600) / 60).toString().padStart(2, '0');
  const s = Math.floor(normalized % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function currentTimePct(point) {
  const sec = Number(point && point.sec);
  if (!Number.isFinite(sec)) return 0;
  return Math.max(0, Math.min(100, ((sec - MARKET_OPEN_SEC) / MARKET_DAY_SEC) * 100));
}

function hasRangeData(point, range) {
  const sourceKey = RANGE_TO_SOURCE[range];
  const source = point && point.gexData && point.gexData[sourceKey];
  return Boolean(
    source &&
    Array.isArray(source.strikes) &&
    Array.isArray(source.realtimeStrikeGexMillions) &&
    Array.isArray(source.globalStrikeGexMillions) &&
    source.strikes.length > 0 &&
    source.realtimeStrikeGexMillions.length > 0 &&
    source.globalStrikeGexMillions.length > 0
  );
}

function buildPayload(ticker, date, point, range, stateRange) {
  const sourceKey = RANGE_TO_SOURCE[range];
  const stateSourceKey = RANGE_TO_SOURCE[stateRange];
  const source = point.gexData[sourceKey];
  const stateSource = point.gexData[stateSourceKey] || source;
  const snapshot = gravityPresenter.toMap(source);
  const latestGravity = gravityPresenter.toMetrics(stateSource);

  return {
    ticker,
    range,
    date,
    state: {
      selectedTicker: ticker,
      isRunning: true,
      currentTime: formatCurrentTime(point),
      currentTimePct: currentTimePct(point),
      speedMultiplier: 1,
      spot: Number(point.spot) || 0,
      has0Dte: hasRangeData(point, 'today'),
      latestGravity
    },
    snapshot: {
      ...snapshot,
      spot: Number(point.spot) || 0
    }
  };
}

function buildJobs(options) {
  const tickerDirs = getTickerDirs(options.dataDir, options.tickers);
  const jobs = [];
  const skipped = [];

  for (const { ticker, historyPath } of tickerDirs) {
    const history = readJson(historyPath);
    if (!Array.isArray(history)) {
      throw new Error(`history.json must be an array: ${historyPath}`);
    }

    for (const point of history) {
      for (const range of options.ranges) {
        if (!hasRangeData(point, range)) {
          skipped.push({ ticker, time: point && point.time, range, reason: 'missing range data' });
          continue;
        }
        jobs.push({
          ticker,
          range,
          time: point.time,
          payload: buildPayload(ticker, options.date, point, range, options.stateRange)
        });
        if (options.limit > 0 && jobs.length >= options.limit) {
          return { jobs, skipped };
        }
      }
    }
  }

  return { jobs, skipped };
}

async function postPayload(apiUrl, token, payload) {
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (e) {
    body = text;
  }

  if (!response.ok) {
    const detail = typeof body === 'string' ? body : JSON.stringify(body);
    throw new Error(`HTTP ${response.status}: ${detail}`);
  }

  return body;
}

async function runPool(items, concurrency, worker) {
  let next = 0;
  let completed = 0;
  const failures = [];

  async function runWorker() {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      try {
        await worker(item, index);
      } catch (error) {
        failures.push({ item, error });
      } finally {
        completed++;
        if (completed % 250 === 0 || completed === items.length) {
          process.stdout.write(`Progress: ${completed}/${items.length}\n`);
        }
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => runWorker()
  );
  await Promise.all(workers);
  return failures;
}

function printHelp() {
  console.log(`Usage:
  npm run sync:gravity
  node scripts/push_gravity_history.js [options]

Options:
  --date YYYY-MM-DD        Trade date. Default: ${SYNC_CONFIG.date}
  --data-dir PATH          Directory containing ticker folders. Default: data/live_data/<date>
  --api-url URL            Internal gravity endpoint. Default: ${SYNC_CONFIG.apiUrl}
  --token TOKEN            Internal API token. Default: scripts/push_gravity_history.js SYNC_CONFIG.internalApiToken
  --tickers AAPL,QQQ       Optional ticker filter
  --ranges today,near,all  Ranges to import. Default: today,near,all
  --state-range today      Range used for gravity_states.latestGravity. Default: today
  --concurrency N          POST concurrency. Default: 4
  --limit N                Only build/send first N payloads, useful for smoke tests
  --dry-run                Build and validate payloads without POSTing
  --help                   Show this help

Examples:
  npm run sync:gravity
`);
}

async function main() {
  const options = parseArgs(process.argv);
  const { jobs, skipped } = buildJobs(options);

  console.log(`Data dir: ${options.dataDir}`);
  console.log(`Date: ${options.date}`);
  console.log(`Ranges: ${options.ranges.join(', ')}`);
  console.log(`State range: ${options.stateRange}`);
  console.log(`Payloads: ${jobs.length}`);
  if (skipped.length > 0) {
    console.log(`Skipped: ${skipped.length}`);
  }

  if (jobs.length === 0) {
    console.log('Nothing to import.');
    return;
  }

  if (options.dryRun) {
    console.log('Dry run sample payload:');
    console.log(JSON.stringify(jobs[0].payload, null, 2));
    return;
  }

  if (!options.token || options.token === 'CHANGE_ME') {
    throw new Error('Missing token. Set SYNC_CONFIG.internalApiToken in scripts/push_gravity_history.js.');
  }

  console.log(`POST ${options.apiUrl}`);
  const failures = await runPool(jobs, options.concurrency, async job => {
    await postPayload(options.apiUrl, options.token, job.payload);
  });

  if (failures.length > 0) {
    console.error(`Failed: ${failures.length}/${jobs.length}`);
    failures.slice(0, 10).forEach(({ item, error }) => {
      console.error(`${item.ticker} ${item.range} ${item.time}: ${error.message}`);
    });
    process.exitCode = 1;
    return;
  }

  console.log(`Imported: ${jobs.length}`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
