/**
 * @file decisionEngine.js
 * @description 决策层 (Decision Layer) 引擎。
 * 整合做市商定价权、市场地形（Call Wall / Put Wall / Zero Gamma）、大单压力 DPI、
 * 全场被迫对冲名义金额以及价格验证结果，生成最终交易结论。
 * 本模块不参与底层数学计算，只做逻辑推理与结论解释。
 */

const { findStructureWalls } = require('../utils/sharedUtils');

class DecisionEngine {
  constructor() {}

  /**
   * 生成最终决策报告
   * @param {object} inputs - 决策输入数据
   * @param {number} inputs.spot - 当前标的价格 (Spot)
   * @param {number} inputs.vwap - 标的交易均价 (VWAP)
   * @param {number} inputs.influenceScore - 做市商影响力得分 (Dealer Influence, 0-100)
   * @param {string} inputs.influenceRegime - 做市商主导状态描述
   * @param {Array<object>} inputs.calculatedMatrix - 已计算 Greeks 与 GEX 的期权链矩阵
   * @param {number} inputs.dpi - 实时大单对冲压力 DPI (-100 到 100)
   * @param {object} inputs.aggPressure - 全场聚合压力结果 (来自 aggregator.aggregatePressure)
   * @param {object} inputs.verification - 价格验证结果 { status, reason }
   * @returns {object} 决策报告 JSON
   */
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

    // 1. 识别实时结构位 (Call Wall / Put Wall / Zero Gamma)
    const walls = this._findStructureWalls(calculatedMatrix);

    // 2. 推理加速与对冲状态
    const notionalUSD = aggPressure.dealerNotional;
    const notionalText = `${(notionalUSD / 1e8).toFixed(2)} 亿美元`;
    
    let bias = 'NEUTRAL (观望)';
    if (dpi > 20 && notionalUSD > 0) {
      bias = 'BULLISH (做市商被迫买入驱动)';
    } else if (dpi < -20 && notionalUSD < 0) {
      bias = 'BEARISH (做市商被迫卖出驱动)';
    }

    // 3. 推理价格加速/减速效应 (结合 PRD 第六层规则)
    let dynamicEffect = '震荡无趋势';
    if (spot > vwap) {
      dynamicEffect = notionalUSD > 0 ? '上涨容易加速' : '上涨容易减速';
    } else if (spot < vwap) {
      dynamicEffect = notionalUSD < 0 ? '下跌容易雪崩' : '下跌容易被缓冲';
    }

    // 4. 生成自然语言形式的解释文本
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

  /**
   * 内部方法：从计算矩阵中提取 Call Wall, Put Wall 和 Zero Gamma
   * @private
   */
  _findStructureWalls(calculatedMatrix) {
    return findStructureWalls(calculatedMatrix, 'gex');
  }

  /**
   * 内部方法：生成自然语言分析文本
   * @private
   */
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
