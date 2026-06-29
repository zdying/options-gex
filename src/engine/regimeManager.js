/**
 * @file regimeManager.js
 * @description 状态层 (Regime Layer) 管理器。
 * 评估今天谁在主导市场，输出做市商影响力评分 (Dealer Influence: 0 ~ 100)。
 * 暂支持 Mock 配置，便于后续接入实际的宏观事件与 VIX 指标。
 */

class RegimeManager {
  constructor(config = {}) {
    // 初始分值
    this.defaultScore = config.defaultScore !== undefined ? config.defaultScore : 85;
    
    // 当前状态 Mock 存储
    this.state = {
      hasMacroEvent: false,      // 是否有重大宏观事件 (CPI, FOMC 等)
      hasVolumeSpike: false,     // 开盘 15 分钟成交量是否超过 20 日均值 1.5 倍
      hasVixGap: false,          // VIX 是否跳空
      hasAtrExpansion: false     // ATR 是否异常扩张
    };
  }

  /**
   * 手动更新/配置状态指标 (便于外部传入或 Mock)
   * @param {object} newState - 新状态配置
   */
  updateState(newState) {
    this.state = {
      ...this.state,
      ...newState
    };
  }

  /**
   * 计算做市商定价权评分 (Dealer Influence)
   * @returns {number} 0 ~ 100 评分
   */
  calculateDealerInfluence() {
    let score = 100;

    // 扣分规则：
    // 1. 重大事件发生 (-40)
    if (this.state.hasMacroEvent) {
      score -= 40;
    }
    // 2. 开盘成交量异常扩张 (-20)
    if (this.state.hasVolumeSpike) {
      score -= 20;
    }
    // 3. VIX 跳空 (-20)
    if (this.state.hasVixGap) {
      score -= 20;
    }
    // 4. ATR 异常扩张 (-20)
    if (this.state.hasAtrExpansion) {
      score -= 20;
    }

    // 限制范围在 [0, 100] 之间
    return Math.max(0, Math.min(100, score));
  }

  /**
   * 获取做市商定价权解释文本
   * @param {number} score - 定价权分值
   * @returns {string} 状态描述
   */
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
