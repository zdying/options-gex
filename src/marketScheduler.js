/**
 * @file marketScheduler.js
 * @description 交易市场状态机调度器。
 * 负责根据美东时间维护市场运行状态 (IDLE / PREPARING / TRADING)，
 * 并管理盘中大单流与期权链快照的定时轮询。
 */

const fs = require('fs');
const logger = require('./utils/logger')('scheduler');
const timeUtils = require('./utils/timeUtils');
const gexService = require('./gexService');
const datacenter = require('./datacenter');
const economicCalendarRegime = require('./economicCalendarRegime');
const paths = require('./paths');
const { BUILTIN_TICKERS } = require('./tickerConfig');

const { getEstDate, getEstParts } = timeUtils;
const { fetchQuotePrices } = datacenter;
const {
  tickerStates,
  initializeGlobalCursorAndCounts,
  initializeTicker,
  pollAndApplyTrades,
  updateChainAndRecalculate
} = gexService;

// 定时器与状态容器
const chainUpdateStatus = {};
let globalTradeTimer = null;
let liveChainRoundTimer = null;
let liveChainRoundRunning = false;
let liveChainRoundSeq = 0;
let regimeTimer = null;
let currentSystemRegime = 'IDLE'; // IDLE (休眠), PREPARING (开盘前准备 09:20~09:30), TRADING (交易中 09:30~16:00)
let liveDataCleanupDate = null;
const LIVE_CHAIN_ROUND_INTERVAL_MS = 20000;
const LIVE_CHAIN_CONCURRENCY = 3;

/**
 * 获取宏观 Regime
 */
async function getCurrentRegime() {
  return economicCalendarRegime.getCurrentRegime();
}

/**
 * 计算当前应该处于的市场阶段
 * @returns {'IDLE' | 'PREPARING' | 'TRADING'}
 */
function getEstRequiredRegime() {
  // return 'TRADING';
  const parts = getEstParts();
  const day = new Date(`${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}T00:00:00Z`).getUTCDay(); // 0=周日, 6=周六, 1-5=周一至周五

  // 周末保持休眠
  if (day === 0 || day === 6) {
    return 'IDLE';
  }

  const totalSeconds = parts.hour * 3600 + parts.minute * 60 + parts.second;

  const startPrepare = 9 * 3600 + 20 * 60; // 09:20:00 (开盘前准备)
  const startTrading = 9 * 3600 + 30 * 60; // 09:30:00 (正式开盘)
  const endTrading = 16 * 3600;            // 16:00:00 (收盘)

  if (totalSeconds >= startPrepare && totalSeconds < startTrading) {
    return 'PREPARING';
  } else if (totalSeconds >= startTrading && totalSeconds < endTrading) {
    return 'TRADING';
  } else {
    return 'IDLE';
  }
}

/**
 * 停止所有的盘中轮询定时器
 */
function stopAllPolls() {
  logger.info(`[Scheduler] Market closed or weekend. Stopping all live timers...`);
  if (globalTradeTimer) {
    clearInterval(globalTradeTimer);
    globalTradeTimer = null;
  }
  if (liveChainRoundTimer) {
    clearTimeout(liveChainRoundTimer);
    liveChainRoundTimer = null;
  }
  liveChainRoundRunning = false;
  BUILTIN_TICKERS.forEach(ticker => {
    if (chainUpdateStatus[ticker]) {
      chainUpdateStatus[ticker].pending = false;
    }
  });
}

async function runQueuedChainUpdate(ticker, options = {}) {
  const status = chainUpdateStatus[ticker] || { running: false, pending: false };
  chainUpdateStatus[ticker] = status;

  if (status.running) {
    status.pending = true;
    return;
  }

  status.running = true;
  try {
    do {
      status.pending = false;
      await updateChainAndRecalculate(ticker, options);
    } while (status.pending);
  } catch (e) {
    logger.error(`[Scheduler] Live Greeks update failed for ${ticker}:`, e.message);
  } finally {
    status.running = false;
  }
}

async function runWithConcurrency(items, limit, worker) {
  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);

  async function runWorker() {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      await worker(item);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
}

async function runLiveChainRound() {
  const quoteStartedAt = Date.now();
  const quotePromise = fetchQuotePrices(BUILTIN_TICKERS)
    .then(prices => {
      const duration = Date.now() - quoteStartedAt;
      const priceSummary = BUILTIN_TICKERS
        .map(ticker => `${ticker}=${prices[ticker] || 'N/A'}`)
        .join(' ');
      logger.info(`[Scheduler] Batch quote fetched ${Object.keys(prices).length}/${BUILTIN_TICKERS.length} tickers in ${duration}ms: ${priceSummary}`);
      return prices;
    })
    .catch(err => {
      logger.warn(`[Scheduler] Batch quote fetch failed: ${err.message}`);
      return {};
    });

  await runWithConcurrency(BUILTIN_TICKERS, LIVE_CHAIN_CONCURRENCY, ticker =>
    runQueuedChainUpdate(ticker, { quotePromise })
  );
}

async function runLiveChainRoundAndScheduleNext() {
  if (currentSystemRegime !== 'TRADING' || liveChainRoundRunning) {
    return;
  }

  liveChainRoundTimer = null;
  liveChainRoundRunning = true;
  liveChainRoundSeq += 1;
  const roundSeq = liveChainRoundSeq;
  const startedAt = Date.now();
  logger.info(`[Scheduler] ===== Live chain round #${roundSeq} START tickers=${BUILTIN_TICKERS.length} chainConcurrency=${LIVE_CHAIN_CONCURRENCY} =====`);

  try {
    await runLiveChainRound();
  } catch (e) {
    logger.error(`[Scheduler] Live chain round failed:`, e.message);
  } finally {
    liveChainRoundRunning = false;
  }

  if (currentSystemRegime !== 'TRADING') {
    return;
  }

  const elapsed = Date.now() - startedAt;
  const delay = Math.max(0, LIVE_CHAIN_ROUND_INTERVAL_MS - elapsed);
  logger.info(`[Scheduler] ===== Live chain round #${roundSeq} END elapsed=${elapsed}ms nextIn=${delay}ms =====`);
  liveChainRoundTimer = setTimeout(runLiveChainRoundAndScheduleNext, delay);
}

