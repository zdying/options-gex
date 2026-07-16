/**
 * @file gexService.js
 * @description GEX 核心业务逻辑服务层。
 * 负责管理 Ticker 的内存持仓与历史状态，协调 Greeks/GEX 计算与大单、期权链快照更新，
 * 并实现非阻塞的异步文件持久化与简化的状态恢复机制。
 */

const fs = require('fs');
const { performance } = require('perf_hooks');

// 导入量化核心组件与工具类
const { calculateImpliedVolatility } = require('./bsCalculator');
const {
  calculateT,
  clampTradingTime,
  getExpirationDayDiff,
  getOptionGroupExpiration,
  isExpirationWithinDays
} = require('./utils/sharedUtils');
const {
  inferUnderlyingPrice,
  buildExpiryViews
} = require('./utils/optionChainAnalysisUtils');
const pricingConfig = require('./pricingConfig');
const logger = require('./utils/logger')('gex');
const gravityInternalClient = require('./gravityInternalClient');

const timeUtils = require('./utils/timeUtils');
const datacenter = require('./datacenter');
const paths = require('./paths');
const { sortedTickers, BUILTIN_TICKERS } = require('./tickerConfig');
const PositionStore = require('./positionStore');
const GexAggregator = require('./gexAggregator');

const { getEstDate, getEstTime } = timeUtils;
const { fetchQuotePrices } = datacenter;

// ==========================================
// 1. 初始化核心计算容器与大盘 Ticker 列表
// ==========================================
const store = new PositionStore(pricingConfig);
const gexAggregator = new GexAggregator(pricingConfig);
const GEX_STRIKE_RADIUS = 20;

// ==========================================
// 2. 全局内存状态容器
// ==========================================
const tickerStates = {};
const liveTickerCounts = {};
const knownSignalIds = new Set();
const historyWriteQueues = {};
let lastUpdatedCursor = 0;

// 初始化每个内置 Ticker 的状态空间
BUILTIN_TICKERS.forEach(ticker => {
  tickerStates[ticker] = {
    ticker,
    isRunning: true,
    currentTimeSeconds: 0,
    trades: [],
    spot: null,
    history: [],
    calculatedMatrix: [],
    matrixViews: { all: [], '0dte': [], weekly: [] },
    gexSummary: null,
    latestGex: null
  };
  liveTickerCounts[ticker] = 0;
});

// ==========================================
// 3. 核心辅助方法
// ==========================================

function getDividendYield(ticker) {
  return pricingConfig.dividendYieldByTicker[String(ticker || '').toUpperCase()] || 0;
}

/**
 * 从期权链或历史大单文件中恢复/反推标的 Spot 股价
 */
async function getTickerSpot(ticker) {
  ticker = ticker.toUpperCase();
  const todayStr = getEstDate();

  let spot = null;

  const openChainPath = paths.openChainPath(todayStr, ticker);
  if (fs.existsSync(openChainPath)) {
    try {
      const chainData = JSON.parse(await fs.promises.readFile(openChainPath, 'utf8'));
      const inferred = inferUnderlyingPrice(chainData);
      if (inferred) spot = inferred;
    } catch (e) { }
  }

  const tradesPath = paths.tradesPath(todayStr, ticker);
  if (fs.existsSync(tradesPath)) {
    try {
      const trades = JSON.parse(await fs.promises.readFile(tradesPath, 'utf8'));
      if (trades.length > 0) {
        const lastTrade = trades[trades.length - 1];
        spot = parseFloat(lastTrade.underlying_price) || spot;
      }
    } catch (e) { }
  }

  return spot;
}

async function getTickerSpotLive(ticker) {
  const uppercaseTicker = String(ticker || '').toUpperCase();
  const quotePrices = await fetchQuotePrices([uppercaseTicker]);

  logger.info(`[LiveSpot] Fetched live spot price for ${uppercaseTicker}:`, quotePrices[uppercaseTicker]);

  return quotePrices[uppercaseTicker] || getTickerSpot(uppercaseTicker);
}

