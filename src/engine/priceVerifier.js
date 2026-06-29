/**
 * @file priceVerifier.js
 * @description 价格验证层 (Price Layer) 管理器。
 * 结合标的资产价格、VWAP 以及做市商压力指标，验证做市商的对冲流预测是否已在股票市场开始兑现。
 */

class PriceVerifier {
  constructor(config = {}) {
    // 判定中性的压力的阈值，如果绝对值低于此阈值，视为中性
    this.pressureThreshold = config.pressureThreshold !== undefined ? config.pressureThreshold : 1e4;
  }

  /**
   * 验证做市商模型当前是否生效
   * @param {number} spot - 当前价格 (Spot)
   * @param {number} vwap - 当前成交量加权平均价 (VWAP)
   * @param {number} dealerPressure - 当前做市商总压力 (Deltas 或名义对冲金额)
   * @returns {object} 返回验证状态 { status, reason }
   */
  verifyModel(spot, vwap, dealerPressure) {
    // 如果压力非常小，视为中性状态，不进行趋势匹配
    if (Math.abs(dealerPressure) < this.pressureThreshold) {
      return {
        status: 'NEUTRAL',
        reason: '做市商对冲压力接近 0，处于中性震荡状态。'
      };
    }

    const isPriceAboveVwap = spot > vwap;
    
    // 1. 买盘压力大 (Dealer Pressure > 0)
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

    // 2. 卖盘压力大 (Dealer Pressure < 0)
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
