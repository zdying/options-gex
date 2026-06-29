/**
 * @file aggregator.js
 * @description 做市商全场持仓压力聚合计算引擎。
 * 汇总全市场所有期权合约的 Greeks 头寸，分别计算 Gamma、Charm、Vanna 产生的压力分量，
 * 最终输出名义交易金额 (Dealer Notional in USD) 作为被迫买卖的加速度指标。
 */

class Aggregator {
  constructor(config = {}) {
    // 压力测试标准场景参数 (保持与 flowProcessor.js 一致)
    this.dS_pct = config.dS_pct !== undefined ? config.dS_pct : 0.005; // dS = Spot * 0.5%
    this.dt_years = config.dt_years !== undefined ? config.dt_years : 30 / (365 * 24 * 60); // dt = 30 分钟 (年化)
    this.dIV = config.dIV !== undefined ? config.dIV : -0.01; // dIV = -1%
  }

  /**
   * 聚合计算全市场做市商的总希腊字母头寸及被迫对冲的名义金额
   * @param {Array<object>} calculatedMatrix - 已计算完 Greeks 和 GEX 的合约列表 (来自 positionStore.calculateMatrixGEX)
   * @param {number} spot - 标的当前价格 (Spot)
   * @returns {object} 返回聚合压力结果 { totalGamma, totalCharm, totalVanna, gammaPressure, charmPressure, vannaPressure, dealerPressure, dealerNotional }
   */
  aggregatePressure(calculatedMatrix, spot) {
    let totalGamma = 0;
    let totalCharm = 0;
    let totalVanna = 0;

    // 1. 汇总全场做市商 Greeks 头寸 (引入 100 倍合约乘数，统一量纲为股数 Shares，并做数值安全防范防止 NaN 污染)
    calculatedMatrix.forEach(contract => {
      const pos = contract.dealerPosition; // 做市商净持仓 (张数)
      const gamma = contract.gamma;
      const charm = contract.charm;
      const vanna = contract.vanna;

      if (!isNaN(pos) && !isNaN(gamma) && !isNaN(charm) && !isNaN(vanna)) {
        totalGamma += pos * 100 * gamma;
        totalCharm += pos * 100 * charm;
        totalVanna += pos * 100 * vanna;
      }
    });

    // 2. 计算压力场景参数
    const dS = spot * this.dS_pct;
    const dt = this.dt_years;
    const dIV = this.dIV;

    // 3. 计算各个分项压力 (做市商被迫对冲股数变动 = -Delta_Change)
    const gammaPressure = -totalGamma * dS;
    const charmPressure = -totalCharm * dt;
    const vannaPressure = -totalVanna * dIV;

    // 4. 计算总对冲压力 (单位为股数 Shares)
    const dealerPressure = gammaPressure + charmPressure + vannaPressure;

    // 5. 转换为名义对冲金额 (USD)
    // 由于 dealerPressure 已经是股数，这里直接乘以股价即可
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
