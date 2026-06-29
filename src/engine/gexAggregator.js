/**
 * @file gexAggregator.js
 * @description Opening OI 与 flow-adjusted realtime GEX 聚合、墙位和 Zero Gamma 计算。
 */

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
