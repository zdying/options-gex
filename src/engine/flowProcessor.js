/**
 * @file flowProcessor.js
 * @description 做市商订单流压力计算引擎。
 * 对每笔大单计算其对做市商未来对冲所造成的 Pressure Shock，
 * 并通过 100 笔大单的线性衰减加权计算 Raw_DPI，
 * 最终采用 95% 分位数（防雷点 2）对 DPI 进行归一化，输出 [-100, 100] 的做市商压力指数。
 */

const { determineTradeDirection } = require('../utils/sharedUtils');

class FlowProcessor {
  constructor(config = {}) {
    // 最近 100 笔大单的 Pressure Shock 队列
    this.recentShocks = [];
    this.maxRecentSize = 100;

    // 历史 Raw_DPI 绝对值队列，用于计算 95% 分位数 (防雷点 2)
    // 缓存规模设为 10000 笔，足以代表过去一段时间的分布
    this.historicalRawDpis = [];
    this.maxHistorySize = config.maxHistorySize || 10000;

    // 95% 分位数值缓存，避免每笔订单都重新排序计算，每 100 笔更新一次
    this.cachedPercentileDenominator = 1.0;
    this.tradeCounter = 0;

    // 标准场景测试参数
    this.dS_pct = config.dS_pct !== undefined ? config.dS_pct : 0.005; // dS = Spot * 0.5%
    this.dt_years = config.dt_years !== undefined ? config.dt_years : 30 / (365 * 24 * 60); // dt = 30 分钟 (年化)
    this.dIV = config.dIV !== undefined ? config.dIV : -0.01; // dIV = -1%
  }

  /**
   * 清空处理器状态
   */
  clear() {
    this.recentShocks = [];
    this.historicalRawDpis = [];
    this.cachedPercentileDenominator = 1.0;
    this.tradeCounter = 0;
  }

  /**
   * 处理一笔大单交易，计算其 Pressure Shock 及 DPI
   * @param {object} trade - 大单数据对象
   * @param {object} greeks - 当前合约的希腊字母 { delta, gamma, charm, vanna } (已 clamping)
   * @param {number} spot - 标的当前价格 (Spot)
   * @returns {object} 返回计算结果 { pressureShock, rawDPI, dpi }
   */
  processTrade(trade, greeks, spot) {
    const contracts = parseInt(trade.size, 10) || 0;
    if (contracts <= 0) {
      return { pressureShock: 0, rawDPI: 0, dpi: 0 };
    }

    // 1. 确定做市商方向符号
    const positionSign = this._determinePositionSign(trade);

    // 2. 将希腊字母转换至做市商视角
    const dealerGamma = positionSign * greeks.gamma;
    const dealerCharm = positionSign * greeks.charm;
    const dealerVanna = positionSign * greeks.vanna;

    // 3. 计算标准压力场景下的波动步长
    const dS = spot * this.dS_pct;
    const dt = this.dt_years;
    const dIV = this.dIV;

    // 4. 根据 Taylor 展开式计算这笔大单的 Pressure Shock (做市商被迫对冲股数变动 = -Delta_Change)
    // Pressure_Shock = -Contracts * 100 * (Dealer_Gamma * dS + Dealer_Charm * dt + Dealer_Vanna * dIV)
    const pressureShock = -contracts * 100 * (
      dealerGamma * dS +
      dealerCharm * dt +
      dealerVanna * dIV
    );

    // 5. 维护最近 100 笔大单的 shock 队列 (最新大单推入队头)
    this.recentShocks.unshift(pressureShock);
    if (this.recentShocks.length > this.maxRecentSize) {
      this.recentShocks.pop();
    }

    // 6. 线性衰减加权计算 Raw_DPI
    const rawDPI = this._calculateRawDPI();

    // 7. 将当前的 Raw_DPI 绝对值推入历史队列用于归一化
    const absRawDPI = Math.abs(rawDPI);
    if (absRawDPI > 1e-4) {
      this.historicalRawDpis.push(absRawDPI);
      if (this.historicalRawDpis.length > this.maxHistorySize) {
        this.historicalRawDpis.shift();
      }
    }

    // 8. 触发 95% 分位数计算 (解决小 Ticker 与前几笔成交的分母锁死问题)
    this.tradeCounter++;
    
    // 如果是前 100 笔，我们每次都重新计算分母以动态更新；100笔之后每 100 笔更新一次以防性能开销
    if (this.tradeCounter < 100 || this.tradeCounter % 100 === 0 || this.cachedPercentileDenominator <= 100.0) {
      const sampleCount = this.historicalRawDpis.length;
      const percentileValue = this._calculatePercentile(this.historicalRawDpis, 95);
      
      // 动态底噪分母：防除以 0 以及防第一二笔大单直接把 DPI 锁死顶格至 100
      // 我们设定底噪为 spot * 2.0 (如股价 200 则底噪为 400)，但最低不小于 200.0
      const defaultBaseDenominator = Math.max(200.0, spot * 2.0);
      
      // 在历史交易笔数较少 (少于 50 笔) 时进行渐进平滑过渡
      // 随着成交笔数增加，分母从基准默认底噪逐渐平滑向 95% 分位数过渡
      const weight = Math.min(1.0, sampleCount / 50.0);
      const mixedDenominator = weight * percentileValue + (1.0 - weight) * defaultBaseDenominator;
      
      this.cachedPercentileDenominator = Math.max(100.0, mixedDenominator);
    }

    // 9. 归一化计算最终 DPI [-100, 100]
    let dpi = 0;
    if (this.cachedPercentileDenominator > 1e-4) {
      dpi = (rawDPI / this.cachedPercentileDenominator) * 100;
    }
    // 强制限制在 [-100, 100] 范围内
    dpi = Math.max(-100, Math.min(100, dpi));

    return {
      pressureShock,
      rawDPI,
      dpi
    };
  }

  /**
   * 内部方法：计算线性衰减加权的 Raw_DPI
   * 最新成交权重为 1.00，依次递减 0.01，直至第 100 笔权重为 0.01
   * @private
   */
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

  /**
   * 内部方法：计算数组的 p 百分位数
   * @private
   */
  _calculatePercentile(arr, p) {
    if (arr.length === 0) {
      return 1.0; // 默认防除以 0
    }
    
    // 对数组克隆并排序
    const sorted = [...arr].sort((a, b) => a - b);
    const index = Math.ceil((p / 100.0) * sorted.length) - 1;
    const value = sorted[Math.max(0, index)];
    
    // 如果算出来 95% 分位数接近 0，则返回 1.0 保护归一化
    return value > 1e-4 ? value : 1.0;
  }

  /**
   * 内部方法：根据成交估计判定做市商的持仓增减符号
   * @private
   */
  _determinePositionSign(trade) {
    const direction = determineTradeDirection(trade.execution_estimate, trade.aggressor_ind);
    if (direction === 'BUY') {
      return -1; // 客户买入，做市商卖出 (短头寸 -1)
    }
    if (direction === 'SELL') {
      return 1; // 客户卖出，做市商买入 (长头寸 1)
    }
    return 0; // 中性不产生方向性对冲压力
  }
}

module.exports = FlowProcessor;