function getStrikesAroundSpot(sortedStrikes, spot, radius = 10) {
  if (!sortedStrikes || sortedStrikes.length === 0) return [];
  if (!spot) return sortedStrikes;

  let closestIdx = 0;
  let minDiff = Math.abs(sortedStrikes[0] - spot);
  for (let i = 1; i < sortedStrikes.length; i++) {
    const diff = Math.abs(sortedStrikes[i] - spot);
    if (diff < minDiff) {
      minDiff = diff;
      closestIdx = i;
    }
  }

  const startIdx = Math.max(0, closestIdx - radius);
  const endIdx = Math.min(sortedStrikes.length - 1, closestIdx + radius);
  return sortedStrikes.slice(startIdx, endIdx + 1);
}

function buildGexSummaries(matrixViews, spot, metrics = null) {
  return gexAggregator.buildSummaries(matrixViews, spot, metrics);
}

function countManagedChainContracts(ticker, chainData, todayStr) {
  if (!chainData || !chainData.optionChains) return 0;
  const tickerChain = chainData.optionChains.find(
    c => c.symbol && c.symbol.toUpperCase() === ticker.toUpperCase()
  );
  if (!tickerChain || !tickerChain.chains) return 0;

  return tickerChain.chains.reduce((sum, group) => {
    const expirationStr = getOptionGroupExpiration(group);
    if (!isExpirationWithinDays(todayStr, expirationStr, 0, 14)) return sum;
    return sum + (group.calls || []).length + (group.puts || []).length;
  }, 0);
}

function needsStoreRebuild(ticker, chainData, todayStr) {
  const currentCount = store.getPositionMatrix(ticker).length;
  const chainCount = countManagedChainContracts(ticker, chainData, todayStr);
  if (chainCount === 0) return false;
  return currentCount === 0 || currentCount < chainCount * 0.25;
}

function rebuildTickerStoreFromChain(ticker, chainData, todayStr, state) {
  const existingTrades = Array.isArray(state && state.trades) ? state.trades : [];
  const beforeCount = store.getPositionMatrix(ticker).length;
  store.initializeChain(ticker, chainData, todayStr);
  existingTrades.forEach(trade => {
    store.applyTrade(ticker, trade, todayStr);
  });
  const afterCount = store.getPositionMatrix(ticker).length;
  logger.warn(`[LiveChain] Rebuilt ${ticker} position store from live chain. Contracts ${beforeCount} -> ${afterCount}, replayed ${existingTrades.length} trades.`);
}

function getPrimaryGexMetrics(gexSummary) {
  const all = gexSummary && gexSummary.all ? gexSummary.all : {};
  return {
    globalTotalGex: all.globalTotalGex || 0,
    realtimeTotalGex: all.realtimeTotalGex || 0,
    gexChange: all.gexChange || 0,
    globalCallWall: all.globalCallWall || null,
    globalPutWall: all.globalPutWall || null,
    globalZeroGamma: all.globalZeroGamma || null,
    realtimeCallWall: all.realtimeCallWall || null,
    realtimePutWall: all.realtimePutWall || null,
    realtimeZeroGamma: all.realtimeZeroGamma || null
  };
}

function formatDurationMs(ms) {
  return `${Math.max(0, Math.round(ms))}ms`;
}

function formatBytes(bytes) {
  const num = Number(bytes);
  if (!Number.isFinite(num) || num <= 0) return '0B';
  if (num >= 1024 * 1024) return `${(num / (1024 * 1024)).toFixed(2)}MB`;
  if (num >= 1024) return `${(num / 1024).toFixed(1)}KB`;
  return `${Math.round(num)}B`;
}

function formatTimingValue(key, value) {
  if (/bytes|contentlength/i.test(key)) return formatBytes(value);
  if (/contracts|calcs$/i.test(key)) return String(Math.round(Number(value) || 0));
  if (/attempts|fallbacks|hits|calls|reuse|invalidations/i.test(key)) return String(Math.round(Number(value) || 0));
  if (/iterations/i.test(key)) return `${(Number(value) || 0).toFixed(1)}`;
  if (/initial/i.test(key)) return `${((Number(value) || 0) * 100).toFixed(2)}%`;
  if (key === 'eventLoopUtilization') return `${((Number(value) || 0) * 100).toFixed(1)}%`;
  return formatDurationMs(value);
}

