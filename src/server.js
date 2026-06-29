/**
 * @file server.js
 * @description 主应用 Express 服务器与交易流实时采集计算器。
 * 对接 Benzinga 实时接口，提供盘中实时大单流采集与分钟级期权链 Greeks 重算服务，
 * 并支持日内历史走势的积累与局部回放。
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const dns = require('dns');

// 强制域名解析优先使用 IPv4，彻底避免因本地未配置 IPv6 路由导致 Node.js fetch 无限期挂起和等待超时
dns.setDefaultResultOrder('ipv4first');

// 导入核心计算引擎与共享工具
const { calculateImpliedVolatility } = require('./calculator/bsCalculator');
const { calculateT, clampTradingTime } = require('./utils/sharedUtils');
const pricingConfig = require('./config/pricingConfig');
const logger = require('./utils/logger')('server');

/**
 * 辅助工具：带超时控制与失败重试机制的 fetch 请求，支持 Connection: close 避免 keep-alive 假死
 */
async function fetchWithRetry(url, options = {}, timeout = 10000, maxRetries = 3, delay = 2000) {
  if (!options.headers) {
    options.headers = {};
  }
  // 显式禁用 Keep-Alive，防止被 API 服务器的防火墙半关闭挂起
  options.headers['Connection'] = 'close';

  for (let i = 0; i < maxRetries; i++) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      clearTimeout(id);
      return response;
    } catch (error) {
      clearTimeout(id);
      if (i === maxRetries - 1) {
        throw error;
      }
      logger.warn(`[API] Fetch failed/timeout for ${url}. Retrying in ${delay}ms... (${i + 1}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

const PositionStore = require('./store/positionStore');
const GexAggregator = require('./engine/gexAggregator');

const app = express();
const PORT = process.env.PORT || 3080;

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ==========================================
// 0. 时区兼容核心工具函数 (锁定美东时间 America/New_York)
// ==========================================
function getEstDateStr() {
  const nyDateStr = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
  const nyDate = new Date(nyDateStr);
  const yyyy = nyDate.getFullYear();
  const mm = String(nyDate.getMonth() + 1).padStart(2, '0');
  const dd = String(nyDate.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function getEstTimeDetails() {
  const nyDateStr = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
  const nyDate = new Date(nyDateStr);
  const hh = String(nyDate.getHours()).padStart(2, '0');
  const mm = String(nyDate.getMinutes()).padStart(2, '0');
  const ss = String(nyDate.getSeconds()).padStart(2, '0');
  return {
    timeStr: `${hh}:${mm}:${ss}`,
    timeStrCompact: `${hh}${mm}${ss}`,
    seconds: nyDate.getHours() * 3600 + nyDate.getMinutes() * 60 + nyDate.getSeconds()
  };
}

// ==========================================
// 1. 初始化量化计算组件
// ==========================================
const store = new PositionStore(pricingConfig);
const gexAggregator = new GexAggregator(pricingConfig);

// ==========================================
// 2. 常量定义与股票配置
// ==========================================
const BENZINGA_API_KEY = '2RiuR92vjytxS8r93w3c8WTpGSd3y9Gk';
const BENZINGA_COOKIE = 'benzinga_token=ut8v2gvljnpzk5krg0gw54kjgh7ohehy';
// const BENZINGA_COOKIE = 'benzinga_token=fk5s1g199nf3wo42044hmxlncepv2ss1';

// 提供常用的期权热门交易股票列表
const sortedTickers = [
  // { name: 'AAPL', count: 0 },
  // { name: 'NVDA', count: 0 },
  // { name: 'TSLA', count: 0 },
  { name: 'SPY', count: 0 },
  { name: 'QQQ', count: 0 },
  // { name: 'MSFT', count: 0 },
  // { name: 'AMZN', count: 0 },
  // { name: 'GOOGL', count: 0 },
  // { name: 'META', count: 0 },
  // { name: 'AMD', count: 0 },
  { name: 'MU', count: 0 },
  // { name: 'INTC', count: 0 },
];

const BUILTIN_TICKERS = sortedTickers.map(t => t.name.toUpperCase());
const GEX_STRIKE_RADIUS = 20;
const liveTickerCounts = {};
const knownSignalIds = new Set();
let lastUpdatedCursor = 0;

function getDividendYield(ticker) {
  return pricingConfig.dividendYieldByTicker[String(ticker || '').toUpperCase()] || 0;
}

function initializeGlobalCursorAndCounts() {
  const todayStr = getEstDateStr();
  let maxUpdated = 0;

  // 跨天清空大单 ID 去重集合，防止内存无限累加
  knownSignalIds.clear();

  BUILTIN_TICKERS.forEach(ticker => {
    liveTickerCounts[ticker] = 0;

    const liveDir = path.join(__dirname, '../data/live_data', todayStr, ticker);
    const tradesPath = path.join(liveDir, 'trades.json');

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
    // 修复时区偏差导致游标初始化到前一天的问题
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
    // 将游标起点修改为美东开盘前准备时间（09:20:00），更符合期权无盘前交易的特性
    const estStartStr = `${todayStr}T09:20:00-${pad(offset)}:00`;
    const startOfDayDate = new Date(estStartStr);
    lastUpdatedCursor = Math.floor(startOfDayDate.getTime() / 1000);
    logger.info(`[Init] Global cursor initialized to start of today: ${lastUpdatedCursor}`);
  }
}

// 立即执行全局初始化
initializeGlobalCursorAndCounts();

// ==========================================
// 3. 并发监控状态容器与定时器字典
// ==========================================
const tickerStates = {};
const chainTimers = {};
let globalTradeTimer = null;
let currentSystemRegime = 'IDLE'; // IDLE (休眠), PREPARING (开盘前准备 09:20~09:30), TRADING (交易中 09:30~16:00)

// 初始化所有内置标的的状态容器
BUILTIN_TICKERS.forEach(ticker => {
  tickerStates[ticker] = {
    ticker: ticker,
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
});

// ==========================================
// 4. 辅助与实时采集核心函数
// ==========================================

function secondsToTimeString(sec) {
  const h = Math.floor(sec / 3600).toString().padStart(2, '0');
  const m = Math.floor((sec % 3600) / 60).toString().padStart(2, '0');
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function timeStringToSeconds(timeStr) {
  const [h, m, s] = timeStr.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}



/**
 * 根据平价公式 (Put-Call Parity) 从期权链的报价中高精度反推标的资产的股价 S
 * S = C - P + K
 */
function inferUnderlyingPrice(chainData) {
  if (!chainData || !chainData.optionChains || chainData.optionChains.length === 0) {
    return null;
  }
  const tickerChain = chainData.optionChains[0];
  if (!tickerChain || !tickerChain.chains || tickerChain.chains.length === 0) {
    return null;
  }

  // 选取到期日最短的分组，其 T 最小，贴现因子影响近乎为 0
  const group = tickerChain.chains[0];
  const calls = group.calls || [];
  const puts = group.puts || [];

  const putMap = {};
  puts.forEach(p => {
    putMap[p.strike] = p;
  });

  const spotEstimates = [];

  calls.forEach(c => {
    const k = c.strike;
    const p = putMap[k];
    if (p) {
      // 必须双方合约都有有效的买卖报价，防止垃圾合约干扰
      if (c.bidPrice > 0 && c.askPrice > 0 && p.bidPrice > 0 && p.askPrice > 0) {
        const C = (c.bidPrice + c.askPrice) / 2;
        const P = (p.bidPrice + p.askPrice) / 2;
        const S = C - P + k;
        spotEstimates.push(S);
      }
    }
  });

  if (spotEstimates.length === 0) {
    return null;
  }

  // 对估计值进行排序，取中位数（Median）以规避异常报价的干扰
  spotEstimates.sort((a, b) => a - b);
  const mid = Math.floor(spotEstimates.length / 2);
  return spotEstimates.length % 2 !== 0 ?
    spotEstimates[mid] :
    (spotEstimates[mid - 1] + spotEstimates[mid]) / 2;
}

/**
 * 整合期权链反推与大单历史，高精度获取指定标的当前的 Spot 股价
 */
function getTickerSpot(ticker) {
  ticker = ticker.toUpperCase();
  const todayStr = getEstDateStr();
  const liveDir = path.join(__dirname, '../data/live_data', todayStr, ticker);

  let spot = null; // 默认备用值

  // 1. 从期权链反推
  const openChainPath = path.join(liveDir, 'optionchains_open.json');
  if (fs.existsSync(openChainPath)) {
    try {
      const chainData = JSON.parse(fs.readFileSync(openChainPath, 'utf8'));
      const inferred = inferUnderlyingPrice(chainData);
      if (inferred) spot = inferred;
    } catch (e) { }
  }

  // 2. 从已有大单历史提取最后一笔成交的正股价格进行纠偏
  const tradesPath = path.join(liveDir, 'trades.json');
  if (fs.existsSync(tradesPath)) {
    try {
      const trades = JSON.parse(fs.readFileSync(tradesPath, 'utf8'));
      if (trades.length > 0) {
        const lastTrade = trades[trades.length - 1];
        spot = parseFloat(lastTrade.underlying_price) || spot;
      }
    } catch (e) { }
  }

  return spot;
}

function extractTipRanksSpot(quote) {
  if (!quote) return null;

  const regularPrice = parseFloat(quote.price);

  if (!isNaN(regularPrice) && regularPrice > 0) {
    return regularPrice;
  }
  return null;
}

async function fetchTipRanksQuotePrices(tickers) {
  const uniqueTickers = [...new Set((tickers || [])
    .map(t => String(t || '').trim().toUpperCase())
    .filter(Boolean))];

  if (uniqueTickers.length === 0) {
    return {};
  }

  const params = new URLSearchParams({
    app_name: 'tr',
    v: '2',
    tickers: uniqueTickers.join(',')
  });
  const url = `https://marketsv3.tipranks.com/api/quotes/GetQuotes?${params.toString()}`;

  try {
    const res = await fetchWithRetry(url, { headers: { 'Accept': 'application/json' } }, 8000, 2, 1000);
    if (res.status !== 200) {
      logger.warn(`[Quotes] TipRanks returned status ${res.status} for ${uniqueTickers.join(',')}`);
      return {};
    }

    const data = await res.json();
    const prices = {};
    if (data && Array.isArray(data.quotes)) {
      data.quotes.forEach(quote => {
        const ticker = String(quote.ticker || '').toUpperCase();
        const spot = extractTipRanksSpot(quote);
        if (ticker && spot) {
          prices[ticker] = spot;
        }
      });
    }
    return prices;
  } catch (err) {
    logger.warn(`[Quotes] Failed to fetch TipRanks quotes for ${uniqueTickers.join(',')}: ${err.message}`);
    return {};
  }
}

async function getTickerSpotLive(ticker) {
  const uppercaseTicker = String(ticker || '').toUpperCase();
  const quotePrices = await fetchTipRanksQuotePrices([uppercaseTicker]);
  return quotePrices[uppercaseTicker] || getTickerSpot(uppercaseTicker);
}

/**
 * 从已排序的行权价列表中裁剪出最接近 spot 价格的指定数量的行权价（上下各 N 个）
 */
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

function filterMatrixByExpiry(matrix, currentDateStr, expiryFilter = 'all') {
  if (expiryFilter === 'all') return matrix || [];
  return (matrix || []).filter(contract => {
    const expDate = new Date(contract.expiration + 'T00:00:00-04:00');
    const curDate = new Date(currentDateStr + 'T00:00:00-04:00');
    const diffDays = Math.round((expDate - curDate) / (1000 * 60 * 60 * 24));
    if (expiryFilter === '0dte') return diffDays === 0;
    if (expiryFilter === 'weekly') return diffDays >= 1 && diffDays <= 5;
    return true;
  });
}

function buildExpiryViews(matrix, currentDateStr) {
  return {
    all: matrix || [],
    '0dte': filterMatrixByExpiry(matrix, currentDateStr, '0dte'),
    weekly: filterMatrixByExpiry(matrix, currentDateStr, 'weekly')
  };
}

function buildGexSummaries(matrixViews, spot) {
  return gexAggregator.buildSummaries(matrixViews, spot);
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

function getGexMetricsForExpiry(historyPoint, expiry = 'all') {
  const expiryGex = historyPoint && historyPoint.gexData && historyPoint.gexData[expiry];
  const source = expiryGex || {};
  const globalTotalGex = Number(source.globalTotalGex) || 0;
  const realtimeTotalGex = Number(source.realtimeTotalGex) || 0;
  const sourceGexChange = Number(source.gexChange);
  return {
    globalTotalGex,
    realtimeTotalGex,
    gexChange: Number.isFinite(sourceGexChange) ? sourceGexChange : realtimeTotalGex - globalTotalGex,
    globalCallWall: source.globalCallWall || null,
    globalPutWall: source.globalPutWall || null,
    globalZeroGamma: source.globalZeroGamma || null,
    realtimeCallWall: source.realtimeCallWall || null,
    realtimePutWall: source.realtimePutWall || null,
    realtimeZeroGamma: source.realtimeZeroGamma || null
  };
}

/**
 * 断点高精度时序回补：利用 trades.json 和期权定价反推，重建缺失的分钟走势数据
 */
function backfillHistoryPoints(ticker, existingTrades, existingHistory) {
  const todayStr = getEstDateStr();
  const q = getDividendYield(ticker);
  const historyMinutes = new Set(existingHistory.map(h => h.time));

  // 1. 将 trades 按时间排序
  const sortedTrades = [...(existingTrades || [])].sort((a, b) => {
    return timeStringToSeconds(a.time) - timeStringToSeconds(b.time);
  });

  const firstTradeSec = sortedTrades.length > 0 ? timeStringToSeconds(sortedTrades[0].time) : 9.5 * 3600;
  const startSec = Math.max(9.5 * 3600, Math.floor(firstTradeSec / 60) * 60); // 从 09:30 或第一个大单时间开始
  const currentSec = getEstTimeDetails().seconds;
  const endSec = Math.min(16.0 * 3600, currentSec); // 截止到当前时间或收盘

  // 2. 重置该标的在做市商持仓里的数据并重新载入底座，用于从头重演
  if (store.store[ticker]) {
    store.store[ticker] = {};
  }

  const liveDir = path.join(__dirname, '../data/live_data', todayStr, ticker);
  const openChainPath = path.join(liveDir, 'optionchains_open.json');
  let chainData = null;
  if (fs.existsSync(openChainPath)) {
    try {
      chainData = JSON.parse(fs.readFileSync(openChainPath, 'utf8'));
      store.initializeChain(ticker, chainData, todayStr);
    } catch (e) { }
  }

  // 加载该标的所有已存的期权链快照
  const snapMap = {};
  const snapDir = path.join(liveDir, 'optionchains');
  if (fs.existsSync(snapDir)) {
    try {
      const files = fs.readdirSync(snapDir);
      files.forEach(file => {
        const match = file.match(/^snap_(\d{4})\d*\.json$/);
        if (match) {
          const hhmm = match[1];
          snapMap[hhmm] = path.join(snapDir, file);
        }
      });
    } catch (e) {
      logger.error(`[Backfill] Failed to read snap files:`, e);
    }
  }

  // 如果大单为空且没有任何快照，则不需要回补
  if (sortedTrades.length === 0 && Object.keys(snapMap).length === 0) {
    return {
      historyPoints: existingHistory
    };
  }

  const newHistory = [...existingHistory];
  let tradeIdx = 0;
  let lastKnownSpot = getTickerSpot(ticker);

  // 3. 以分钟为单位循环重演并生成缺失的数据点
  for (let sec = startSec; sec <= endSec; sec += 60) {
    const hh = Math.floor(sec / 3600).toString().padStart(2, '0');
    const mm = Math.floor((sec % 3600) / 60).toString().padStart(2, '0');
    const timeStr = `${hh}:${mm}`;

    // 将此分钟之前发生的所有大单应用到持仓中，并使用交易中点价反推修正 IV
    while (tradeIdx < sortedTrades.length && timeStringToSeconds(sortedTrades[tradeIdx].time) <= sec) {
      const trade = sortedTrades[tradeIdx];
      lastKnownSpot = parseFloat(trade.underlying_price) || lastKnownSpot;

      store.applyTrade(ticker, trade);

      // 反推该合约在交易时刻的实时 IV
      let inferredIv = NaN;
      if (trade.midpoint && parseFloat(trade.midpoint) > 0) {
        const T = calculateT(todayStr, trade.time, trade.date_expiration);
        const midpoint = parseFloat(trade.midpoint);
        const strike = parseFloat(trade.strike_price);

        inferredIv = calculateImpliedVolatility(
          lastKnownSpot,
          strike,
          T,
          pricingConfig.riskFreeRate,
          q,
          midpoint,
          trade.put_call.toUpperCase()
        );
          if (!isNaN(inferredIv) && inferredIv > 0.0002) {
            if (store.store[ticker] && store.store[ticker][trade.option_symbol]) {
              store.store[ticker][trade.option_symbol].ivRealtime = inferredIv;
            }
          }
      }
      tradeIdx++;
    }

    // 检查此分钟点是否有快照期权链。如果有，使用期权链进行更新并修正 S
    const hhmmStr = hh + mm;
    const snapPathForMinute = snapMap[hhmmStr];
    let hasSnapshotForMinute = false;
    if (snapPathForMinute && fs.existsSync(snapPathForMinute)) {
      try {
        const minuteChainData = JSON.parse(fs.readFileSync(snapPathForMinute, 'utf8'));
        store.updateChainPrices(ticker, minuteChainData);
        const inferredSpot = inferUnderlyingPrice(minuteChainData);
        if (inferredSpot) {
          lastKnownSpot = inferredSpot;
        }
        hasSnapshotForMinute = true;
      } catch (e) {
        logger.error(`[Backfill] Failed to update chain prices from snap file ${snapPathForMinute}:`, e);
      }
    }

    // 检查此分钟点在已存历史里是否存在，若不存在则进行回补计算
    if (historyMinutes.has(timeStr)) {
      continue;
    }

    // 执行 Greeks/GEX 生成并加入历史（即使没有今日的开盘 chainData，只要 store 里面有合约就行）
    // clamp：收盘后(>= 16:00)统一用 15:59:50，防止 T=0 导致 GEX 全部归零
    const calcTimeStr = clampTradingTime(`${timeStr}:00`);
    const finalMatrix = store.calculateMatrixGEX(ticker, lastKnownSpot, pricingConfig.riskFreeRate, todayStr, calcTimeStr);
    if (finalMatrix && finalMatrix.length > 0) {
      const matrixViews = buildExpiryViews(finalMatrix, todayStr);
      const gexSummary = buildGexSummaries(matrixViews, lastKnownSpot);
      const latestGex = getPrimaryGexMetrics(gexSummary);

      const newPoint = {
        time: timeStr,
        sec: sec,
        spot: lastKnownSpot,
        ...latestGex,
        gexData: gexSummary
      };

      newHistory.push(newPoint);
      logger.info(`[Backfill] Generated history point for ${ticker} at ${timeStr} (${hasSnapshotForMinute ? 'Snapshot Chain' : 'Inferred / Replayed'}), Spot=$${lastKnownSpot}`);
    }
  }

  // 4. 对 history 数据进行最终的整分去重与对齐保护，清洗可能残留的重复分钟点
  const uniqueHistoryMap = {};
  newHistory.forEach(h => {
    const alignedSec = Math.floor(h.sec / 60) * 60;
    h.sec = alignedSec;
    uniqueHistoryMap[h.time] = h;
  });

  return {
    historyPoints: Object.values(uniqueHistoryMap).sort((a, b) => a.sec - b.sec)
  };
}

/**
 * 实时监控与计算管理器
 */
async function startLiveTracker(ticker) {
  ticker = ticker.toUpperCase();
  logger.info(`--- Starting LIVE tracker in background for ${ticker} ---`);

  // 1. 清除已有定时器
  if (chainTimers[ticker]) clearInterval(chainTimers[ticker]);
  chainTimers[ticker] = null;

  // 2. 准备目录
  const todayStr = getEstDateStr();
  const liveDir = path.join(__dirname, '../data/live_data', todayStr, ticker);
  if (!fs.existsSync(liveDir)) {
    fs.mkdirSync(liveDir, { recursive: true });
  }

  // 3. 期权链初始化（底盘）
  let chainData = null;
  const openChainPath = path.join(liveDir, 'optionchains_open.json');

  if (fs.existsSync(openChainPath)) {
    try {
      chainData = JSON.parse(fs.readFileSync(openChainPath, 'utf8'));
      logger.info(`Loaded existing open option chain for ${ticker} from ${openChainPath}`);
    } catch (e) {
      logger.error(`Failed to load existing open option chain:`, e);
    }
  }

  if (!chainData) {
    logger.info(`Fetching live option chain for ${ticker} from Benzinga API...`);
    try {
      const start = Date.now();
      const url = `https://data-api.benzinga.com/rest/v1/optionchain?apikey=${BENZINGA_API_KEY}&symbols=${ticker}`;
      const res = await fetchWithRetry(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      }, 10000); // 10秒超时
      if (res.status === 200) {
        chainData = await res.json();
        fs.writeFileSync(openChainPath, JSON.stringify(chainData, null, 2));
        const duration = Date.now() - start;
        logger.info(`Successfully fetched and saved open option chain to ${openChainPath} in ${duration} ms`);
      } else {
        logger.error(`Failed to fetch option chain, status = ${res.status}, duration: ${Date.now() - start} ms`);
      }
    } catch (err) {
      logger.error(`Failed to fetch option chain from API:`, err);
    }
  }

  // 获取今日的初始 Spot 价格
  let initialSpot = await getTickerSpotLive(ticker);

  // 4. 读取本地已存大单
  const tradesPath = path.join(liveDir, 'trades.json');
  let existingTrades = [];
  if (fs.existsSync(tradesPath)) {
    try {
      existingTrades = JSON.parse(fs.readFileSync(tradesPath, 'utf8'));
      logger.info(`Loaded ${existingTrades.length} existing trades for ${ticker}`);
    } catch (e) {
      logger.error(`Failed to load trades.json:`, e);
    }
  }

  // 5. 初始化/恢复历史曲线
  let existingHistory = [];
  const historyPath = path.join(liveDir, 'history.json');
  if (fs.existsSync(historyPath)) {
    try {
      existingHistory = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
      logger.info(`Recovered ${existingHistory.length} history points for ${ticker}`);
    } catch (e) {
      logger.error(`Failed to load history.json:`, e);
    }
  }

  // 6. 初始化该 Ticker 的状态容器
  const state = tickerStates[ticker];
  state.trades = existingTrades;

  // 6. 恢复历史大单，重建今天的 flow-adjusted 模型持仓并执行断点历史回补
  if (chainData) {
    if (existingTrades.length > 0) {
      logger.info(`[Backfill] Replaying and backfilling missing history for ${ticker}...`);
      const backfillResult = backfillHistoryPoints(ticker, existingTrades, existingHistory);
      existingHistory = backfillResult.historyPoints;
      fs.writeFileSync(historyPath, JSON.stringify(existingHistory, null, 2));
      initialSpot = await getTickerSpotLive(ticker);
    } else {
      store.initializeChain(ticker, chainData, todayStr);
      store.initializeIVs(ticker, initialSpot, pricingConfig.riskFreeRate, todayStr, '09:30:00');
    }
  }

  state.spot = initialSpot;
  state.history = existingHistory;

  const estDetails = getEstTimeDetails();
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

  // 7. 启动该 Ticker 专属的 20 秒 Greeks 轮询定时器（仅在交易时间段内启动）
  if (currentSystemRegime === 'TRADING') {
    if (chainTimers[ticker]) clearInterval(chainTimers[ticker]);
    chainTimers[ticker] = setInterval(async () => {
      await pollLiveChainAndCalculate(ticker);
    }, 20000);
    logger.info(`[Scheduler] Live Greeks poll timer started for ${ticker}`);
  } else {
    logger.info(`[Scheduler] Live Greeks poll timer suspended for ${ticker} (Current state: ${currentSystemRegime})`);
  }
}

/**
 * 定时获取大单增量并应用
 */
async function pollLiveTrades() {
  const todayStr = getEstDateStr();

  const params = new URLSearchParams({
    pagesize: 200,
    'parameters[updated]': lastUpdatedCursor,
    'parameters[dateSearchField]': 'target'
  });
  const url = `https://api.benzinga.com/api/v1/signal/option_activity?${params.toString()}`;

  try {
    const response = await fetchWithRetry(url, {
      headers: {
        'Accept': 'application/json',
        'Cookie': BENZINGA_COOKIE,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    }, 10000); // 10秒超时

    if (response.status !== 200) {
      logger.warn(`[LiveTrades] Fetch failed with status = ${response.status}`);
      return;
    }

    const data = await response.json();
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

    const quotePrices = await fetchTipRanksQuotePrices(Object.keys(tradesByTicker));
    let hasNewSelectedTickerTrades = false;

    for (const ticker of Object.keys(tradesByTicker)) {
      const newTrades = tradesByTicker[ticker];
      const q = getDividendYield(ticker);
      if (newTrades.length === 0) continue;

      logger.info(`[LiveTrades] Found ${newTrades.length} new unique trades for ${ticker}.`);

      liveTickerCounts[ticker] = (liveTickerCounts[ticker] || 0) + newTrades.length;

      const liveDir = path.join(__dirname, '../data/live_data', todayStr, ticker);
      if (!fs.existsSync(liveDir)) {
        fs.mkdirSync(liveDir, { recursive: true });
      }
      const tradesPath = path.join(liveDir, 'trades.json');
      let existingTrades = [];
      if (fs.existsSync(tradesPath)) {
        try {
          existingTrades = JSON.parse(fs.readFileSync(tradesPath, 'utf8'));
        } catch (e) { }
      }
      const finalTrades = existingTrades.concat(newTrades);
      fs.writeFileSync(tradesPath, JSON.stringify(finalTrades, null, 2));

      const state = tickerStates[ticker];
      if (state) {
        newTrades.forEach(trade => {
          const applied = store.applyTrade(ticker, trade, todayStr);
          if (!applied) {
            return; // 跳过此交易
          }
          state.spot = quotePrices[ticker] || parseFloat(trade.underlying_price) || state.spot;
          state.trades.push(trade);

          const T = calculateT(todayStr, trade.time, trade.date_expiration);
          const strike = parseFloat(trade.strike_price);
          const type = trade.put_call.toUpperCase();
          const symbol = trade.option_symbol;

          // 盘中实时大单 IV 反推修正
          let inferredIv = NaN;
          if (trade.midpoint && parseFloat(trade.midpoint) > 0) {
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
      }
    }

    updateCursor(items);

  } catch (err) {
    logger.error(`[LiveTrades] Error polling trades:`, err.message);
  }
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

/**
 * 过滤与裁剪实时期权链快照数据，去除未使用的冗余字段，只保留两周内平值附近的核心字段
 */
function pruneOptionChain(chainData, spot, todayStr) {
  if (!chainData || !chainData.optionChains || chainData.optionChains.length === 0) {
    return chainData;
  }
  const prunedOptionChains = chainData.optionChains.map(tc => {
    if (!tc || !tc.chains) return tc;
    const filteredChains = tc.chains.map(group => {
      // 1. 过滤到期日，只保留两星期内 (14天) 的期权
      const expirationDateStr = group.expiration || (group.mmy ? `${group.mmy.substring(0, 4)}-${group.mmy.substring(4, 6)}-${group.mmy.substring(6, 8)}` : null);
      if (!expirationDateStr) return null;
      const expDate = new Date(expirationDateStr + 'T00:00:00-04:00');
      const curDate = new Date(todayStr + 'T00:00:00-04:00');
      const diffDays = Math.round((expDate - curDate) / (1000 * 60 * 60 * 24));
      if (diffDays < 0 || diffDays > 14) {
        return null;
      }
      // 2. 找出当前到期日的所有 unique strikes，准备按 Python 脚本同样的半径裁剪
      const allStrikes = [];
      const calls = group.calls || [];
      const puts = group.puts || [];
      calls.forEach(c => { if (!allStrikes.includes(c.strike)) allStrikes.push(c.strike); });
      puts.forEach(p => { if (!allStrikes.includes(p.strike)) allStrikes.push(p.strike); });
      allStrikes.sort((a, b) => a - b);
      if (allStrikes.length === 0) return null;

      // 寻找最接近 spot 价格的 strike 进行上下裁剪
      const targetStrikes = getStrikesAroundSpot(allStrikes, spot, GEX_STRIKE_RADIUS);

      // 3. 过滤并精简字段，保留核心所需的 6 个字段 (含成交量与持仓量)
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

/**
 * 每分钟请求期权链，更新报价，重算 Greeks 并保存 history
 */
async function pollLiveChainAndCalculate(ticker) {
  const todayStr = getEstDateStr();
  const state = tickerStates[ticker];
  if (!state) return;
  const liveDir = path.join(__dirname, '../data/live_data', todayStr, ticker);
  const historyPath = path.join(liveDir, 'history.json');

  logger.info(`[LiveChain] Updating options chain quotes and recalculating Greeks for ${ticker}...`);

  let chainData = null;
  try {
    const url = `https://data-api.benzinga.com/rest/v1/optionchain?apikey=${BENZINGA_API_KEY}&symbols=${ticker}`;
    const res = await fetchWithRetry(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
    }, 10000); // 10秒超时
    if (res.status === 200) {
      chainData = await res.json();
      // 对拉取到的期权链执行高压裁剪，只保留当前 Spot 附近的核心 Strike 以及包含 OI/Volume 的 6 个核心字段
      const prunedChainData = pruneOptionChain(chainData, state.spot, todayStr);
      // 格式化为 HHMM（例如 1030），使其在同一分钟内的多次抓取自动覆盖写在同一个 snap_HHMM.json 文件中
      const timeStr = getEstTimeDetails().timeStrCompact.substring(0, 4);
      const snapPath = path.join(liveDir, `optionchains/snap_${timeStr}.json`);
      fs.mkdirSync(path.join(liveDir, 'optionchains'), { recursive: true });
      fs.writeFileSync(snapPath, JSON.stringify(prunedChainData, null, 2));
    } else {
      logger.warn(`[LiveChain] Fetch option chain failed for ${ticker}, status = ${res.status}`);
    }
  } catch (err) {
    logger.error(`[LiveChain] Error fetching options chain for ${ticker}:`, err.message);
  }

  if (chainData) {
    store.updateChainPrices(ticker, chainData);
  } else {
    logger.warn(`[LiveChain] No option chain data retrieved for ${ticker}. Greeks will be calculated using trade-inferred and cached IVs.`);
  }



  const estDetails = getEstTimeDetails();
  const timeNowStr = estDetails.timeStr;
  state.currentTimeSeconds = estDetails.seconds;

  const quotePrices = await fetchTipRanksQuotePrices([ticker]);
  if (quotePrices[ticker]) {
    state.spot = quotePrices[ticker];
  } else if (chainData) {
    const inferred = inferUnderlyingPrice(chainData);
    if (inferred) {
      state.spot = inferred;
    }
  }

  // Bug #15: 防御 spot 为 null
  if (!state.spot) {
    logger.warn(`[LiveChain] No spot price available yet for ${ticker}, skipping calculations.`);
    return;
  }

  // clamp：收盘后(>= 16:00)统一用 15:59:50，防止 T=0 导致 GEX 全部归零
  const clampedTimeNowStr = clampTradingTime(timeNowStr);
  const finalMatrix = store.calculateMatrixGEX(ticker, state.spot, pricingConfig.riskFreeRate, todayStr, clampedTimeNowStr);
  const matrixViews = buildExpiryViews(finalMatrix, todayStr);
  const gexSummary = buildGexSummaries(matrixViews, state.spot);
  state.calculatedMatrix = finalMatrix;
  state.matrixViews = matrixViews;
  state.gexSummary = gexSummary;
  state.latestGex = getPrimaryGexMetrics(gexSummary);

  let existingHistory = [];
  if (fs.existsSync(historyPath)) {
    try {
      existingHistory = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    } catch (e) { }
  }

  const minuteStr = timeNowStr.substring(0, 5); // 例如 "18:52"
  const alignedSec = Math.floor(state.currentTimeSeconds / 60) * 60; // 对齐整分秒数，例如 67920

  const newHistoryPoint = {
    time: minuteStr,
    sec: alignedSec,
    spot: state.spot,
    ...state.latestGex,
    gexData: gexSummary
  };

  // 检查是否已有这一分钟的记录。如果有，直接更新/覆盖，避免重复点；没有则 push 新增
  const existingIdx = existingHistory.findIndex(h => h.time === minuteStr);
  if (existingIdx !== -1) {
    existingHistory[existingIdx] = newHistoryPoint;
  } else {
    existingHistory.push(newHistoryPoint);
  }

  // 排序，保证历史按秒数递增
  existingHistory.sort((a, b) => a.sec - b.sec);

  fs.writeFileSync(historyPath, JSON.stringify(existingHistory, null, 2));

  state.history = existingHistory;
  logger.info(`[LiveChain] Greeks recalculated for ${ticker}. Spot=$${state.spot}, History count: ${existingHistory.length}`);
}

// 获取当前应处的美东时间市场阶段
function getEstRequiredRegime() {
  const nyDateStr = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
  const nyDate = new Date(nyDateStr);
  const day = nyDate.getDay(); // 0=周日, 6=周六, 1-5=周一至周五

  // 周末不进行任何请求，保持休眠
  if (day === 0 || day === 6) {
    return 'IDLE';
  }

  const hours = nyDate.getHours();
  const minutes = nyDate.getMinutes();
  const totalSeconds = hours * 3600 + minutes * 60 + nyDate.getSeconds();

  const startPrepare = 9 * 3600 + 20 * 60; // 09:20:00 (开盘前10分钟)
  const startTrading = 9 * 3600 + 30 * 60; // 09:30:00 (开盘)
  const endTrading = 16 * 3600;            // 16:00:00 (收盘)

  if (totalSeconds >= startPrepare && totalSeconds < startTrading) {
    return 'PREPARING';
  } else if (totalSeconds >= startTrading && totalSeconds < endTrading) {
    return 'TRADING';
  } else {
    return 'IDLE';
  }
}

// 停止所有 API 轮询定时器，安全进入休眠
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

// 仅获取最新期权链做基础数据准备，不开启 Greeks 轮询
async function prepareBaseDataOnly() {
  logger.info(`[Scheduler] Pre-market (09:20). Preparing base option chains concurrently...`);
  await Promise.all(BUILTIN_TICKERS.map(async (ticker) => {
    try {
      await startLiveTracker(ticker);
    } catch (e) {
      logger.error(`[Scheduler] Pre-market init failed for ${ticker}:`, e.message);
    }
  }));
}

// 开启盘中高频轮询（如果尚未初始化则热启动初始化）
async function startTradingPolls() {
  logger.info(`[Scheduler] Market open! Starting live metrics and trades polling...`);

  // 1. 确保所有标的基础数据已被拉取并初始化（处理开盘中途启动或热启动情况）
  for (const ticker of BUILTIN_TICKERS) {
    const liveDir = path.join(__dirname, '../data/live_data', getEstDateStr(), ticker);
    const openChainPath = path.join(liveDir, 'optionchains_open.json');
    if (!tickerStates[ticker].latestGex || !fs.existsSync(openChainPath)) {
      try {
        logger.info(`[Scheduler] Ticker ${ticker} not initialized, fetching now...`);
        await startLiveTracker(ticker);
      } catch (e) {
        logger.error(`[Scheduler] Failed to initialize ${ticker}:`, e.message);
      }
    }
  }

  // 2. 为每个 Ticker 挂载专属 20s Greeks 轮询定时器
  BUILTIN_TICKERS.forEach(ticker => {
    if (!chainTimers[ticker]) {
      logger.info(`[Scheduler] Starting live Greeks timer for ${ticker} (20s interval)`);
      chainTimers[ticker] = setInterval(async () => {
        await pollLiveChainAndCalculate(ticker);
      }, 20000);
    }
  });

  // 3. 挂载全局 15s 大单采集定时器
  if (!globalTradeTimer) {
    logger.info(`[Scheduler] Starting live trades timer (15s interval)`);
    globalTradeTimer = setInterval(async () => {
      await pollLiveTrades();
    }, 15000);
  }
}

// 全局状态流转控制调度核心
async function updateSystemRegime() {
  const requiredRegime = getEstRequiredRegime();
  if (requiredRegime === currentSystemRegime) {
    return;
  }

  logger.info(`[Scheduler] System state transition: ${currentSystemRegime} => ${requiredRegime}`);
  currentSystemRegime = requiredRegime;

  if (requiredRegime === 'PREPARING') {
    // 新的一天准备阶段开始，重新执行全局游标、计数器和去重 Set 的干净初始化
    initializeGlobalCursorAndCounts();
    await prepareBaseDataOnly();
  } else if (requiredRegime === 'TRADING') {
    await startTradingPolls();
  } else if (requiredRegime === 'IDLE') {
    stopAllPolls();
  }
}

// 挂载全局 10 秒时间段状态流转校验器
setInterval(async () => {
  try {
    await updateSystemRegime();
  } catch (e) {
    logger.error(`[Scheduler] Error during updateSystemRegime execution:`, e);
  }
}, 10000);

// 服务器拉起时，对所有标的初始化加载本地数据
async function initializeAllTickers() {
  logger.info(`[Init] Performing initial load for all tickers...`);
  for (const ticker of BUILTIN_TICKERS) {
    try {
      await startLiveTracker(ticker);
    } catch (e) {
      logger.error(`[Init] Failed to perform initial load for ${ticker}:`, e.message);
    }
  }
}

// 服务器拉起时立即运行一次调度检验。
// PREPARING/TRADING 分支会按需初始化；IDLE/周末不创建当天数据目录。
(async () => {
  await updateSystemRegime();
})();

// ==========================================
// 5. RESTful API 接口实现
// ==========================================

// 获取支持的 Ticker 列表
app.get('/api/tickers', (req, res) => {
  const result = sortedTickers.map(t => {
    const ticker = t.name.toUpperCase();
    const liveCount = liveTickerCounts[ticker] || 0;
    return {
      name: t.name,
      count: liveCount > 0 ? liveCount : getLatestTradesCountForTicker(ticker)
    };
  });
  res.json(result);
});





// 获取当前模拟状态与决策报告
app.get('/api/state', async (req, res) => {
  const ticker = (req.query.ticker || 'AAPL').toUpperCase();
  const state = getTickerState(ticker);
  if (state) {
    if (!state.latestGex || !state.history || state.history.length === 0) {
      const latestHistory = getLatestHistoryForTicker(ticker);
      if (latestHistory.history.length > 0) {
        const lastPoint = latestHistory.history[latestHistory.history.length - 1];
        state.history = latestHistory.history;
        state.spot = lastPoint.spot || state.spot;
        state.latestGex = getPrimaryGexMetrics(lastPoint.gexData) || state.latestGex;
        if (lastPoint.gexData) {
          state.gexSummary = lastPoint.gexData;
        }
      }
    }

    const quotePrices = await fetchTipRanksQuotePrices([ticker]);
    if (quotePrices[ticker]) {
      state.spot = quotePrices[ticker];
    }
  }
  res.json(getClientState(ticker));
});



// 获取指定标的最近有历史数据的日期
function getLatestTradeDateWithData(ticker) {
  const liveDataRoot = path.join(__dirname, '../data/live_data');
  if (!fs.existsSync(liveDataRoot)) return null;

  try {
    const dates = fs.readdirSync(liveDataRoot)
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort((a, b) => b.localeCompare(a)); // 降序，最新的在前面

    for (const dateStr of dates) {
      const tickerDir = path.join(liveDataRoot, dateStr, ticker);
      const openChainPath = path.join(tickerDir, 'optionchains_open.json');
      if (fs.existsSync(openChainPath)) {
        return dateStr;
      }
    }
  } catch (e) {
    logger.error(`[GEX API] Error finding latest trade date for ${ticker}:`, e);
  }
  return null;
}

function safeReadJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    logger.warn(`[Cache] Failed to read JSON cache ${filePath}: ${e.message}`);
    return fallback;
  }
}

function getLatestHistoryForTicker(ticker) {
  const latestDateStr = getLatestTradeDateWithData(ticker);
  if (!latestDateStr) {
    return { date: null, history: [] };
  }

  const historyPath = path.join(__dirname, '../data/live_data', latestDateStr, ticker, 'history.json');
  const history = safeReadJson(historyPath, []);
  return {
    date: latestDateStr,
    history: Array.isArray(history) ? history : []
  };
}

function getLatestTradesCountForTicker(ticker) {
  const latestDateStr = getLatestTradeDateWithData(ticker);
  if (!latestDateStr) return 0;

  const tradesPath = path.join(__dirname, '../data/live_data', latestDateStr, ticker, 'trades.json');
  const trades = safeReadJson(tradesPath, []);
  return Array.isArray(trades) ? trades.length : 0;
}

// 获取当前的 GEX 柱状图数据
app.get('/api/gex', async (req, res) => {
  const ticker = (req.query.ticker || 'AAPL').toUpperCase();
  const expiry = req.query.expiry || 'all';
  const todayStr = getEstDateStr();
  const emptySummary = {
    strikes: [],
    realtimeStrikeGexMillions: [],
    globalStrikeGexMillions: [],
    realtimeCallWall: null,
    realtimePutWall: null,
    realtimeZeroGamma: null,
    globalCallWall: null,
    globalPutWall: null,
    globalZeroGamma: null
  };

  const state = getTickerState(ticker);
  if (!state) {
    return res.json(emptySummary);
  }

  let spot = state.spot;
  const isMarketClosed = state.currentTimeSeconds >= 16 * 3600 || currentSystemRegime === 'IDLE';

  if (state.gexSummary && state.gexSummary[expiry] && state.gexSummary[expiry].strikes && state.gexSummary[expiry].strikes.length > 0) {
    return res.json(state.gexSummary[expiry]);
  }

  if (isMarketClosed) {
    const latestHistory = getLatestHistoryForTicker(ticker);
    if (latestHistory.history.length > 0) {
      const lastPoint = latestHistory.history[latestHistory.history.length - 1];
      if (lastPoint.gexData && lastPoint.gexData[expiry]) {
        logger.info(`[GEX API] Returned cached ${expiry} GEX from ${latestHistory.date} history for ${ticker}.`);
        return res.json(lastPoint.gexData[expiry]);
      }
    }
  }

  if (state.calculatedMatrix && state.calculatedMatrix.length > 0) {
    const matrixViews = buildExpiryViews(state.calculatedMatrix, todayStr);
    state.matrixViews = matrixViews;
    state.gexSummary = buildGexSummaries(matrixViews, spot);
    return res.json(state.gexSummary[expiry] || emptySummary);
  }

  return res.json(emptySummary);
});

// 获取历史走势
app.get('/api/history', (req, res) => {
  const ticker = (req.query.ticker || 'AAPL').toUpperCase();
  const expiry = req.query.expiry || 'all';

  const state = tickerStates[ticker];
  let historyPoints = [];
  let historyDate = getLatestTradeDateWithData(ticker);
  if (state) {
    historyPoints = state.history;
    if (!historyPoints || historyPoints.length === 0) {
      const latestHistory = getLatestHistoryForTicker(ticker);
      historyPoints = latestHistory.history;
      historyDate = latestHistory.date || historyDate;
      if (historyPoints.length > 0) {
        state.history = historyPoints;
        const lastPoint = historyPoints[historyPoints.length - 1];
        state.spot = lastPoint.spot || state.spot;
        state.latestGex = getPrimaryGexMetrics(lastPoint.gexData) || state.latestGex;
        if (lastPoint.gexData) {
          state.gexSummary = lastPoint.gexData;
        }
      }
    }
  } else {
    const latestHistory = getLatestHistoryForTicker(ticker);
    historyPoints = latestHistory.history;
    historyDate = latestHistory.date || historyDate;
  }

  const formattedHistory = historyPoints.map(h => {
    const expiryMetrics = getGexMetricsForExpiry(h, expiry);
    return {
      time: h.time,
      date: h.date || historyDate,
      sec: h.sec,
      spot: h.spot,
      ...expiryMetrics,
      gexData: h.gexData
    };
  });
  res.json(formattedHistory);
});

/**
 * 辅助函数：安全获取指定标的的状态容器，带有兜底退路防崩溃机制
 */
function getTickerState(ticker) {
  const defaultTicker = (BUILTIN_TICKERS && BUILTIN_TICKERS[0]) ? BUILTIN_TICKERS[0] : 'SPY';
  ticker = (ticker || defaultTicker).toUpperCase();
  let state = tickerStates[ticker];
  if (!state) {
    state = tickerStates[defaultTicker];
  }
  if (!state) {
    const keys = Object.keys(tickerStates);
    if (keys.length > 0) {
      state = tickerStates[keys[0]];
    }
  }
  return state;
}

/**
 * 包装过滤给前端的状态数据
 */
function getClientState(ticker) {
  const defaultTicker = (BUILTIN_TICKERS && BUILTIN_TICKERS[0]) ? BUILTIN_TICKERS[0] : 'SPY';
  ticker = (ticker || defaultTicker).toUpperCase();
  let state = tickerStates[ticker];
  if (!state) {
    state = tickerStates[defaultTicker];
  }
  if (!state) {
    const keys = Object.keys(tickerStates);
    if (keys.length > 0) {
      state = tickerStates[keys[0]];
    }
  }
  if (!state) {
    return {
      selectedTicker: ticker,
      isRunning: false,
      currentTime: '09:30:00',
      currentTimePct: 0,
      speedMultiplier: 1,
      spot: 0,
      latestGex: null
    };
  }
  return {
    selectedTicker: state.ticker,
    isRunning: state.isRunning,
    currentTime: secondsToTimeString(state.currentTimeSeconds),
    currentTimePct: ((state.currentTimeSeconds - 9.5 * 3600) / (6.5 * 3600)) * 100,
    speedMultiplier: 1,
    spot: state.spot,
    latestGex: state.latestGex
  };
}

// 启动 Express 监听并加载宏观日历
app.listen(PORT, async () => {
  logger.info(`==========================================`);
  logger.info(`GEX Structure Engine is running at:`);
  logger.info(`http://localhost:${PORT}`);
  logger.info(`==========================================`);
});