function startLiveChainRoundLoop() {
  if (liveChainRoundTimer || liveChainRoundRunning) {
    return;
  }
  logger.info(`[Scheduler] Starting live Greeks round loop (${LIVE_CHAIN_ROUND_INTERVAL_MS}ms target interval, ${LIVE_CHAIN_CONCURRENCY} chain concurrency)`);
  liveChainRoundTimer = setTimeout(runLiveChainRoundAndScheduleNext, 0);
}

function cleanupOldLiveData(todayStr) {
  if (liveDataCleanupDate === todayStr) {
    return;
  }

  if (!fs.existsSync(paths.LIVE_DATA_ROOT)) {
    liveDataCleanupDate = todayStr;
    return;
  }

  let entries = [];
  try {
    entries = fs.readdirSync(paths.LIVE_DATA_ROOT, { withFileTypes: true });
  } catch (e) {
    logger.error(`[Scheduler] Failed to read live data root for cleanup:`, e.message);
    return;
  }

  liveDataCleanupDate = todayStr;
  const retentionCutoff = new Date(`${todayStr}T00:00:00Z`);
  retentionCutoff.setUTCMonth(retentionCutoff.getUTCMonth() - 1);

  entries.forEach(entry => {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) {
      return;
    }

    const entryDate = new Date(`${entry.name}T00:00:00Z`);
    if (!Number.isFinite(entryDate.getTime()) || entryDate >= retentionCutoff) {
      return;
    }

    const oldLiveDir = paths.liveDateDir(entry.name);
    try {
      fs.rmSync(oldLiveDir, { recursive: true, force: true });
      logger.info(`[Scheduler] Removed old live data directory: ${oldLiveDir}`);
    } catch (e) {
      logger.error(`[Scheduler] Failed to remove old live data directory ${oldLiveDir}:`, e.message);
    }
  });
}

/**
 * 仅获取开盘期权链数据作为基底，不启动 Greeks 高频计算
 */
async function prepareBaseDataOnly() {
  logger.info(`[Scheduler] Pre-market (09:20). Preparing base option chains concurrently...`);
  await Promise.all(BUILTIN_TICKERS.map(async (ticker) => {
    try {
      await initializeTicker(ticker);
    } catch (e) {
      logger.error(`[Scheduler] Pre-market init failed for ${ticker}:`, e.message);
    }
  }));
}

/**
 * 开启盘中高频轮询定时器
 */
async function startTradingPolls() {
  logger.info(`[Scheduler] Market open! Starting live metrics and trades polling...`);

  // 1. 确保所有内置标的的数据在此前已正确初始化
  for (const ticker of BUILTIN_TICKERS) {
    const openChainPath = paths.openChainPath(getEstDate(), ticker);
    if (!tickerStates[ticker].latestGex || !fs.existsSync(openChainPath)) {
      try {
        logger.info(`[Scheduler] Ticker ${ticker} not initialized, fetching now...`);
        await initializeTicker(ticker);
      } catch (e) {
        logger.error(`[Scheduler] Failed to initialize ${ticker}:`, e.message);
      }
    }
  }

  // 2. 启动全局 20秒目标间隔的 Greeks 轮询；每轮批量拉 quote，期权链最多 5 个并发。
  startLiveChainRoundLoop();

  // 3. 开启全局 15秒 大单流拉取定时器
  if (!globalTradeTimer) {
    logger.info(`[Scheduler] Starting live trades timer (15s interval)`);
    globalTradeTimer = setInterval(async () => {
      await pollAndApplyTrades();
    }, 15000);
  }
}

/**
 * 全局状态流转控制核心
 */
async function updateSystemRegime() {
  const requiredRegime = getEstRequiredRegime();
  if (requiredRegime === currentSystemRegime) {
    return;
  }

  logger.info(`[Scheduler] System state transition: ${currentSystemRegime} => ${requiredRegime}`);
  const previousRegime = currentSystemRegime;
  currentSystemRegime = requiredRegime;

  if (requiredRegime === 'PREPARING') {
    cleanupOldLiveData(getEstDate());
    initializeGlobalCursorAndCounts();
    await prepareBaseDataOnly();
  } else if (requiredRegime === 'TRADING') {
    cleanupOldLiveData(getEstDate());
    if (previousRegime !== 'PREPARING') {
      initializeGlobalCursorAndCounts();
    }
    await startTradingPolls();
  } else if (requiredRegime === 'IDLE') {
    stopAllPolls();
  }
}

async function runRegimeCheck() {
  try {
    await updateSystemRegime();
  } catch (e) {
    logger.error(`[Scheduler] Error during updateSystemRegime execution:`, e);
  }
}

function start() {
  if (regimeTimer) {
    return;
  }

  regimeTimer = setInterval(runRegimeCheck, 10000);
  runRegimeCheck();
}

function stop() {
  if (regimeTimer) {
    clearInterval(regimeTimer);
    regimeTimer = null;
  }
  stopAllPolls();
}

module.exports = {
  getCurrentRegime,
  start,
  stop,
  get currentSystemRegime() {
    return currentSystemRegime;
  }
};