function formatTimingBreakdown(timings) {
  return Object.entries(timings)
    .map(([key, value]) => `${key}=${formatTimingValue(key, value)}`)
    .join(' ');
}

function enqueueHistoryWrite(ticker, historyPath, historySnapshot) {
  const uppercaseTicker = String(ticker || '').toUpperCase();
  const previousWrite = historyWriteQueues[uppercaseTicker] || Promise.resolve();

  const writeTask = previousWrite
    .catch(() => {})
    .then(async () => {
      const startedAt = Date.now();
      await fs.promises.writeFile(historyPath, JSON.stringify(historySnapshot, null, 2));
      logger.debug(`[HistoryWrite] ${uppercaseTicker} wrote ${historySnapshot.length} points in ${Date.now() - startedAt}ms`);
    })
    .catch(err => {
      logger.error(`[HistoryWrite] Failed to write history for ${uppercaseTicker}:`, err.message);
    });

  historyWriteQueues[uppercaseTicker] = writeTask;
  return writeTask;
}

function updateCursor(items) {
  let maxUpdated = lastUpdatedCursor;
  items.forEach(item => {
    const itemUpdated = parseInt(item.updated);
    if (!isNaN(itemUpdated) && itemUpdated > maxUpdated) {
      maxUpdated = itemUpdated;
    }
  });
  if (maxUpdated === lastUpdatedCursor) {
    lastUpdatedCursor += 1;
  } else {
    lastUpdatedCursor = maxUpdated;
  }
}

function pruneOptionChain(chainData, spot, todayStr) {
  if (!chainData || !chainData.optionChains || chainData.optionChains.length === 0) {
    return chainData;
  }
  const prunedOptionChains = chainData.optionChains.map(tc => {
    if (!tc || !tc.chains) return tc;
    const filteredChains = tc.chains.map(group => {
      const expirationDateStr = getOptionGroupExpiration(group);
      if (!expirationDateStr) return null;
      const diffDays = getExpirationDayDiff(todayStr, expirationDateStr);
      if (diffDays < 0 || diffDays > 14) {
        return null;
      }
      const allStrikes = [];
      const calls = group.calls || [];
      const puts = group.puts || [];
      calls.forEach(c => { if (!allStrikes.includes(c.strike)) allStrikes.push(c.strike); });
      puts.forEach(p => { if (!allStrikes.includes(p.strike)) allStrikes.push(p.strike); });
      allStrikes.sort((a, b) => a - b);
      if (allStrikes.length === 0) return null;

      const targetStrikes = getStrikesAroundSpot(allStrikes, spot, GEX_STRIKE_RADIUS);

      const pruneContracts = (contracts) => {
        if (!contracts) return [];
        return contracts
          .filter(c => targetStrikes.includes(c.strike))
          .map(c => ({
            symbol: c.symbol,
            strike: c.strike,
            bidPrice: parseFloat(c.bidPrice) || 0,
            askPrice: parseFloat(c.askPrice) || 0,
            openInterest: parseInt(c.openInterest, 10) || 0,
            volume: parseInt(c.volume, 10) || 0
          }));
      };
      return {
        expiration: group.expiration,
        mmy: group.mmy,
        calls: pruneContracts(calls),
        puts: pruneContracts(puts)
      };
    }).filter(g => g !== null);
    return {
      symbol: tc.symbol,
      chains: filteredChains
    };
  });
  return {
    optionChains: prunedOptionChains
  };
}

// ==========================================
// 4. 核心业务流程
// ==========================================

/**
 * 盘前游标以及各 Ticker 大单计数恢复初始化
 */
