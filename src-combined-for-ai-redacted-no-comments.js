{
  "===== FILE: src/calculator/bsCalculator.js =====";
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
}

{
  "===== FILE: src/utils/sharedUtils.js =====";
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
    determineTradeDirection,
    clampTradingTime
  };
}

{
  "===== FILE: src/utils/logger.js =====";
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
}

{
  "===== FILE: src/store/positionStore.js =====";
  const { calculateBSGreeks, calculateImpliedVolatility } = require('../calculator/bsCalculator');
  const { calculateT, calculateDayT, determineTradeDirection } = require('../utils/sharedUtils');

  class PositionStore {
    constructor(config = {}) {

      this.store = {};

      this.minRealtimeTMinutes = config.minRealtimeTMinutes !== undefined ? config.minRealtimeTMinutes : 5;
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
          openingOI: oi,
          flowPositionDelta: 0,
          ivRealtime: undefined,
          ivGlobal: undefined
        };
      }

      const size = parseInt(trade.size, 10) || 0;
      const direction = this._determineTradeDirection(trade);
      const contract = this.store[uppercaseTicker][symbol];

      if (direction === 'BUY') {
        contract.flowPositionDelta += size;
      } else if (direction === 'SELL') {
        contract.flowPositionDelta -= size;
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

        const minRealtimeT = this.minRealtimeTMinutes / (365 * 24 * 60);
        const T = Math.max(
          minRealtimeT,
          calculateT(currentDateStr, currentTimeStr, contract.expiration)
        );

        const marketPrice = contract.midpoint || ((contract.bid + contract.ask) / 2.0) || 0.1;

        let ivRealtime = contract.ivRealtime;
        if (ivRealtime === undefined || ivRealtime === null) {
          ivRealtime = calculateImpliedVolatility(spot, contract.strike, T, r, marketPrice, contract.type);
          if (isNaN(ivRealtime) || ivRealtime <= 0.0002) {
            ivRealtime = 0.20;
          }
          contract.ivRealtime = ivRealtime;
        }

        const greeks = calculateBSGreeks(spot, contract.strike, T, r, ivRealtime, contract.type, greeksConfig);

        const openingOI = contract.openingOI || 0;
        const flowPositionDelta = contract.flowPositionDelta || 0;
        const realtimePosition = openingOI + flowPositionDelta;
        const realtimeSignedPosition = this._toSignedPosition(realtimePosition, contract.type);
        const globalSignedPosition = this._toSignedPosition(openingOI, contract.type);

        const realtimeGex = realtimeSignedPosition * greeks.gamma * 100 * (spot * spot) * 0.01;

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
        const globalGex = globalSignedPosition * greeks_global.gamma * 100 * (spot * spot) * 0.01;

        return {
          ...contract,
          openingOI,
          flowPositionDelta,
          realtimePosition,
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
          realtimeGex,
          globalGex
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
        openingOI: oi,
        flowPositionDelta: 0,
        bid: bid,
        ask: ask,
        midpoint: midpoint,
        ivRealtime: undefined,
        ivGlobal: undefined
      };
    }

    _parseExpirationDate(mmy) {
      if (!mmy || mmy.length !== 8) return mmy;
      return `${mmy.substring(0, 4)}-${mmy.substring(4, 6)}-${mmy.substring(6, 8)}`;
    }

    _determineTradeDirection(trade) {
      return determineTradeDirection(trade.execution_estimate, trade.aggressor_ind);
    }

    _toSignedPosition(position, optionType) {
      return optionType === 'PUT' ? -position : position;
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
}

{
  "===== FILE: src/engine/gexAggregator.js =====";
  const { calculateBSGreeks } = require('../calculator/bsCalculator');

  class GexAggregator {
    constructor(config = {}) {
      this.strikeRadius = config.strikeRadius !== undefined ? config.strikeRadius : 20;
      this.wallPctRange = config.wallPctRange !== undefined ? config.wallPctRange : 0.10;
      this.zeroGammaPctRange = config.zeroGammaPctRange !== undefined ? config.zeroGammaPctRange : 0.10;
      this.zeroGammaSteps = config.zeroGammaSteps !== undefined ? config.zeroGammaSteps : 80;
      this.riskFreeRate = config.riskFreeRate !== undefined ? config.riskFreeRate : 0.05;
    }

    buildSummaries(matrixViews, spot) {
      return {
        all: this.buildSummary(matrixViews.all, spot),
        '0dte': this.buildSummary(matrixViews['0dte'], spot),
        weekly: this.buildSummary(matrixViews.weekly, spot)
      };
    }

    buildSummary(matrix, spot) {
      const contracts = Array.isArray(matrix) ? matrix : [];
      const strikeRows = this._buildStrikeRows(contracts);
      const sortedStrikes = Object.keys(strikeRows).map(Number).sort((a, b) => a - b);
      const displayStrikes = this._getStrikesAroundSpot(sortedStrikes, spot, this.strikeRadius);

      const globalTotalGex = contracts.reduce((sum, c) => sum + this._finite(c.globalGex), 0);
      const realtimeTotalGex = contracts.reduce((sum, c) => sum + this._finite(c.realtimeGex), 0);

      const globalWalls = this._findWalls(strikeRows, spot, 'globalGex');
      const realtimeWalls = this._findWalls(strikeRows, spot, 'realtimeGex');

      const globalZeroGamma = this._findZeroGammaBySpotScan(contracts, spot, 'global');
      const realtimeZeroGamma = this._findZeroGammaBySpotScan(contracts, spot, 'realtime');

      return {
        strikes: displayStrikes,
        realtimeStrikeGexMillions: displayStrikes.map(k => this._finite(strikeRows[k].realtimeGex) / 1e6),
        globalStrikeGexMillions: displayStrikes.map(k => this._finite(strikeRows[k].globalGex) / 1e6),
        strikeGexRealtime: displayStrikes.map(k => this._finite(strikeRows[k].realtimeGex)),
        strikeGexGlobal: displayStrikes.map(k => this._finite(strikeRows[k].globalGex)),
        realtimeTotalGex,
        globalTotalGex,
        gexChange: realtimeTotalGex - globalTotalGex,
        realtimeCallWall: realtimeWalls.callWall,
        realtimePutWall: realtimeWalls.putWall,
        realtimeZeroGamma,
        globalCallWall: globalWalls.callWall,
        globalPutWall: globalWalls.putWall,
        globalZeroGamma
      };
    }

    _buildStrikeRows(contracts) {
      const rows = {};
      contracts.forEach(contract => {
        const strike = Number(contract.strike);
        if (!Number.isFinite(strike)) return;
        if (!rows[strike]) {
          rows[strike] = { strike, globalGex: 0, realtimeGex: 0 };
        }
        rows[strike].globalGex += this._finite(contract.globalGex);
        rows[strike].realtimeGex += this._finite(contract.realtimeGex);
      });
      return rows;
    }

    _findWalls(strikeRows, spot, fieldName) {
      const strikes = Object.keys(strikeRows).map(Number).sort((a, b) => a - b);
      if (strikes.length === 0 || !spot) {
        return { callWall: null, putWall: null };
      }

      const lower = spot * (1 - this.wallPctRange);
      const upper = spot * (1 + this.wallPctRange);
      const inRange = strikes.filter(k => k >= lower && k <= upper);

      let callWall = null;
      let putWall = null;
      let maxPositiveGex = -Infinity;
      let maxNegativeAbsGex = -Infinity;

      inRange.forEach(strike => {
        const gex = this._finite(strikeRows[strike][fieldName]);
        if (strike >= spot && gex > 0 && gex > maxPositiveGex) {
          maxPositiveGex = gex;
          callWall = strike;
        }
        if (strike <= spot && gex < 0 && Math.abs(gex) > maxNegativeAbsGex) {
          maxNegativeAbsGex = Math.abs(gex);
          putWall = strike;
        }
      });

      return { callWall, putWall };
    }

    _findZeroGammaBySpotScan(contracts, spot, mode) {
      if (!spot || !Array.isArray(contracts) || contracts.length === 0) {
        return null;
      }

      const low = spot * (1 - this.zeroGammaPctRange);
      const high = spot * (1 + this.zeroGammaPctRange);
      const step = (high - low) / this.zeroGammaSteps;
      let prevSpot = null;
      let prevGex = null;
      let closestSpot = null;
      let closestAbsGex = Infinity;

      for (let i = 0; i <= this.zeroGammaSteps; i++) {
        const scanSpot = low + step * i;
        const totalGex = this._calculateTotalGexAtSpot(contracts, scanSpot, mode);
        const absGex = Math.abs(totalGex);

        if (absGex < closestAbsGex) {
          closestAbsGex = absGex;
          closestSpot = scanSpot;
        }

        if (prevGex !== null && prevGex * totalGex < 0) {
          const ratio = Math.abs(prevGex) / (Math.abs(prevGex) + Math.abs(totalGex));
          return this._roundPrice(prevSpot + (scanSpot - prevSpot) * ratio);
        }

        prevSpot = scanSpot;
        prevGex = totalGex;
      }

      return closestSpot === null ? null : this._roundPrice(closestSpot);
    }

    _calculateTotalGexAtSpot(contracts, spot, mode) {
      return contracts.reduce((sum, contract) => {
        const position = mode === 'global'
          ? this._finite(contract.openingOI)
          : this._finite(contract.realtimePosition);
        const signedPosition = contract.type === 'PUT' ? -position : position;
        const T = mode === 'global' ? contract.tGlobal : contract.t;
        const iv = mode === 'global' ? contract.ivGlobal : contract.ivRealtime;
        const strike = Number(contract.strike);

        if (!Number.isFinite(strike) || !Number.isFinite(T) || !Number.isFinite(iv) || iv <= 0) {
          return sum;
        }

        const greeks = calculateBSGreeks(spot, strike, T, this.riskFreeRate, iv, contract.type, {});
        const gex = signedPosition * greeks.gamma * 100 * (spot * spot) * 0.01;
        return sum + this._finite(gex);
      }, 0);
    }

    _getStrikesAroundSpot(sortedStrikes, spot, radius) {
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

    _finite(value) {
      const num = Number(value);
      return Number.isFinite(num) ? num : 0;
    }

    _roundPrice(value) {
      return Number(value.toFixed(2));
    }
  }

  module.exports = GexAggregator;
}

{
  "===== FILE: src/server.js =====";
  const fs = require('fs');
  const path = require('path');
  const express = require('express');
  const dns = require('dns');

  dns.setDefaultResultOrder('ipv4first');

  const { calculateImpliedVolatility } = require('./calculator/bsCalculator');
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
  const GexAggregator = require('./engine/gexAggregator');

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

  const store = new PositionStore();
  const gexAggregator = new GexAggregator();

  const BENZINGA_API_KEY = 'REDACTED_BENZINGA_API_KEY';
  const BENZINGA_COOKIE = 'benzinga_token=REDACTED_BENZINGA_TOKEN';

  const sortedTickers = [

    { name: 'SPY', count: 0 },
    { name: 'QQQ', count: 0 },

    { name: 'MU', count: 0 },

  ];

  const BUILTIN_TICKERS = sortedTickers.map(t => t.name.toUpperCase());
  const GEX_STRIKE_RADIUS = 20;
  const liveTickerCounts = {};
  const knownSignalIds = new Set();
  let lastUpdatedCursor = 0;

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
      history: [],
      calculatedMatrix: [],
      matrixViews: { all: [], '0dte': [], weekly: [] },
      gexSummary: null,
      latestGex: null
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

  function backfillHistoryPoints(ticker, existingTrades, existingHistory) {
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

    if (sortedTrades.length === 0 && Object.keys(snapMap).length === 0) {
      return {
        historyPoints: existingHistory
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
              }
            }
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

    if (chainData) {
      if (existingTrades.length > 0) {
        logger.info(`[Backfill] Replaying and backfilling missing history for ${ticker}...`);
        const backfillResult = backfillHistoryPoints(ticker, existingTrades, existingHistory);
        existingHistory = backfillResult.historyPoints;
        fs.writeFileSync(historyPath, JSON.stringify(existingHistory, null, 2));
        initialSpot = await getTickerSpotLive(ticker);
      } else {
        store.initializeChain(ticker, chainData, todayStr);
        store.initializeIVs(ticker, initialSpot, 0.05, todayStr, '09:30:00');
      }
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
      state.latestGex = getPrimaryGexMetrics(gexSummary);
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
    state.latestGex = getPrimaryGexMetrics(gexSummary);

    let existingHistory = [];
    if (fs.existsSync(historyPath)) {
      try {
        existingHistory = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
      } catch (e) { }
    }

    const minuteStr = timeNowStr.substring(0, 5);
    const alignedSec = Math.floor(state.currentTimeSeconds / 60) * 60;

    const newHistoryPoint = {
      time: minuteStr,
      sec: alignedSec,
      spot: state.spot,
      ...state.latestGex,
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
      if (!tickerStates[ticker].latestGex || !fs.existsSync(openChainPath)) {
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
      return {
        time: h.time,
        date: h.date || historyDate,
        sec: h.sec,
        spot: h.spot,
        globalTotalGex: h.globalTotalGex,
        realtimeTotalGex: h.realtimeTotalGex,
        gexChange: h.gexChange,
        globalCallWall: h.globalCallWall,
        globalPutWall: h.globalPutWall,
        globalZeroGamma: h.globalZeroGamma,
        realtimeCallWall: h.realtimeCallWall,
        realtimePutWall: h.realtimePutWall,
        realtimeZeroGamma: h.realtimeZeroGamma,
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

  app.listen(PORT, async () => {
    logger.info(`==========================================`);
    logger.info(`GEX Structure Engine is running at:`);
    logger.info(`http://localhost:${PORT}`);
    logger.info(`==========================================`);
  });
}
