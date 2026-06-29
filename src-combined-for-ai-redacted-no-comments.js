;"FILE: src/calculator/bsCalculator.js";
function standardNormalPDF(x) {
  return Math.exp(-x * x / 2.0) / Math.sqrt(2.0 * Math.PI);
}
function standardNormalCDF(x) {
  if (x < 0) {
    return 1.0 - standardNormalCDF(-x);
  }
  const p = 0.2316419;
  const a1 = 0.319381530;
  const a2 = -0.356563782;
  const a3 = 1.781477937;
  const a4 = -1.821255978;
  const a5 = 1.330274429;
  const t = 1.0 / (1.0 + p * x);
  const pdf = standardNormalPDF(x);
  return 1.0 - pdf * (
    a1 * t + 
    a2 * Math.pow(t, 2) + 
    a3 * Math.pow(t, 3) + 
    a4 * Math.pow(t, 4) + 
    a5 * Math.pow(t, 5)
  );
}
function calculateBSPrice(S, K, T, r, sigma, optionType) {
  const isCall = optionType.toUpperCase() === 'CALL';
  if (T <= 0) {
    return isCall ? Math.max(0, S - K) : Math.max(0, K - S);
  }
  if (sigma <= 0) {
    const discount = Math.exp(-r * T);
    return isCall ? Math.max(0, S - K * discount) : Math.max(0, K * discount - S);
  }
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2.0) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  const discountFactor = Math.exp(-r * T);
  if (isCall) {
    return S * standardNormalCDF(d1) - K * discountFactor * standardNormalCDF(d2);
  } else {
    return K * discountFactor * standardNormalCDF(-d2) - S * standardNormalCDF(-d1);
  }
}
function calculateImpliedVolatility(S, K, T, r, marketPrice, optionType, config = {}) {
  const maxIterations = config.maxIterations || 100;
  const precision = config.precision || 1e-5;
  const fallbackIV = config.fallbackIV !== undefined ? config.fallbackIV : 0.20;
  if (T <= 0 || isNaN(T)) {
    return fallbackIV;
  }
  const isCall = optionType.toUpperCase() === 'CALL';
  const discountFactor = Math.exp(-r * T);
  const intrinsicValue = isCall 
    ? Math.max(0, S - K * discountFactor)
    : Math.max(0, K * discountFactor - S);
  if (marketPrice <= intrinsicValue + 1e-4) {
    return 0.0001; 
  }
  let lowIV = 0.0001;
  let highIV = 5.0; 
  let midIV = fallbackIV;
  for (let i = 0; i < maxIterations; i++) {
    midIV = (lowIV + highIV) / 2.0;
    const price = calculateBSPrice(S, K, T, r, midIV, optionType);
    if (Math.abs(price - marketPrice) < precision) {
      return midIV;
    }
    if (price < marketPrice) {
      lowIV = midIV;
    } else {
      highIV = midIV;
    }
  }
  return midIV;
}
function calculateBSGreeks(S, K, T, r, sigma, optionType, config = {}) {
  const isCall = optionType.toUpperCase() === 'CALL';
  const minVolSqT = config.minVolSqT !== undefined ? config.minVolSqT : 0.0002;
  if (T <= 0 || isNaN(T) || sigma <= 1e-4) {
    const delta = isCall 
      ? (S >= K ? 1.0 : 0.0) 
      : (S <= K ? -1.0 : 0.0);
    return { delta, gamma: 0, charm: 0, vanna: 0 };
  }
  const sqrtT = Math.sqrt(T);
  const volSqT = Math.max(minVolSqT, sigma * sqrtT);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2.0) * T) / volSqT;
  const d2 = d1 - volSqT;
  const pdfD1 = standardNormalPDF(d1);
  const cdfD1 = standardNormalCDF(d1);
  const delta = isCall ? cdfD1 : cdfD1 - 1.0;
  let gamma = pdfD1 / (S * volSqT);
  const safeT = Math.max(15 / (365 * 24 * 60), T); 
  const safeVolSqT = Math.max(minVolSqT, sigma * Math.sqrt(safeT));
  const atmGamma = standardNormalPDF(0) / (S * safeVolSqT);
  const gammaLimit = atmGamma * 5.0;
  gamma = Math.min(gamma, gammaLimit);
  const term1 = d2 / (2.0 * Math.max(1e-6, T));
  const term2 = r / volSqT;
  const charm = pdfD1 * (term1 - term2);
  const vanna = -pdfD1 * d2 / Math.max(1e-4, sigma);
  return {
    delta,
    gamma,
    charm,
    vanna
  };
}
module.exports = {
  standardNormalPDF,
  standardNormalCDF,
  calculateBSPrice,
  calculateImpliedVolatility,
  calculateBSGreeks
};
;"FILE: src/engine/aggregator.js";
class Aggregator {
  constructor(config = {}) {
    this.dS_pct = config.dS_pct !== undefined ? config.dS_pct : 0.005; 
    this.dt_years = config.dt_years !== undefined ? config.dt_years : 30 / (365 * 24 * 60); 
    this.dIV = config.dIV !== undefined ? config.dIV : -0.01; 
  }
  aggregatePressure(calculatedMatrix, spot) {
    let totalGamma = 0;
    let totalCharm = 0;
    let totalVanna = 0;
    calculatedMatrix.forEach(contract => {
      const pos = contract.dealerPosition; 
      const gamma = contract.gamma;
      const charm = contract.charm;
      const vanna = contract.vanna;
      if (!isNaN(pos) && !isNaN(gamma) && !isNaN(charm) && !isNaN(vanna)) {
        totalGamma += pos * 100 * gamma;
        totalCharm += pos * 100 * charm;
        totalVanna += pos * 100 * vanna;
      }
    });
    const dS = spot * this.dS_pct;
    const dt = this.dt_years;
    const dIV = this.dIV;
    const gammaPressure = -totalGamma * dS;
    const charmPressure = -totalCharm * dt;
    const vannaPressure = -totalVanna * dIV;
    const dealerPressure = gammaPressure + charmPressure + vannaPressure;
    const dealerNotional = dealerPressure * spot;
    return {
      totalGamma,
      totalCharm,
      totalVanna,
      gammaPressure,
      charmPressure,
      vannaPressure,
      dealerPressure,
      dealerNotional
    };
  }
}
module.exports = Aggregator;
;"FILE: src/engine/decisionEngine.js";
const { findStructureWalls } = require('../utils/sharedUtils');
class DecisionEngine {
  constructor() {}
  generateReport(inputs) {
    const {
      spot,
      vwap,
      influenceScore,
      influenceRegime,
      calculatedMatrix,
      dpi,
      aggPressure,
      verification
    } = inputs;
    const walls = this._findStructureWalls(calculatedMatrix);
    const notionalUSD = aggPressure.dealerNotional;
    const notionalText = `${(notionalUSD / 1e8).toFixed(2)} 亿美元`;
    let bias = 'NEUTRAL (观望)';
    if (dpi > 20 && notionalUSD > 0) {
      bias = 'BULLISH (做市商被迫买入驱动)';
    } else if (dpi < -20 && notionalUSD < 0) {
      bias = 'BEARISH (做市商被迫卖出驱动)';
    }
    let dynamicEffect = '震荡无趋势';
    if (spot > vwap) {
      dynamicEffect = notionalUSD > 0 ? '上涨容易加速' : '上涨容易减速';
    } else if (spot < vwap) {
      dynamicEffect = notionalUSD < 0 ? '下跌容易雪崩' : '下跌容易被缓冲';
    }
    const conclusion = this._generateConclusionText({
      influenceScore,
      influenceRegime,
      bias,
      walls,
      spot,
      dpi,
      notionalText,
      verification,
      dynamicEffect
    });
    return {
      timestamp: new Date().toISOString(),
      spot,
      vwap,
      dealerInfluence: {
        score: influenceScore,
        regime: influenceRegime
      },
      structureWalls: walls,
      pressureMetrics: {
        dpi,
        dealerNotionalUSD: notionalUSD,
        dealerNotionalText: notionalText
      },
      verification: verification,
      bias,
      dynamicEffect,
      conclusion
    };
  }
  _findStructureWalls(calculatedMatrix) {
    return findStructureWalls(calculatedMatrix, 'gex');
  }
  _generateConclusionText(data) {
    const {
      influenceScore,
      influenceRegime,
      bias,
      walls,
      spot,
      dpi,
      notionalText,
      verification,
      dynamicEffect
    } = data;
    let text = `【做市商压力决策报告】\n`;
    text += `1. 定价权分析：当前模式为 ${influenceRegime}，定价权得分为 ${influenceScore}。说明做市商模型对当前市场具有${influenceScore >= 80 ? '极强' : (influenceScore >= 50 ? '中等' : '偏弱')}的定价解释力。\n`;
    text += `2. 阻力支撑图：\n`;
    text += `   - Call Wall (上行强阻力位)：${walls.callWall || '无'}\n`;
    text += `   - Put Wall (下行强支撑位)：${walls.putWall || '无'}\n`;
    text += `   - Zero Gamma (多空分水岭)：${walls.zeroGamma || '无'}\n`;
    text += `   - 当前现价 (Spot)：${spot.toFixed(2)}\n`;
    text += `3. 对冲动能评估：\n`;
    text += `   - 大单压力指数 (DPI)：${dpi.toFixed(2)} (${dpi > 0 ? '买盘对冲倾斜' : '卖盘对冲倾斜'})\n`;
    text += `   - 压力测试对冲名义额 (做市商敏感度)：${notionalText} (标准场景敏感度)\n`;
    text += `4. 趋势验证：\n`;
    text += `   - 价格匹配状态：${verification.reason}\n`;
    text += `   - 加速度状态：[${dynamicEffect}]\n`;
    text += `5. 核心交易策略结论：\n`;
    if (influenceScore < 50) {
      text += `   - ⚠️ 今日属于主动资金流支配（Flow Dominated）模式，做市商模型可能暂时失效。建议忽略期权墙，跟随趋势线操作。`;
    } else if (verification.status === 'EFFECTIVE') {
      if (bias.includes('BULLISH')) {
        text += `   - 🚀 做市商被迫买入驱动生效！上行通道打开，第一目标位看向 Call Wall: ${walls.callWall || '上方'}。适合顺势看多。`;
      } else if (bias.includes('BEARISH')) {
        text += `   - 📉 做市商被迫卖出驱动生效！下行雪崩风险较高，第一目标位看向 Put Wall: ${walls.putWall || '下方'}。适合顺势看空或套保。`;
      } else {
        text += `   - ⚖️ 市场处于震荡筑底/盘整，未见显著方向性偏离。`;
      }
    } else {
      text += `   - ⏳ 做市商对冲流被主动资金对抗中，模型暂时未被市场兑现。建议密切观察现价对 VWAP 的突破方向。`;
    }
    return text;
  }
}
module.exports = DecisionEngine;
;"FILE: src/engine/flowProcessor.js";
const { determineTradeDirection } = require('../utils/sharedUtils');
class FlowProcessor {
  constructor(config = {}) {
    this.recentShocks = [];
    this.maxRecentSize = 100;
    this.historicalRawDpis = [];
    this.maxHistorySize = config.maxHistorySize || 10000;
    this.cachedPercentileDenominator = 1.0;
    this.tradeCounter = 0;
    this.dS_pct = config.dS_pct !== undefined ? config.dS_pct : 0.005; 
    this.dt_years = config.dt_years !== undefined ? config.dt_years : 30 / (365 * 24 * 60); 
    this.dIV = config.dIV !== undefined ? config.dIV : -0.01; 
  }
  clear() {
    this.recentShocks = [];
    this.historicalRawDpis = [];
    this.cachedPercentileDenominator = 1.0;
    this.tradeCounter = 0;
  }
  processTrade(trade, greeks, spot) {
    const contracts = parseInt(trade.size, 10) || 0;
    if (contracts <= 0) {
      return { pressureShock: 0, rawDPI: 0, dpi: 0 };
    }
    const positionSign = this._determinePositionSign(trade);
    const dealerGamma = positionSign * greeks.gamma;
    const dealerCharm = positionSign * greeks.charm;
    const dealerVanna = positionSign * greeks.vanna;
    const dS = spot * this.dS_pct;
    const dt = this.dt_years;
    const dIV = this.dIV;
    const pressureShock = -contracts * 100 * (
      dealerGamma * dS +
      dealerCharm * dt +
      dealerVanna * dIV
    );
    this.recentShocks.unshift(pressureShock);
    if (this.recentShocks.length > this.maxRecentSize) {
      this.recentShocks.pop();
    }
    const rawDPI = this._calculateRawDPI();
    const absRawDPI = Math.abs(rawDPI);
    if (absRawDPI > 1e-4) {
      this.historicalRawDpis.push(absRawDPI);
      if (this.historicalRawDpis.length > this.maxHistorySize) {
        this.historicalRawDpis.shift();
      }
    }
    this.tradeCounter++;
    if (this.tradeCounter < 100 || this.tradeCounter % 100 === 0 || this.cachedPercentileDenominator <= 100.0) {
      const sampleCount = this.historicalRawDpis.length;
      const percentileValue = this._calculatePercentile(this.historicalRawDpis, 95);
      const defaultBaseDenominator = Math.max(200.0, spot * 2.0);
      const weight = Math.min(1.0, sampleCount / 50.0);
      const mixedDenominator = weight * percentileValue + (1.0 - weight) * defaultBaseDenominator;
      this.cachedPercentileDenominator = Math.max(100.0, mixedDenominator);
    }
    let dpi = 0;
    if (this.cachedPercentileDenominator > 1e-4) {
      dpi = (rawDPI / this.cachedPercentileDenominator) * 100;
    }
    dpi = Math.max(-100, Math.min(100, dpi));
    return {
      pressureShock,
      rawDPI,
      dpi
    };
  }
  _calculateRawDPI() {
    let sum = 0;
    this.recentShocks.forEach((shock, idx) => {
      const weight = 1.0 - idx * 0.01;
      if (weight > 0) {
        sum += weight * shock;
      }
    });
    return sum;
  }
  _calculatePercentile(arr, p) {
    if (arr.length === 0) {
      return 1.0; 
    }
    const sorted = [...arr].sort((a, b) => a - b);
    const index = Math.ceil((p / 100.0) * sorted.length) - 1;
    const value = sorted[Math.max(0, index)];
    return value > 1e-4 ? value : 1.0;
  }
  _determinePositionSign(trade) {
    const direction = determineTradeDirection(trade.execution_estimate, trade.aggressor_ind);
    if (direction === 'BUY') {
      return -1; 
    }
    if (direction === 'SELL') {
      return 1; 
    }
    return 0; 
  }
}
module.exports = FlowProcessor;
;"FILE: src/engine/priceVerifier.js";
class PriceVerifier {
  constructor(config = {}) {
    this.pressureThreshold = config.pressureThreshold !== undefined ? config.pressureThreshold : 1e4;
  }
  verifyModel(spot, vwap, dealerPressure) {
    if (Math.abs(dealerPressure) < this.pressureThreshold) {
      return {
        status: 'NEUTRAL',
        reason: '做市商对冲压力接近 0，处于中性震荡状态。'
      };
    }
    const isPriceAboveVwap = spot > vwap;
    if (dealerPressure > 0) {
      if (isPriceAboveVwap) {
        return {
          status: 'EFFECTIVE',
          reason: '做市商买盘对冲压力正在兑现（Price > VWAP 且 Pressure > 0）。'
        };
      } else {
        return {
          status: 'INEFFECTIVE',
          reason: '主动卖盘强于做市商，模型暂时失效（Price < VWAP 且 Pressure > 0）。'
        };
      }
    }
    if (dealerPressure < 0) {
      if (!isPriceAboveVwap) {
        return {
          status: 'EFFECTIVE',
          reason: '做市商卖盘对冲压力正在兑现（Price < VWAP 且 Pressure < 0）。'
        };
      } else {
        return {
          status: 'INEFFECTIVE',
          reason: '主动买盘强于做市商，模型暂时失效（Price > VWAP 且 Pressure < 0）。'
        };
      }
    }
    return {
      status: 'NEUTRAL',
      reason: '无法识别的验证状态。'
    };
  }
}
module.exports = PriceVerifier;
;"FILE: src/engine/regimeManager.js";
class RegimeManager {
  constructor(config = {}) {
    this.defaultScore = config.defaultScore !== undefined ? config.defaultScore : 85;
    this.state = {
      hasMacroEvent: false,      
      hasVolumeSpike: false,     
      hasVixGap: false,          
      hasAtrExpansion: false     
    };
  }
  updateState(newState) {
    this.state = {
      ...this.state,
      ...newState
    };
  }
  calculateDealerInfluence() {
    let score = 100;
    if (this.state.hasMacroEvent) {
      score -= 40;
    }
    if (this.state.hasVolumeSpike) {
      score -= 20;
    }
    if (this.state.hasVixGap) {
      score -= 20;
    }
    if (this.state.hasAtrExpansion) {
      score -= 20;
    }
    return Math.max(0, Math.min(100, score));
  }
  getInfluenceRegime(score) {
    if (score >= 80) {
      return 'Dealer Dominated (做市商绝对主导定价)';
    }
    if (score >= 50) {
      return 'Balanced (双向力量相对平衡)';
    }
    return 'Flow Dominated (主动资金主导，做市商模型可能失效)';
  }
}
module.exports = RegimeManager;
;"FILE: src/server.js";
const fs = require('fs');
const path = require('path');
const express = require('express');
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const { calculateImpliedVolatility, calculateBSGreeks } = require('./calculator/bsCalculator');
const { calculateT, clampTradingTime } = require('./utils/sharedUtils');
const logger = require('./utils/logger')('server');
async function fetchWithRetry(url, options = {}, timeout = 10000, maxRetries = 3, delay = 2000) {
  if (!options.headers) {
    options.headers = {};
  }
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
const FlowProcessor = require('./engine/flowProcessor');
const Aggregator = require('./engine/aggregator');
const RegimeManager = require('./engine/regimeManager');
const PriceVerifier = require('./engine/priceVerifier');
const DecisionEngine = require('./engine/decisionEngine');
const app = express();
const PORT = process.env.PORT || 3080;
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
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
const store = new PositionStore({ oiFactor: 0.5 });
const aggregator = new Aggregator();
const regimeManager = new RegimeManager();
const priceVerifier = new PriceVerifier();
const decisionEngine = new DecisionEngine();
const BENZINGA_API_KEY = '<REDACTED_BENZINGA_API_KEY>';
const BENZINGA_COOKIE = '<REDACTED_BENZINGA_COOKIE>';
const sortedTickers = [
  { name: 'SPY', count: 0 },
  { name: 'QQQ', count: 0 },
  { name: 'MU', count: 0 },
];
const BUILTIN_TICKERS = sortedTickers.map(t => t.name.toUpperCase());
const GEX_STRIKE_RADIUS = 20;
const GEX_IV_DISPLAY_T = 1.0 / 365.0;
const GEX_MIN_REALTIME_DISPLAY_T = 1.0 / (365.0 * 24.0 * 60.0);
const liveTickerCounts = {};
const knownSignalIds = new Set();
let lastUpdatedCursor = 0;
const FOMC_DATES = new Set([
  "2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17",
  "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09"
]);
const macroEventDates = new Set([...FOMC_DATES]);
async function fetchFredReleaseDates(releaseId, apiKey) {
  const url = `https://api.stlouisfed.org/fred/release/dates?release_id=${releaseId}&api_key=${apiKey}&file_type=json&include_release_dates_with_no_data=true&realtime_start=2026-06-01`;
  try {
    const res = await fetchWithRetry(url, { headers: { 'Accept': 'application/json' } }, 10000);
    if (res.status === 200) {
      const data = await res.json();
      if (data && Array.isArray(data.release_dates)) {
        data.release_dates.forEach(d => {
          if (d.date) {
            macroEventDates.add(d.date);
          }
        });
        logger.info(`[MacroEvents] Loaded ${data.release_dates.length} schedule dates for Release ID: ${releaseId}`);
      }
    } else {
      logger.warn(`[MacroEvents] FRED API returned status ${res.status} for Release ID ${releaseId}`);
    }
  } catch (err) {
    logger.error(`[MacroEvents] Failed to fetch FRED dates for Release ID ${releaseId}:`, err.message);
  }
}
async function initializeMacroEvents() {
  const apiKey = '<REDACTED_FRED_API_KEY>'; 
  if (!apiKey) {
    logger.warn(`[MacroEvents] No FRED_API_KEY environment variable found. Only static FOMC calendar will be used.`);
    return;
  }
  logger.info(`[MacroEvents] Initializing macro calendar from FRED API...`);
  await fetchFredReleaseDates(10, apiKey); 
  await fetchFredReleaseDates(50, apiKey); 
  await fetchFredReleaseDates(46, apiKey); 
  logger.info(`[MacroEvents] Total macro event dates loaded: ${macroEventDates.size}`);
}
function initializeGlobalCursorAndCounts() {
  const todayStr = getEstDateStr();
  let maxUpdated = 0;
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
initializeGlobalCursorAndCounts();
const tickerStates = {};
const chainTimers = {};
let globalTradeTimer = null;
let currentSystemRegime = 'IDLE'; 
BUILTIN_TICKERS.forEach(ticker => {
  tickerStates[ticker] = {
    ticker: ticker,
    isRunning: true,
    currentTimeSeconds: 0,
    trades: [],
    spot: null,
    vwap: null,
    vwapVolume: 0,
    vwapNotional: 0,
    history: [],
    latestReport: null,
    calculatedMatrix: [],
    matrixViews: { all: [], '0dte': [], weekly: [] },
    gexSummary: null,
    flowProcessor: new FlowProcessor()
  };
});
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
function inferUnderlyingPrice(chainData) {
  if (!chainData || !chainData.optionChains || chainData.optionChains.length === 0) {
    return null;
  }
  const tickerChain = chainData.optionChains[0];
  if (!tickerChain || !tickerChain.chains || tickerChain.chains.length === 0) {
    return null;
  }
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
  spotEstimates.sort((a, b) => a - b);
  const mid = Math.floor(spotEstimates.length / 2);
  return spotEstimates.length % 2 !== 0 ?
    spotEstimates[mid] :
    (spotEstimates[mid - 1] + spotEstimates[mid]) / 2;
}
function getTickerSpot(ticker) {
  ticker = ticker.toUpperCase();
  const todayStr = getEstDateStr();
  const liveDir = path.join(__dirname, '../data/live_data', todayStr, ticker);
  let spot = null; 
  const openChainPath = path.join(liveDir, 'optionchains_open.json');
  if (fs.existsSync(openChainPath)) {
    try {
      const chainData = JSON.parse(fs.readFileSync(openChainPath, 'utf8'));
      const inferred = inferUnderlyingPrice(chainData);
      if (inferred) spot = inferred;
    } catch (e) { }
  }
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
function calculatePlainBSGamma(S, K, T, r, sigma) {
  if (T <= 0 || sigma <= 0) return 0;
  const volSqT = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / volSqT;
  const pdfD1 = Math.exp(-0.5 * d1 * d1) / Math.sqrt(2.0 * Math.PI);
  return pdfD1 / (S * volSqT);
}
function getContractMidpoint(contract) {
  if (!contract) return 0;
  if (contract.midpoint && contract.midpoint > 0) return contract.midpoint;
  const bid = contract.bid || 0;
  const ask = contract.ask || 0;
  if (bid > 0 || ask > 0) return (bid + ask) / 2.0;
  return 0;
}
function fillNearestValidIV(strikes, ivByStrike) {
  strikes.forEach((strike, i) => {
    if (ivByStrike[strike] && ivByStrike[strike] > 0.0002) return;
    let left = i - 1;
    let right = i + 1;
    while (left >= 0 || right < strikes.length) {
      if (left >= 0 && ivByStrike[strikes[left]] && ivByStrike[strikes[left]] > 0.0002) {
        ivByStrike[strike] = ivByStrike[strikes[left]];
        return;
      }
      if (right < strikes.length && ivByStrike[strikes[right]] && ivByStrike[strikes[right]] > 0.0002) {
        ivByStrike[strike] = ivByStrike[strikes[right]];
        return;
      }
      left--;
      right++;
    }
    ivByStrike[strike] = 0.15;
  });
}
function getWallsFromStrikeGex(strikeGexMap) {
  const uniqueStrikes = Object.keys(strikeGexMap).map(Number).sort((a, b) => a - b);
  if (uniqueStrikes.length === 0) {
    return { callWall: null, putWall: null, zeroGamma: null };
  }
  let callWall = null;
  let putWall = null;
  let maxGex = -Infinity;
  let minGex = Infinity;
  uniqueStrikes.forEach(strike => {
    const gex = strikeGexMap[strike];
    if (gex > maxGex) {
      maxGex = gex;
      callWall = strike;
    }
    if (gex < minGex) {
      minGex = gex;
      putWall = strike;
    }
  });
  let zeroGamma = null;
  for (let i = 0; i < uniqueStrikes.length - 1; i++) {
    const k1 = uniqueStrikes[i];
    const k2 = uniqueStrikes[i + 1];
    const gex1 = strikeGexMap[k1];
    const gex2 = strikeGexMap[k2];
    if (gex1 * gex2 < 0) {
      zeroGamma = Math.abs(gex1) < Math.abs(gex2) ? k1 : k2;
      break;
    }
  }
  return { callWall, putWall, zeroGamma };
}
function calculateStaticStrikeGex(row, spot, T, iv) {
  const gamma = calculatePlainBSGamma(spot, row.strike, T, 0.05, iv);
  const gexShares = gamma * ((row.callOI || 0) - (row.putOI || 0)) * 100;
  return gexShares * spot * spot * 0.01;
}
function getGexSummary(matrix, spot) {
  const strikeRows = {};
  matrix.forEach(opt => {
    if (!strikeRows[opt.strike]) {
      strikeRows[opt.strike] = { strike: opt.strike, call: null, put: null, callOI: 0, putOI: 0, t: opt.t };
    }
    if (opt.t && (!strikeRows[opt.strike].t || opt.t < strikeRows[opt.strike].t)) {
      strikeRows[opt.strike].t = opt.t;
    }
    if (opt.type === 'CALL') {
      strikeRows[opt.strike].call = strikeRows[opt.strike].call || opt;
      strikeRows[opt.strike].callOI += opt.openInterest || 0;
    } else if (opt.type === 'PUT') {
      strikeRows[opt.strike].put = strikeRows[opt.strike].put || opt;
      strikeRows[opt.strike].putOI += opt.openInterest || 0;
    }
  });
  const sortedStrikes = Object.keys(strikeRows).map(Number).sort((a, b) => a - b);
  const ivByStrike = {};
  sortedStrikes.forEach(strike => {
    const row = strikeRows[strike];
    const otmContract = strike >= spot ? row.call : row.put;
    const optionType = strike >= spot ? 'CALL' : 'PUT';
    const price = getContractMidpoint(otmContract);
    if (price > 0) {
      const iv = calculateImpliedVolatility(spot, strike, GEX_IV_DISPLAY_T, 0.05, price, optionType);
      ivByStrike[strike] = (!isNaN(iv) && iv > 0.0002) ? iv : null;
    } else {
      ivByStrike[strike] = null;
    }
  });
  fillNearestValidIV(sortedStrikes, ivByStrike);
  const strikeGexRealTime = {};
  const strikeGexGlobal = {};
  sortedStrikes.forEach(strike => {
    const row = strikeRows[strike];
    const iv = ivByStrike[strike];
    const realtimeT = Math.max(row.t || GEX_MIN_REALTIME_DISPLAY_T, GEX_MIN_REALTIME_DISPLAY_T);
    strikeGexRealTime[strike] = calculateStaticStrikeGex(row, spot, realtimeT, iv);
    strikeGexGlobal[strike] = calculateStaticStrikeGex(row, spot, GEX_IV_DISPLAY_T, iv);
  });
  const strikes = [];
  const gexRealTimeValues = [];
  const gexGlobalValues = [];
  const subStrikes = getStrikesAroundSpot(sortedStrikes, spot, GEX_STRIKE_RADIUS);
  subStrikes.forEach(k => {
    strikes.push(k);
    gexRealTimeValues.push(strikeGexRealTime[k] / 1e6); 
    gexGlobalValues.push((strikeGexGlobal[k] || 0) / 1e6);
  });
  const walls = getWallsFromStrikeGex(strikeGexGlobal);
  return {
    strikes,
    gex: gexRealTimeValues,
    gexGlobal: gexGlobalValues,
    callWall: walls.callWall,
    putWall: walls.putWall,
    zeroGamma: walls.zeroGamma
  };
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
  return {
    all: getGexSummary(matrixViews.all, spot),
    '0dte': getGexSummary(matrixViews['0dte'], spot),
    weekly: getGexSummary(matrixViews.weekly, spot)
  };
}
function backfillHistoryPoints(ticker, existingTrades, existingHistory, flowProcessorInstance) {
  const todayStr = getEstDateStr();
  const historyMinutes = new Set(existingHistory.map(h => h.time));
  const sortedTrades = [...(existingTrades || [])].sort((a, b) => {
    return timeStringToSeconds(a.time) - timeStringToSeconds(b.time);
  });
  const firstTradeSec = sortedTrades.length > 0 ? timeStringToSeconds(sortedTrades[0].time) : 9.5 * 3600;
  const startSec = Math.max(9.5 * 3600, Math.floor(firstTradeSec / 60) * 60); 
  const currentSec = getEstTimeDetails().seconds;
  const endSec = Math.min(16.0 * 3600, currentSec); 
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
  if (flowProcessorInstance) {
    flowProcessorInstance.clear();
  }
  let vwapVolume = 0;
  let vwapNotional = 0;
  if (sortedTrades.length === 0 && Object.keys(snapMap).length === 0) {
    return {
      historyPoints: existingHistory,
      vwapVolume: 0,
      vwapNotional: 0
    };
  }
  const newHistory = [...existingHistory];
  let tradeIdx = 0;
  let lastKnownSpot = getTickerSpot(ticker);
  for (let sec = startSec; sec <= endSec; sec += 60) {
    const hh = Math.floor(sec / 3600).toString().padStart(2, '0');
    const mm = Math.floor((sec % 3600) / 60).toString().padStart(2, '0');
    const timeStr = `${hh}:${mm}`;
    while (tradeIdx < sortedTrades.length && timeStringToSeconds(sortedTrades[tradeIdx].time) <= sec) {
      const trade = sortedTrades[tradeIdx];
      lastKnownSpot = parseFloat(trade.underlying_price) || lastKnownSpot;
      store.applyTrade(ticker, trade);
      const tradePrice = parseFloat(trade.underlying_price);
      const tradeSize = parseInt(trade.size) || 0;
      if (!isNaN(tradePrice) && tradePrice > 0 && tradeSize > 0) {
        vwapVolume += tradeSize;
        vwapNotional += tradePrice * tradeSize;
      }
      let inferredIv = NaN;
      if (trade.midpoint && parseFloat(trade.midpoint) > 0) {
        const T = calculateT(todayStr, trade.time, trade.date_expiration);
        const midpoint = parseFloat(trade.midpoint);
        const strike = parseFloat(trade.strike_price);
        inferredIv = calculateImpliedVolatility(
          lastKnownSpot,
          strike,
          T,
          0.05,
          midpoint,
          trade.put_call.toUpperCase()
        );
        if (!isNaN(inferredIv) && inferredIv > 0.0002) {
          if (store.store[ticker] && store.store[ticker][trade.option_symbol]) {
            store.store[ticker][trade.option_symbol].ivRealtime = inferredIv;
            store.store[ticker][trade.option_symbol].iv = inferredIv;
          }
        }
      }
      const T = calculateT(todayStr, trade.time, trade.date_expiration);
      const strike = parseFloat(trade.strike_price);
      const type = trade.put_call.toUpperCase();
      const symbol = trade.option_symbol;
      let iv = 0.20;
      if (store.store[ticker] && store.store[ticker][symbol] && store.store[ticker][symbol].iv) {
        iv = store.store[ticker][symbol].iv;
      } else if (!isNaN(inferredIv) && inferredIv > 0.0002) {
        iv = inferredIv;
      }
      const greeks = calculateBSGreeks(lastKnownSpot, strike, T, 0.05, iv, type, {});
      if (flowProcessorInstance) {
        flowProcessorInstance.processTrade(trade, greeks, lastKnownSpot);
      }
      tradeIdx++;
    }
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
    if (historyMinutes.has(timeStr)) {
      continue;
    }
    const calcTimeStr = clampTradingTime(`${timeStr}:00`);
    const finalMatrix = store.calculateMatrixGEX(ticker, lastKnownSpot, 0.05, todayStr, calcTimeStr);
    if (finalMatrix && finalMatrix.length > 0) {
      const matrixViews = buildExpiryViews(finalMatrix, todayStr);
      const gexSummary = buildGexSummaries(matrixViews, lastKnownSpot);
      const aggPressure = aggregator.aggregatePressure(finalMatrix, lastKnownSpot);
      const agg0dte = aggregator.aggregatePressure(matrixViews['0dte'], lastKnownSpot);
      const aggWeekly = aggregator.aggregatePressure(matrixViews.weekly, lastKnownSpot);
      const currentVwap = vwapVolume > 0 ? (vwapNotional / vwapVolume) : lastKnownSpot;
      let currentDpi = 0;
      if (flowProcessorInstance) {
        const rawDpi = flowProcessorInstance._calculateRawDPI();
        if (flowProcessorInstance.cachedPercentileDenominator > 1e-4) {
          currentDpi = (rawDpi / flowProcessorInstance.cachedPercentileDenominator) * 100;
        }
        currentDpi = Math.max(-100, Math.min(100, currentDpi));
      }
      const influence = regimeManager.calculateDealerInfluence();
      const influenceRegime = regimeManager.getInfluenceRegime(influence);
      const verification = priceVerifier.verifyModel(lastKnownSpot, currentVwap, aggPressure.dealerNotional);
      const report = decisionEngine.generateReport({
        spot: lastKnownSpot,
        vwap: currentVwap,
        influenceScore: influence,
        influenceRegime: influenceRegime,
        calculatedMatrix: finalMatrix,
        dpi: currentDpi,
        aggPressure,
        verification
      });
      const newPoint = {
        time: timeStr,
        sec: sec,
        spot: lastKnownSpot,
        vwap: currentVwap,
        dpi: report.pressureMetrics.dpi,
        dealerNotional: aggPressure.dealerNotional / 1e6,
        dealerNotional_0dte: agg0dte.dealerNotional / 1e6,
        dealerNotional_weekly: aggWeekly.dealerNotional / 1e6,
        report: report,
        gexData: gexSummary
      };
      newHistory.push(newPoint);
      logger.info(`[Backfill] Generated history point for ${ticker} at ${timeStr} (${hasSnapshotForMinute ? 'Snapshot Chain' : 'Inferred / Replayed'}), Spot=$${lastKnownSpot}`);
    }
  }
  const uniqueHistoryMap = {};
  newHistory.forEach(h => {
    const alignedSec = Math.floor(h.sec / 60) * 60;
    h.sec = alignedSec;
    uniqueHistoryMap[h.time] = h;
  });
  return {
    historyPoints: Object.values(uniqueHistoryMap).sort((a, b) => a.sec - b.sec),
    vwapVolume,
    vwapNotional
  };
}
async function startLiveTracker(ticker) {
  ticker = ticker.toUpperCase();
  logger.info(`--- Starting LIVE tracker in background for ${ticker} ---`);
  if (chainTimers[ticker]) clearInterval(chainTimers[ticker]);
  chainTimers[ticker] = null;
  const todayStr = getEstDateStr();
  const liveDir = path.join(__dirname, '../data/live_data', todayStr, ticker);
  if (!fs.existsSync(liveDir)) {
    fs.mkdirSync(liveDir, { recursive: true });
  }
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
      }, 10000); 
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
  let initialSpot = await getTickerSpotLive(ticker);
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
  const state = tickerStates[ticker];
  state.trades = existingTrades;
  if (state.flowProcessor) {
    state.flowProcessor.clear();
  }
  if (chainData) {
    if (existingTrades.length > 0) {
      logger.info(`[Backfill] Replaying and backfilling missing history for ${ticker}...`);
      const backfillResult = backfillHistoryPoints(ticker, existingTrades, existingHistory, state.flowProcessor);
      existingHistory = backfillResult.historyPoints;
      state.vwapVolume = backfillResult.vwapVolume;
      state.vwapNotional = backfillResult.vwapNotional;
      state.vwap = backfillResult.vwapVolume > 0 ? (backfillResult.vwapNotional / backfillResult.vwapVolume) : initialSpot;
      fs.writeFileSync(historyPath, JSON.stringify(existingHistory, null, 2));
      initialSpot = await getTickerSpotLive(ticker);
    } else {
      store.initializeChain(ticker, chainData, todayStr);
      store.initializeIVs(ticker, initialSpot, 0.05, todayStr, '09:30:00');
      state.vwapVolume = 0;
      state.vwapNotional = 0;
      state.vwap = initialSpot;
    }
  } else {
    state.vwapVolume = 0;
    state.vwapNotional = 0;
    state.vwap = initialSpot;
  }
  state.spot = initialSpot;
  state.history = existingHistory;
  const estDetails = getEstTimeDetails();
  const timeNowStr = estDetails.timeStr;
  state.currentTimeSeconds = estDetails.seconds;
  if (chainData) {
    const finalMatrix = store.calculateMatrixGEX(ticker, initialSpot, 0.05, todayStr, clampTradingTime(timeNowStr));
    const matrixViews = buildExpiryViews(finalMatrix, todayStr);
    const gexSummary = buildGexSummaries(matrixViews, initialSpot);
    state.calculatedMatrix = finalMatrix;
    state.matrixViews = matrixViews;
    state.gexSummary = gexSummary;
    const aggPressure = aggregator.aggregatePressure(finalMatrix, initialSpot);
    const influence = regimeManager.calculateDealerInfluence();
    const influenceRegime = regimeManager.getInfluenceRegime(influence);
    const verification = priceVerifier.verifyModel(initialSpot, initialSpot, aggPressure.dealerNotional);
    state.latestReport = decisionEngine.generateReport({
      spot: initialSpot,
      vwap: initialSpot,
      influenceScore: influence,
      influenceRegime: influenceRegime,
      calculatedMatrix: finalMatrix,
      dpi: 0,
      aggPressure,
      verification
    });
  }
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
    }, 10000); 
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
            return; 
          }
          state.spot = quotePrices[ticker] || parseFloat(trade.underlying_price) || state.spot;
          state.trades.push(trade);
          const T = calculateT(todayStr, trade.time, trade.date_expiration);
          const strike = parseFloat(trade.strike_price);
          const type = trade.put_call.toUpperCase();
          const symbol = trade.option_symbol;
          let inferredIv = NaN;
          if (trade.midpoint && parseFloat(trade.midpoint) > 0) {
            const midpoint = parseFloat(trade.midpoint);
            inferredIv = calculateImpliedVolatility(
              state.spot,
              strike,
              T,
              0.05,
              midpoint,
              type
            );
            if (!isNaN(inferredIv) && inferredIv > 0.0002) {
              if (store.store[ticker] && store.store[ticker][symbol]) {
                store.store[ticker][symbol].ivRealtime = inferredIv;
                store.store[ticker][symbol].iv = inferredIv;
              }
            }
          }
          let iv = 0.20;
          if (store.store[ticker] && store.store[ticker][symbol] && store.store[ticker][symbol].iv) {
            iv = store.store[ticker][symbol].iv;
          } else if (!isNaN(inferredIv) && inferredIv > 0.0002) {
            iv = inferredIv;
          }
          if (!state.spot) {
            return;
          }
          const greeks = calculateBSGreeks(state.spot, strike, T, 0.05, iv, type, {});
          let latestDpi = 0;
          if (state.flowProcessor) {
            const result = state.flowProcessor.processTrade(trade, greeks, state.spot);
            latestDpi = result.dpi;
          }
          const tradePrice = parseFloat(trade.underlying_price);
          const tradeSize = parseInt(trade.size) || 0;
          if (!isNaN(tradePrice) && tradePrice > 0 && tradeSize > 0) {
            state.vwapVolume = (state.vwapVolume || 0) + tradeSize;
            state.vwapNotional = (state.vwapNotional || 0) + tradePrice * tradeSize;
            state.vwap = state.vwapNotional / state.vwapVolume;
          }
          if (state.latestReport && state.latestReport.pressureMetrics) {
            state.latestReport.pressureMetrics.dpi = latestDpi;
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
function pruneOptionChain(chainData, spot, todayStr) {
  if (!chainData || !chainData.optionChains || chainData.optionChains.length === 0) {
    return chainData;
  }
  const prunedOptionChains = chainData.optionChains.map(tc => {
    if (!tc || !tc.chains) return tc;
    const filteredChains = tc.chains.map(group => {
      const expirationDateStr = group.expiration || (group.mmy ? `${group.mmy.substring(0, 4)}-${group.mmy.substring(4, 6)}-${group.mmy.substring(6, 8)}` : null);
      if (!expirationDateStr) return null;
      const expDate = new Date(expirationDateStr + 'T00:00:00-04:00');
      const curDate = new Date(todayStr + 'T00:00:00-04:00');
      const diffDays = Math.round((expDate - curDate) / (1000 * 60 * 60 * 24));
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
    }, 10000); 
    if (res.status === 200) {
      chainData = await res.json();
      const prunedChainData = pruneOptionChain(chainData, state.spot, todayStr);
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
  if (!state.spot) {
    logger.warn(`[LiveChain] No spot price available yet for ${ticker}, skipping calculations.`);
    return;
  }
  const clampedTimeNowStr = clampTradingTime(timeNowStr);
  const finalMatrix = store.calculateMatrixGEX(ticker, state.spot, 0.05, todayStr, clampedTimeNowStr);
  const matrixViews = buildExpiryViews(finalMatrix, todayStr);
  const gexSummary = buildGexSummaries(matrixViews, state.spot);
  state.calculatedMatrix = finalMatrix;
  state.matrixViews = matrixViews;
  state.gexSummary = gexSummary;
  const aggPressure = aggregator.aggregatePressure(finalMatrix, state.spot);
  const hasEventToday = macroEventDates.has(todayStr);
  regimeManager.updateState({
    hasMacroEvent: hasEventToday,
    hasVolumeSpike: false,
    hasVixGap: false,
    hasAtrExpansion: false
  });
  const influence = regimeManager.calculateDealerInfluence();
  const influenceRegime = regimeManager.getInfluenceRegime(influence);
  const verification = priceVerifier.verifyModel(state.spot, state.vwap, aggPressure.dealerNotional);
  state.latestReport = decisionEngine.generateReport({
    spot: state.spot,
    vwap: state.vwap,
    influenceScore: influence,
    influenceRegime: influenceRegime,
    calculatedMatrix: finalMatrix,
    dpi: state.latestReport ? state.latestReport.pressureMetrics.dpi : 0,
    aggPressure,
    verification
  });
  let existingHistory = [];
  if (fs.existsSync(historyPath)) {
    try {
      existingHistory = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    } catch (e) { }
  }
  const agg0dte = aggregator.aggregatePressure(matrixViews['0dte'], state.spot);
  const aggWeekly = aggregator.aggregatePressure(matrixViews.weekly, state.spot);
  const minuteStr = timeNowStr.substring(0, 5); 
  const alignedSec = Math.floor(state.currentTimeSeconds / 60) * 60; 
  const newHistoryPoint = {
    time: minuteStr,
    sec: alignedSec,
    spot: state.spot,
    vwap: state.vwap,
    dpi: state.latestReport.pressureMetrics.dpi,
    dealerNotional: aggPressure.dealerNotional / 1e6,
    dealerNotional_0dte: agg0dte.dealerNotional / 1e6,
    dealerNotional_weekly: aggWeekly.dealerNotional / 1e6,
    report: state.latestReport,
    gexData: gexSummary
  };
  const existingIdx = existingHistory.findIndex(h => h.time === minuteStr);
  if (existingIdx !== -1) {
    existingHistory[existingIdx] = newHistoryPoint;
  } else {
    existingHistory.push(newHistoryPoint);
  }
  existingHistory.sort((a, b) => a.sec - b.sec);
  fs.writeFileSync(historyPath, JSON.stringify(existingHistory, null, 2));
  state.history = existingHistory;
  logger.info(`[LiveChain] Greeks recalculated for ${ticker}. Spot=$${state.spot}, History count: ${existingHistory.length}`);
}
function getEstRequiredRegime() {
  const nyDateStr = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
  const nyDate = new Date(nyDateStr);
  const day = nyDate.getDay(); 
  if (day === 0 || day === 6) {
    return 'IDLE';
  }
  const hours = nyDate.getHours();
  const minutes = nyDate.getMinutes();
  const totalSeconds = hours * 3600 + minutes * 60 + nyDate.getSeconds();
  const startPrepare = 9 * 3600 + 20 * 60; 
  const startTrading = 9 * 3600 + 30 * 60; 
  const endTrading = 16 * 3600;            
  if (totalSeconds >= startPrepare && totalSeconds < startTrading) {
    return 'PREPARING';
  } else if (totalSeconds >= startTrading && totalSeconds < endTrading) {
    return 'TRADING';
  } else {
    return 'IDLE';
  }
}
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
async function startTradingPolls() {
  logger.info(`[Scheduler] Market open! Starting live metrics and trades polling...`);
  for (const ticker of BUILTIN_TICKERS) {
    const liveDir = path.join(__dirname, '../data/live_data', getEstDateStr(), ticker);
    const openChainPath = path.join(liveDir, 'optionchains_open.json');
    if (!tickerStates[ticker].latestReport || !fs.existsSync(openChainPath)) {
      try {
        logger.info(`[Scheduler] Ticker ${ticker} not initialized, fetching now...`);
        await startLiveTracker(ticker);
      } catch (e) {
        logger.error(`[Scheduler] Failed to initialize ${ticker}:`, e.message);
      }
    }
  }
  BUILTIN_TICKERS.forEach(ticker => {
    if (!chainTimers[ticker]) {
      logger.info(`[Scheduler] Starting live Greeks timer for ${ticker} (20s interval)`);
      chainTimers[ticker] = setInterval(async () => {
        await pollLiveChainAndCalculate(ticker);
      }, 20000);
    }
  });
  if (!globalTradeTimer) {
    logger.info(`[Scheduler] Starting live trades timer (15s interval)`);
    globalTradeTimer = setInterval(async () => {
      await pollLiveTrades();
    }, 15000);
  }
}
async function updateSystemRegime() {
  const requiredRegime = getEstRequiredRegime();
  if (requiredRegime === currentSystemRegime) {
    return;
  }
  logger.info(`[Scheduler] System state transition: ${currentSystemRegime} => ${requiredRegime}`);
  currentSystemRegime = requiredRegime;
  if (requiredRegime === 'PREPARING') {
    initializeGlobalCursorAndCounts();
    await prepareBaseDataOnly();
  } else if (requiredRegime === 'TRADING') {
    await startTradingPolls();
  } else if (requiredRegime === 'IDLE') {
    stopAllPolls();
  }
}
setInterval(async () => {
  try {
    await updateSystemRegime();
  } catch (e) {
    logger.error(`[Scheduler] Error during updateSystemRegime execution:`, e);
  }
}, 10000);
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
(async () => {
  await updateSystemRegime();
})();
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
app.get('/api/state', async (req, res) => {
  const ticker = (req.query.ticker || 'AAPL').toUpperCase();
  const state = getTickerState(ticker);
  if (state) {
    if (!state.latestReport || !state.history || state.history.length === 0) {
      const latestHistory = getLatestHistoryForTicker(ticker);
      if (latestHistory.history.length > 0) {
        const lastPoint = latestHistory.history[latestHistory.history.length - 1];
        state.history = latestHistory.history;
        state.spot = lastPoint.spot || state.spot;
        state.vwap = lastPoint.vwap || state.vwap;
        state.latestReport = lastPoint.report || state.latestReport;
        if (lastPoint.gexData) {
          state.gexSummary = lastPoint.gexData;
        }
      }
    }
    const quotePrices = await fetchTipRanksQuotePrices([ticker]);
    if (quotePrices[ticker]) {
      state.spot = quotePrices[ticker];
      if (!state.vwapVolume) {
        state.vwap = state.spot;
      }
    }
  }
  res.json(getClientState(ticker));
});
function getLatestTradeDateWithData(ticker) {
  const liveDataRoot = path.join(__dirname, '../data/live_data');
  if (!fs.existsSync(liveDataRoot)) return null;
  try {
    const dates = fs.readdirSync(liveDataRoot)
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort((a, b) => b.localeCompare(a)); 
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
app.get('/api/gex', async (req, res) => {
  const ticker = (req.query.ticker || 'AAPL').toUpperCase();
  const expiry = req.query.expiry || 'all';
  const todayStr = getEstDateStr();
  const emptySummary = { strikes: [], gex: [], gexGlobal: [], callWall: null, putWall: null, zeroGamma: null };
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
        state.vwap = lastPoint.vwap || state.vwap;
        state.latestReport = lastPoint.report || state.latestReport;
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
    let notional = h.dealerNotional;
    if (expiry === '0dte') notional = h.dealerNotional_0dte;
    if (expiry === 'weekly') notional = h.dealerNotional_weekly;
    return {
      time: h.time,
      date: h.date || historyDate,
      sec: h.sec,
      spot: h.spot,
      vwap: h.vwap,
      dpi: h.dpi,
      dealerNotional: notional,
      report: h.report,
      gexData: h.gexData
    };
  });
  res.json(formattedHistory);
});
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
      vwap: 0,
      latestReport: null
    };
  }
  return {
    selectedTicker: state.ticker,
    isRunning: state.isRunning,
    currentTime: secondsToTimeString(state.currentTimeSeconds),
    currentTimePct: ((state.currentTimeSeconds - 9.5 * 3600) / (6.5 * 3600)) * 100,
    speedMultiplier: 1,
    spot: state.spot,
    vwap: state.vwap,
    latestReport: state.latestReport
  };
}
app.listen(PORT, async () => {
  await initializeMacroEvents();
  logger.info(`==========================================`);
  logger.info(`Dealer Pressure Engine v2.0 is running at:`);
  logger.info(`🚀 http://localhost:${PORT}`);
  logger.info(`==========================================`);
});
;"FILE: src/store/positionStore.js";
const { calculateBSGreeks, calculateImpliedVolatility } = require('../calculator/bsCalculator');
const { calculateT, calculateDayT, determineTradeDirection } = require('../utils/sharedUtils');
class PositionStore {
  constructor(config = {}) {
    this.store = {};
    this.oiFactor = config.oiFactor !== undefined ? config.oiFactor : 0.5;
  }
  clear() {
    this.store = {};
  }
  initializeChain(ticker, benzingaChain, currentDateStr = new Date().toISOString().split('T')[0]) {
    const uppercaseTicker = ticker.toUpperCase();
    this.store[uppercaseTicker] = {};
    if (!benzingaChain || !benzingaChain.optionChains) {
      return;
    }
    const tickerChain = benzingaChain.optionChains.find(
      c => c.symbol.toUpperCase() === uppercaseTicker
    );
    if (!tickerChain || !tickerChain.chains) {
      return;
    }
    tickerChain.chains.forEach(expiryGroup => {
      const expirationDateStr = this._parseExpirationDate(expiryGroup.mmy); 
      const expDate = new Date(expirationDateStr + 'T00:00:00-04:00');
      const curDate = new Date(currentDateStr + 'T00:00:00-04:00');
      const diffDays = Math.round((expDate - curDate) / (1000 * 60 * 60 * 24));
      if (diffDays < 0 || diffDays > 14) {
        return; 
      }
      if (expiryGroup.calls) {
        expiryGroup.calls.forEach(opt => {
          this._registerOption(uppercaseTicker, opt, 'CALL', expirationDateStr);
        });
      }
      if (expiryGroup.puts) {
        expiryGroup.puts.forEach(opt => {
          this._registerOption(uppercaseTicker, opt, 'PUT', expirationDateStr);
        });
      }
    });
  }
  applyTrade(ticker, trade, currentDateStr = new Date().toISOString().split('T')[0]) {
    const uppercaseTicker = ticker.toUpperCase();
    const symbol = trade.option_symbol;
    const expirationStr = trade.date_expiration;
    if (expirationStr) {
      const expDate = new Date(expirationStr + 'T00:00:00-04:00');
      const curDate = new Date(currentDateStr + 'T00:00:00-04:00');
      const diffDays = Math.round((expDate - curDate) / (1000 * 60 * 60 * 24));
      if (diffDays < 0 || diffDays > 14) {
        return false; 
      }
    }
    if (!this.store[uppercaseTicker]) {
      this.store[uppercaseTicker] = {};
    }
    if (!this.store[uppercaseTicker][symbol]) {
      const oi = parseInt(trade.open_interest, 10) || 0;
      const type = trade.put_call.toUpperCase();
      this.store[uppercaseTicker][symbol] = {
        symbol: symbol,
        strike: parseFloat(trade.strike_price),
        type: type,
        expiration: trade.date_expiration,
        openInterest: oi,
        structurePosition: type === 'CALL' ? (oi * this.oiFactor) : (-oi * this.oiFactor),
        dealerPosition: -oi * this.oiFactor,
        iv: undefined
      };
    }
    const size = parseInt(trade.size, 10) || 0;
    const direction = this._determineTradeDirection(trade);
    const contract = this.store[uppercaseTicker][symbol];
    const isCall = contract.type === 'CALL';
    if (direction === 'BUY') {
      contract.dealerPosition -= size;
      if (isCall) {
        contract.structurePosition += size;
      } else {
        contract.structurePosition -= size;
      }
    } else if (direction === 'SELL') {
      contract.dealerPosition += size;
      if (isCall) {
        contract.structurePosition -= size;
      } else {
        contract.structurePosition += size;
      }
    }
    return true;
  }
  getPositionMatrix(ticker) {
    const uppercaseTicker = ticker.toUpperCase();
    if (!this.store[uppercaseTicker]) {
      return [];
    }
    return Object.values(this.store[uppercaseTicker]);
  }
  calculateMatrixGEX(ticker, spot, r, currentDateStr, currentTimeStr = "09:30:00", expiryFilter = "all", greeksConfig = {}) {
    if (!spot) {
      return [];
    }
    const matrix = this.getPositionMatrix(ticker);
    return matrix.map(contract => {
      const expDate = new Date(contract.expiration + 'T00:00:00-04:00');
      const curDate = new Date(currentDateStr + 'T00:00:00-04:00');
      const diffDays = Math.round((expDate - curDate) / (1000 * 60 * 60 * 24));
      if (diffDays < 0 || diffDays > 14) {
        return null;
      }
      if (expiryFilter === '0dte' && diffDays !== 0) {
        return null;
      }
      if (expiryFilter === 'weekly' && (diffDays < 1 || diffDays > 5)) {
        return null;
      }
      const T = calculateT(currentDateStr, currentTimeStr, contract.expiration);
      const marketPrice = contract.midpoint || ((contract.bid + contract.ask) / 2.0) || 0.1;
      let ivRealtime = contract.ivRealtime;
      if (ivRealtime === undefined || ivRealtime === null) {
        ivRealtime = calculateImpliedVolatility(spot, contract.strike, T, r, marketPrice, contract.type);
        if (isNaN(ivRealtime) || ivRealtime <= 0.0002) {
          ivRealtime = 0.20; 
        }
        contract.ivRealtime = ivRealtime;
        contract.iv = ivRealtime; 
      }
      const greeks = calculateBSGreeks(spot, contract.strike, T, r, ivRealtime, contract.type, greeksConfig);
      const gex = contract.structurePosition * greeks.gamma * 100 * (spot * spot) * 0.01;
      const T_global = calculateDayT(currentDateStr, contract.expiration);
      let ivGlobal = contract.ivGlobal;
      if (ivGlobal === undefined || ivGlobal === null) {
        ivGlobal = calculateImpliedVolatility(spot, contract.strike, T_global, r, marketPrice, contract.type);
        if (isNaN(ivGlobal) || ivGlobal <= 0.0002) {
          ivGlobal = 0.20;
        }
        contract.ivGlobal = ivGlobal;
      }
      const greeks_global = calculateBSGreeks(spot, contract.strike, T_global, r, ivGlobal, contract.type, greeksConfig);
      const initialPosition = contract.type === 'CALL' ? ((contract.openInterest || 0) * this.oiFactor) : (-(contract.openInterest || 0) * this.oiFactor);
      const gexGlobal = initialPosition * greeks_global.gamma * 100 * (spot * spot) * 0.01;
      return {
        ...contract,
        t: T,
        tGlobal: T_global,
        ivRealtime,
        ivGlobal,
        delta: greeks.delta,
        gamma: greeks.gamma,
        charm: greeks.charm,
        vanna: greeks.vanna,
        deltaGlobal: greeks_global.delta,
        gammaGlobal: greeks_global.gamma,
        charmGlobal: greeks_global.charm,
        vannaGlobal: greeks_global.vanna,
        gex: gex, 
        gexGlobal: gexGlobal 
      };
    }).filter(item => item !== null);
  }
  initializeIVs(ticker, spot, r, currentDateStr, currentTimeStr = "09:30:00") {
    if (!spot) {
      return;
    }
    const uppercaseTicker = ticker.toUpperCase();
    const matrix = this.getPositionMatrix(uppercaseTicker);
    matrix.forEach(contract => {
      const T = calculateT(currentDateStr, currentTimeStr, contract.expiration);
      const marketPrice = contract.midpoint || ((contract.bid + contract.ask) / 2.0) || 0.1;
      let iv = calculateImpliedVolatility(spot, contract.strike, T, r, marketPrice, contract.type);
      if (isNaN(iv) || iv <= 0.0002) {
        iv = 0.20; 
      }
      contract.ivRealtime = iv;
      contract.iv = iv;
      const T_global = calculateDayT(currentDateStr, contract.expiration);
      let ivGlobal = calculateImpliedVolatility(spot, contract.strike, T_global, r, marketPrice, contract.type);
      if (isNaN(ivGlobal) || ivGlobal <= 0.0002) {
        ivGlobal = 0.20;
      }
      contract.ivGlobal = ivGlobal;
    });
  }
  _calculateT(currentDateStr, currentTimeStr, expirationDateStr) {
    return calculateT(currentDateStr, currentTimeStr, expirationDateStr);
  }
  _registerOption(ticker, opt, type, expirationStr) {
    const symbol = opt.symbol;
    const oi = parseInt(opt.openInterest, 10) || 0;
    const bid = parseFloat(opt.bidPrice) || 0;
    const ask = parseFloat(opt.askPrice) || 0;
    const midpoint = (bid + ask) / 2.0;
    this.store[ticker][symbol] = {
      symbol: symbol,
      strike: parseFloat(opt.strike),
      type: type,
      expiration: expirationStr,
      openInterest: oi,
      structurePosition: type === 'CALL' ? (oi * this.oiFactor) : (-oi * this.oiFactor),
      dealerPosition: -oi * this.oiFactor,
      bid: bid,
      ask: ask,
      midpoint: midpoint,
      iv: undefined 
    };
  }
  _parseExpirationDate(mmy) {
    if (!mmy || mmy.length !== 8) return mmy;
    return `${mmy.substring(0, 4)}-${mmy.substring(4, 6)}-${mmy.substring(6, 8)}`;
  }
  _determineTradeDirection(trade) {
    return determineTradeDirection(trade.execution_estimate, trade.aggressor_ind);
  }
  updateChainPrices(ticker, benzingaChain) {
    const uppercaseTicker = ticker.toUpperCase();
    if (!this.store[uppercaseTicker] || !benzingaChain || !benzingaChain.optionChains) {
      return;
    }
    const tickerChain = benzingaChain.optionChains.find(
      c => c.symbol.toUpperCase() === uppercaseTicker
    );
    if (!tickerChain || !tickerChain.chains) {
      return;
    }
    tickerChain.chains.forEach(expiryGroup => {
      const updateContracts = (opts) => {
        if (!opts) return;
        opts.forEach(opt => {
          const symbol = opt.symbol;
          const contract = this.store[uppercaseTicker][symbol];
          if (contract) {
            const bid = parseFloat(opt.bidPrice) || 0;
            const ask = parseFloat(opt.askPrice) || 0;
            contract.bid = bid;
            contract.ask = ask;
            contract.midpoint = (bid + ask) / 2.0;
            contract.iv = undefined;
            contract.ivRealtime = undefined;
            contract.ivGlobal = undefined;
          }
        });
      };
      updateContracts(expiryGroup.calls);
      updateContracts(expiryGroup.puts);
    });
  }
}
module.exports = PositionStore;
;"FILE: src/utils/logger.js";
const winston = require('winston');
const { combine, timestamp, label, printf } = winston.format;
module.exports = function (spaceName) {
  return winston.createLogger({
    level: 'info',
    format: combine(
      timestamp(),
      label({ label: spaceName }),
      printf(({ timestamp, label, level, message }) => {
        return `${timestamp} [${label}] [${level.toUpperCase().padEnd(5, ' ')}] ${message}`;
      })
    ),
    transports: [
      new winston.transports.Console()
    ],
  })
};
;"FILE: src/utils/sharedUtils.js";
function timeStringToSeconds(timeStr) {
  if (!timeStr) return 9.5 * 3600; 
  const [h, m, s] = timeStr.split(':').map(Number);
  return h * 3600 + m * 60 + (s || 0);
}
function calculateT(currentDateStr, currentTimeStr, expirationDateStr) {
  const currentDay = new Date(currentDateStr + 'T00:00:00-04:00');
  const expDay = new Date(expirationDateStr + 'T00:00:00-04:00');
  const diffDays = Math.round((expDay - currentDay) / (1000 * 60 * 60 * 24));
  const currentSeconds = timeStringToSeconds(currentTimeStr);
  const closeSeconds = 16 * 3600; 
  const secondsRemainingToday = Math.max(0, closeSeconds - currentSeconds);
  const totalSecondsRemaining = diffDays * 24 * 3600 + secondsRemainingToday;
  return totalSecondsRemaining / (365 * 24 * 3600);
}
function calculateDayT(currentDateStr, expirationDateStr) {
  const currentDay = new Date(currentDateStr + 'T00:00:00-04:00');
  const expDay = new Date(expirationDateStr + 'T00:00:00-04:00');
  const diffDays = Math.round((expDay - currentDay) / (1000 * 60 * 60 * 24));
  return Math.max(1, diffDays) / 365.0;
}
function findStructureWalls(calculatedMatrix, fieldName = 'gex') {
  if (!calculatedMatrix || calculatedMatrix.length === 0) {
    return { callWall: null, putWall: null, zeroGamma: null };
  }
  const strikeGexMap = {};
  calculatedMatrix.forEach(opt => {
    const k = opt.strike;
    strikeGexMap[k] = (strikeGexMap[k] || 0) + (opt[fieldName] || 0);
  });
  const uniqueStrikes = Object.keys(strikeGexMap).map(Number).sort((a, b) => a - b);
  let callWall = null;
  let putWall = null;
  let maxGex = -Infinity;
  let minGex = Infinity;
  uniqueStrikes.forEach(k => {
    const gex = strikeGexMap[k];
    if (gex > maxGex) {
      maxGex = gex;
      callWall = k;
    }
    if (gex < minGex) {
      minGex = gex;
      putWall = k;
    }
  });
  let zeroGamma = null;
  for (let i = 0; i < uniqueStrikes.length - 1; i++) {
    const k1 = uniqueStrikes[i];
    const k2 = uniqueStrikes[i + 1];
    const gex1 = strikeGexMap[k1];
    const gex2 = strikeGexMap[k2];
    if (gex1 * gex2 < 0) {
      zeroGamma = Math.abs(gex1) < Math.abs(gex2) ? k1 : k2;
      break;
    }
  }
  return { callWall, putWall, zeroGamma };
}
function determineTradeDirection(executionEstimate, aggressorInd) {
  const est = (executionEstimate || '').toUpperCase();
  if (est === 'AT_ASK' || est === 'ABOVE_ASK') {
    return 'BUY'; 
  }
  if (est === 'AT_BID' || est === 'BELOW_BID') {
    return 'SELL'; 
  }
  if (est === 'AT_MIDPOINT') {
    const aggInd = parseFloat(aggressorInd);
    if (!isNaN(aggInd)) {
      return aggInd >= 0.5 ? 'BUY' : 'SELL';
    }
  }
  return 'NEUTRAL';
}
function clampTradingTime(timeStr) {
  const CLOSE_CLAMP = '15:59:50';
  const seconds = timeStringToSeconds(timeStr);
  return seconds >= 16 * 3600 ? CLOSE_CLAMP : timeStr;
}
module.exports = {
  timeStringToSeconds,
  calculateT,
  calculateDayT,
  findStructureWalls,
  determineTradeDirection,
  clampTradingTime
};