function initializeGlobalCursorAndCounts() {
  const todayStr = getEstDate();
  let maxUpdated = 0;

  knownSignalIds.clear();

  BUILTIN_TICKERS.forEach(ticker => {
    liveTickerCounts[ticker] = 0;

    const tradesPath = paths.tradesPath(todayStr, ticker);

    if (fs.existsSync(tradesPath)) {
      try {
        const existingTrades = JSON.parse(fs.readFileSync(tradesPath, 'utf8'));
        if (Array.isArray(existingTrades)) {
          let uniqueCount = 0;
          existingTrades.forEach(t => {
            if (t.id) {
              knownSignalIds.add(t.id);
              uniqueCount++;
              const u = parseInt(t.updated);
              if (!isNaN(u) && u > maxUpdated) maxUpdated = u;
            }
          });
          liveTickerCounts[ticker] = uniqueCount;
          logger.info(`[Init] Recovered ${uniqueCount} historical trades for ${ticker}`);
        }
      } catch (e) {
        logger.error(`[Init] Failed to load existing trades for ${ticker}:`, e);
      }
    }
  });

  if (maxUpdated > 0) {
    lastUpdatedCursor = maxUpdated;
    logger.info(`[Init] Global cursor recovered from existing trades: ${lastUpdatedCursor}`);
  } else {
    const getEstOffset = (dateStr) => {
      const date = new Date(dateStr + 'T12:00:00Z');
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric',
        hour12: false
      });
      const parts = formatter.formatToParts(date);
      const nyHour = parseInt(parts.find(p => p.type === 'hour').value);
      return 12 - nyHour;
    };
    const offset = getEstOffset(todayStr);
    const pad = (n) => String(n).padStart(2, '0');
    const estStartStr = `${todayStr}T09:20:00-${pad(offset)}:00`;
    const startOfDayDate = new Date(estStartStr);
    lastUpdatedCursor = Math.floor(startOfDayDate.getTime() / 1000);
    logger.info(`[Init] Global cursor initialized to start of today: ${lastUpdatedCursor}`);
  }
}

/**
 * 盘前初始化各 Ticker 专属的状态底盘（从已有文件中恢复数据，不执行冗余重算）
 */
async function initializeTicker(ticker) {
  ticker = ticker.toUpperCase();
  logger.info(`--- Starting LIVE tracker in background for ${ticker} ---`);

  const todayStr = getEstDate();
  const liveDir = paths.liveTickerDir(todayStr, ticker);
  if (!fs.existsSync(liveDir)) {
    fs.mkdirSync(liveDir, { recursive: true });
  }

  let chainData = null;
  const openChainPath = paths.openChainPath(todayStr, ticker);

  if (fs.existsSync(openChainPath)) {
    try {
      chainData = JSON.parse(await fs.promises.readFile(openChainPath, 'utf8'));
      logger.info(`Loaded existing open option chain for ${ticker} from ${openChainPath}`);
    } catch (e) {
      logger.error(`Failed to load existing open option chain:`, e);
    }
  }

  if (!chainData) {
    logger.info(`Fetching live option chain for ${ticker} from Benzinga API...`);
    try {
      const start = Date.now();
      chainData = await datacenter.fetchOpeningChain(ticker);
      await fs.promises.writeFile(openChainPath, JSON.stringify(chainData, null, 2));
      const duration = Date.now() - start;
      logger.info(`Successfully fetched and saved open option chain to ${openChainPath} in ${duration} ms`);
    } catch (err) {
      logger.error(`Failed to fetch option chain from API:`, err);
    }
  }

  let initialSpot = await getTickerSpotLive(ticker);

  const tradesPath = paths.tradesPath(todayStr, ticker);
  let existingTrades = [];
  if (fs.existsSync(tradesPath)) {
    try {
      existingTrades = JSON.parse(await fs.promises.readFile(tradesPath, 'utf8'));
      logger.info(`Loaded ${existingTrades.length} existing trades for ${ticker}`);
    } catch (e) {
      logger.error(`Failed to load trades.json:`, e);
    }
  }

  let existingHistory = [];
  const historyPath = paths.historyPath(todayStr, ticker);
  if (fs.existsSync(historyPath)) {
    try {
      existingHistory = JSON.parse(await fs.promises.readFile(historyPath, 'utf8'));
      logger.info(`Recovered ${existingHistory.length} history points for ${ticker}`);
    } catch (e) {
      logger.error(`Failed to load history.json:`, e);
    }
  }

  const state = tickerStates[ticker];
  state.trades = existingTrades;

  if (chainData) {
    store.initializeChain(ticker, chainData, todayStr);
    store.initializeIVs(ticker, initialSpot, pricingConfig.riskFreeRate, todayStr, '09:30:00');

    if (existingTrades.length > 0) {
      logger.info(`[Restore] Replaying ${existingTrades.length} trades to reconstruct flowPositionDelta for ${ticker}...`);
      existingTrades.forEach(trade => {
        store.applyTrade(ticker, trade, todayStr);
      });
      initialSpot = await getTickerSpotLive(ticker);
    }
  }

  state.spot = initialSpot;
  state.history = existingHistory;

  const estDetails = getEstTime();
  const timeNowStr = estDetails.timeStr;
  state.currentTimeSeconds = estDetails.seconds;

  if (chainData) {
    const finalMatrix = store.calculateMatrixGEX(ticker, initialSpot, pricingConfig.riskFreeRate, todayStr, clampTradingTime(timeNowStr));
    const matrixViews = buildExpiryViews(finalMatrix, todayStr);
    const gexSummary = buildGexSummaries(matrixViews, initialSpot);
    state.calculatedMatrix = finalMatrix;
    state.matrixViews = matrixViews;
    state.gexSummary = gexSummary;
    state.latestGex = getPrimaryGexMetrics(gexSummary);
  }
}

