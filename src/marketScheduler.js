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
const economicCalendarRegime = require('./economicCalendarRegime');
const paths = require('./paths');
const { BUILTIN_TICKERS } = require('./tickerConfig');

const { getEstDate, getEstParts } = timeUtils;
const {
  tickerStates,
  initializeGlobalCursorAndCounts,
  initializeTicker,
  pollAndApplyTrades,
  updateChainAndRecalculate
} = gexService;

// 定时器与状态容器
const chainTimers = {};
let globalTradeTimer = null;
let regimeTimer = null;
let currentSystemRegime = 'IDLE'; // IDLE (休眠), PREPARING (开盘前准备 09:20~09:30), TRADING (交易中 09:30~16:00)
let liveDataCleanupDate = null;

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
  BUILTIN_TICKERS.forEach(ticker => {
    if (chainTimers[ticker]) {
      clearInterval(chainTimers[ticker]);
      chainTimers[ticker] = null;
    }
  });
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

  entries.forEach(entry => {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name) || entry.name === todayStr) {
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

  // 2. 为每个 Ticker 分配专属的 20秒 期权链与 Greeks 计算定时器
  BUILTIN_TICKERS.forEach(ticker => {
    if (!chainTimers[ticker]) {
      logger.info(`[Scheduler] Starting live Greeks timer for ${ticker} (20s interval)`);
      chainTimers[ticker] = setInterval(async () => {
        await updateChainAndRecalculate(ticker);
      }, 20000);
    }
  });

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