/**
 * 盘中大单轮询并异步持久化
 */
async function pollAndApplyTrades() {
  const todayStr = getEstDate();

  try {
    const data = await datacenter.fetchLiveTrades(lastUpdatedCursor);
    const items = data.option_activity;

    if (!Array.isArray(items) || items.length === 0) {
      return;
    }

    logger.info(`[LiveTrades] Fetched ${items.length} new signals from API.`);

    const builtinTrades = items.filter(t =>
      BUILTIN_TICKERS.includes(t.ticker.toUpperCase()) &&
      t.date === todayStr
    );

    if (builtinTrades.length === 0) {
      updateCursor(items);
      return;
    }

    const tradesByTicker = {};
    builtinTrades.forEach(trade => {
      const t = trade.ticker.toUpperCase();
      if (!knownSignalIds.has(trade.id)) {
        knownSignalIds.add(trade.id);
        if (!tradesByTicker[t]) tradesByTicker[t] = [];
        tradesByTicker[t].push(trade);
      }
    });

    const quotePrices = await fetchQuotePrices(Object.keys(tradesByTicker));

    for (const ticker of Object.keys(tradesByTicker)) {
      const newTrades = tradesByTicker[ticker];
      const q = getDividendYield(ticker);
      if (newTrades.length === 0) continue;

      logger.info(`[LiveTrades] Found ${newTrades.length} new unique trades for ${ticker}.`);

      liveTickerCounts[ticker] = (liveTickerCounts[ticker] || 0) + newTrades.length;

      const liveDir = paths.liveTickerDir(todayStr, ticker);
      if (!fs.existsSync(liveDir)) {
        fs.mkdirSync(liveDir, { recursive: true });
      }

      const state = tickerStates[ticker];
      if (state) {
        const mergedTrades = state.trades.concat(newTrades);
        newTrades.forEach(trade => {
          const applied = store.applyTrade(ticker, trade, todayStr);
          if (!applied) {
            return;
          }
          const tradeSpot = parseFloat(trade.underlying_price);
          if (Number.isFinite(quotePrices[ticker]) && quotePrices[ticker] > 0) {
            state.spot = quotePrices[ticker];
          } else if (Number.isFinite(tradeSpot) && tradeSpot > 0) {
            state.spot = tradeSpot;
          }

          const minRealtimeT = pricingConfig.minRealtimeTMinutes / (365 * 24 * 60);
          const T = Math.max(minRealtimeT, calculateT(todayStr, trade.time, trade.date_expiration));
          const strike = parseFloat(trade.strike_price);
          const type = String(trade.put_call || '').toUpperCase();
          const symbol = trade.option_symbol;

          let inferredIv = NaN;
          if (Number.isFinite(state.spot) && state.spot > 0 && Number.isFinite(strike) && strike > 0 && trade.midpoint && parseFloat(trade.midpoint) > 0) {
            const midpoint = parseFloat(trade.midpoint);
            inferredIv = calculateImpliedVolatility(
              state.spot,
              strike,
              T,
              pricingConfig.riskFreeRate,
              q,
              midpoint,
              type
            );
            if (!isNaN(inferredIv) && inferredIv > 0.0002) {
              if (store.store[ticker] && store.store[ticker][symbol]) {
                store.store[ticker][symbol].ivRealtime = inferredIv;
              }
            }
          }
        });
        state.trades = mergedTrades;
        await fs.promises.writeFile(paths.tradesPath(todayStr, ticker), JSON.stringify(state.trades, null, 2));
      }
    }

    updateCursor(items);

  } catch (err) {
    logger.error(`[LiveTrades] Error polling trades:`, err.message);
  }
}

/**
 * 盘中期权链报价获取、重算与历史点异步保存
 */
async function updateChainAndRecalculate(ticker, options = {}) {
  const updateStartedAt = Date.now();
  const timings = {};
  const eluStartedAt = performance.eventLoopUtilization();
  const todayStr = getEstDate();
  const state = tickerStates[ticker];
  if (!state) return;

  const historyPath = paths.historyPath(todayStr, ticker);

  logger.info(`[LiveChain] Updating options chain quotes and recalculating Greeks for ${ticker}...`);

  let chainData = null;
  let fetchChainStartedAt = Date.now();
  try {
    fetchChainStartedAt = Date.now();
    chainData = await datacenter.fetchLiveChain(ticker, { metrics: timings });
    timings.fetchChain = Date.now() - fetchChainStartedAt;
    // Snapshot persistence disabled: live chain data is only needed for in-memory recalculation.
    // const prunedChainData = pruneOptionChain(chainData, state.spot, todayStr);
    // const timeStr = getEstTime().timeStrCompact.substring(0, 4);
    // const snapDir = paths.optionSnapshotsDir(todayStr, ticker);
    // if (!fs.existsSync(snapDir)) {
    //   await fs.promises.mkdir(snapDir, { recursive: true });
    // }
    // const snapPath = paths.optionSnapshotPath(todayStr, ticker, timeStr);
    // await fs.promises.writeFile(snapPath, JSON.stringify(prunedChainData, null, 2));
  } catch (err) {
    timings.fetchChain = Date.now() - fetchChainStartedAt;
    logger.error(`[LiveChain] Error fetching options chain for ${ticker}:`, err.message);
  }

  const estDetails = getEstTime();
  const timeNowStr = estDetails.timeStr;
  state.currentTimeSeconds = estDetails.seconds;

  const fetchQuoteStartedAt = Date.now();
  const quotePrices = options.quotePromise
    ? await options.quotePromise
    : await fetchQuotePrices([ticker]);
  timings.fetchQuote = Date.now() - fetchQuoteStartedAt;
  if (quotePrices[ticker]) {
    state.spot = quotePrices[ticker];
  } else if (chainData) {
    const inferred = inferUnderlyingPrice(chainData);
    if (inferred) {
      state.spot = inferred;
    }
  }

  if (!state.spot) {
    logger.warn(`[LiveChain] No spot price available yet for ${ticker}, skipping calculations.`);
    return;
  }

  let rebuiltStore = false;
  if (chainData) {
    const storeUpdateStartedAt = Date.now();
    if (needsStoreRebuild(ticker, chainData, todayStr)) {
      rebuildTickerStoreFromChain(ticker, chainData, todayStr, state);
      rebuiltStore = true;
    }
    const updateStats = store.updateChainPrices(ticker, chainData, todayStr);
    timings.updateStore = Date.now() - storeUpdateStartedAt;
    timings.ivPriceInvalidations = updateStats.ivPriceInvalidations || 0;
    timings.ivPriceReuse = updateStats.ivPriceReuse || 0;
    if (updateStats && updateStats.inserted > 0) {
      logger.info(`[LiveChain] Upserted ${updateStats.inserted} missing contracts for ${ticker}; updated ${updateStats.updated}.`);
    }
  } else {
    logger.warn(`[LiveChain] No option chain data retrieved for ${ticker}. Greeks will be calculated using trade-inferred and cached IVs.`);
  }

  const clampedTimeNowStr = clampTradingTime(timeNowStr);
  const matrixStartedAt = Date.now();
  const finalMatrix = store.calculateMatrixGEX(ticker, state.spot, pricingConfig.riskFreeRate, todayStr, clampedTimeNowStr, 'all', { metrics: timings });
  timings.calculateMatrix = Date.now() - matrixStartedAt;

  const viewsStartedAt = Date.now();
  const matrixViews = buildExpiryViews(finalMatrix, todayStr);
  timings.buildViews = Date.now() - viewsStartedAt;

  const summaryStartedAt = Date.now();
  const gexSummary = buildGexSummaries(matrixViews, state.spot, timings);
  timings.buildSummaries = Date.now() - summaryStartedAt;
  state.calculatedMatrix = finalMatrix;
  state.matrixViews = matrixViews;
  state.gexSummary = gexSummary;
  state.latestGex = getPrimaryGexMetrics(gexSummary);

  const minuteStr = timeNowStr.substring(0, 5);
  const alignedSec = Math.floor(state.currentTimeSeconds / 60) * 60;

  const newHistoryPoint = {
    date: todayStr,
    time: minuteStr,
    sec: alignedSec,
    spot: state.spot,
    ...state.latestGex,
    gexData: gexSummary
  };

  const existingHistory = Array.isArray(state.history) ? state.history : [];
  const existingIdx = existingHistory.findIndex(h => h.time === minuteStr);
  if (existingIdx !== -1) {
    existingHistory[existingIdx] = newHistoryPoint;
  } else {
    existingHistory.push(newHistoryPoint);
  }

  existingHistory.sort((a, b) => a.sec - b.sec);

  const writeHistoryStartedAt = Date.now();
  state.history = existingHistory;
  enqueueHistoryWrite(ticker, historyPath, existingHistory.slice());
  timings.writeHistory = Date.now() - writeHistoryStartedAt;
  logger.info(`[LiveChain] Greeks recalculated for ${ticker}. Spot=$${state.spot}, History count: ${existingHistory.length}`);

  const pushStartedAt = Date.now();
  try {
    await gravityInternalClient.pushHistoryPoint({
      ticker,
      date: todayStr,
      point: newHistoryPoint
    });
    timings.pushGravity = Date.now() - pushStartedAt;
  } catch (e) {
    timings.pushGravity = Date.now() - pushStartedAt;
    logger.warn(`[GravityPush] Unexpected push error for ${ticker} ${minuteStr}: ${e.message}`);
  }

  timings.total = Date.now() - updateStartedAt;
  const elu = performance.eventLoopUtilization(eluStartedAt);
  timings.eventLoopUtilization = elu.utilization;
  const contractCounts = {
    all: finalMatrix.length,
    today: matrixViews['0dte'].length,
    weekly: matrixViews.weekly.length
  };
  const timingMessage = `[LiveChainTiming] ${ticker} contracts=${contractCounts.all} 0dte=${contractCounts.today} weekly=${contractCounts.weekly} history=${existingHistory.length} rebuiltStore=${rebuiltStore} ${formatTimingBreakdown(timings)}`;
  if (timings.total > 20000) {
    logger.warn(timingMessage);
  } else {
    logger.info(timingMessage);
  }
}

module.exports = {
  store,
  gexAggregator,
  sortedTickers,
  BUILTIN_TICKERS,
  tickerStates,
  liveTickerCounts,
  knownSignalIds,
  get lastUpdatedCursor() {
    return lastUpdatedCursor;
  },
  set lastUpdatedCursor(val) {
    lastUpdatedCursor = val;
  },
  initializeGlobalCursorAndCounts,
  initializeTicker,
  pollAndApplyTrades,
  updateChainAndRecalculate,
  getTickerSpotLive,
  buildExpiryViews,
  buildGexSummaries,
  getPrimaryGexMetrics
};
