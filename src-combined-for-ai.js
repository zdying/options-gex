// Combined src code for AI debugging
// Generated from files under src. Original source files were not modified.

// ============================================================
// FILE: src/calculator/bsCalculator.js
// ============================================================
/**
 * @file bsCalculator.js
 * @description Black-Scholes 期权定价模型及希腊字母 (Delta, Gamma, Charm, Vanna) 计算引擎。
 * 包含二分法隐含波动率 (IV) 反推算法，以及针对 0DTE 尾盘非线性飙升的安全限幅 (Clamping) 逻辑。
 * 无外部依赖，高复用性。
 */

/**
 * 标准正态分布的概率密度函数 (PDF)
 * @param {number} x - 输入数值
 * @returns {number} 概率密度值
 */
function standardNormalPDF(x) {
  return Math.exp(-x * x / 2.0) / Math.sqrt(2.0 * Math.PI);
}

/**
 * 标准正态分布的累积分布函数 (CDF)
 * 采用 Abramowitz & Stegun (26.2.17) 高精度近似公式，最大误差 < 7.5e-8
 * @param {number} x - 输入数值
 * @returns {number} 累积概率值
 */
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

/**
 * 使用 Black-Scholes 公式计算期权理论价格
 * @param {number} S - 标的正股价格 (Spot)
 * @param {number} K - 行权价 (Strike)
 * @param {number} T - 距离到期时间 (年化，例如 1/365 表示 1 天)
 * @param {number} r - 无风险利率 (年化，例如 0.05)
 * @param {number} sigma - 隐含波动率 (年化，例如 0.20)
 * @param {string} optionType - 期权类型 ('CALL' 或 'PUT')
 * @returns {number} 期权理论价格
 */
function calculateBSPrice(S, K, T, r, sigma, optionType) {
  const isCall = optionType.toUpperCase() === 'CALL';
  
  // 边界条件处理
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

/**
 * 使用二分法 (Bisection Method) 反推期权隐含波动率 (IV)
 * @param {number} S - 标的正股价格 (Spot)
 * @param {number} K - 行权价 (Strike)
 * @param {number} T - 距离到期时间 (年化)
 * @param {number} r - 无风险利率 (年化，例如 0.05)
 * @param {number} marketPrice - 期权市场价格 (推荐采用买卖中价 Midpoint)
 * @param {string} optionType - 期权类型 ('CALL' 或 'PUT')
 * @param {object} [config] - 迭代参数配置
 * @param {number} [config.maxIterations=100] - 最大迭代次数
 * @param {number} [config.precision=1e-5] - 求解精度
 * @param {number} [config.fallbackIV=0.20] - 求解失败时的回退默认值
 * @returns {number} 反推出的隐含波动率 (IV，小数形式，例如 0.25 代表 25%)
 */
function calculateImpliedVolatility(S, K, T, r, marketPrice, optionType, config = {}) {
  const maxIterations = config.maxIterations || 100;
  const precision = config.precision || 1e-5;
  const fallbackIV = config.fallbackIV !== undefined ? config.fallbackIV : 0.20;

  // 1. 到期或时间异常处理
  if (T <= 0 || isNaN(T)) {
    return fallbackIV;
  }

  // 2. 检查价格是否低于内在价值 (无解边界情况)
  const isCall = optionType.toUpperCase() === 'CALL';
  const discountFactor = Math.exp(-r * T);
  const intrinsicValue = isCall 
    ? Math.max(0, S - K * discountFactor)
    : Math.max(0, K * discountFactor - S);

  // 若市场价格低于等于内在价值，强行返回超低IV，防止死循环
  if (marketPrice <= intrinsicValue + 1e-4) {
    return 0.0001; 
  }

  let lowIV = 0.0001;
  let highIV = 5.0; // 设定 500% 波动率作为合理上限
  let midIV = fallbackIV;

  // 3. 二分逼近求解
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

/**
 * 计算 Black-Scholes 希腊字母 (Delta, Gamma, Charm, Vanna)
 * 包含针对 0DTE 尾盘在平值附近计算除零溢出的动态 Clamping 稳定机制
 * @param {number} S - 标的正股价格 (Spot)
 * @param {number} K - 行权价 (Strike)
 * @param {number} T - 距离到期时间 (年化)
 * @param {number} r - 无风险利率 (年化，例如 0.05)
 * @param {number} sigma - 隐含波动率 (年化，例如 0.20)
 * @param {string} optionType - 期权类型 ('CALL' 或 'PUT')
 * @param {object} [config] - 稳定参数配置
 * @param {number} [config.minVolSqT=0.0002] - 波动乘数下限 (分母保护值，实现与 S 挂钩的动态自适应 Clamping)
 * @returns {object} 希腊字母结果 { delta, gamma, charm, vanna }
 */
function calculateBSGreeks(S, K, T, r, sigma, optionType, config = {}) {
  const isCall = optionType.toUpperCase() === 'CALL';
  const minVolSqT = config.minVolSqT !== undefined ? config.minVolSqT : 0.0002;

  // 1. 到期或时间/波动率异常处理 (放宽阶跃限制，允许尾盘 Greeks Flare-up 效应)
  if (T <= 0 || isNaN(T) || sigma <= 1e-4) {
    const delta = isCall 
      ? (S >= K ? 1.0 : 0.0) 
      : (S <= K ? -1.0 : 0.0);
    return { delta, gamma: 0, charm: 0, vanna: 0 };
  }

  // 2. 计算 d1 与 d2，对分母进行稳定保护 (实现动态 Clamping)
  const sqrtT = Math.sqrt(T);
  const volSqT = Math.max(minVolSqT, sigma * sqrtT);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2.0) * T) / volSqT;
  const d2 = d1 - volSqT;

  const pdfD1 = standardNormalPDF(d1);
  const cdfD1 = standardNormalCDF(d1);

  // 3. 计算 Delta
  const delta = isCall ? cdfD1 : cdfD1 - 1.0;

  // 4. 计算 Gamma
  let gamma = pdfD1 / (S * volSqT);

  // 动态 Clamping: 限制 Gamma 最大值为 15分钟 ATM Gamma 的 5 倍
  // 这能够让尾盘 0DTE 的 Greeks Flare-up 效应自由飙升，但又切掉了最后一两分钟错误报价引起的瞬间飞天
  const safeT = Math.max(15 / (365 * 24 * 60), T); // 限制最低 15 分钟
  const safeVolSqT = Math.max(minVolSqT, sigma * Math.sqrt(safeT));
  const atmGamma = standardNormalPDF(0) / (S * safeVolSqT);
  const gammaLimit = atmGamma * 5.0;
  gamma = Math.min(gamma, gammaLimit);

  // 5. 计算 Charm (Delta 随时间衰减率: dDelta / dt = -dDelta / dT)
  // 保护 T 避免除 0，并利用已稳定的 volSqT 计算
  const term1 = d2 / (2.0 * Math.max(1e-6, T));
  const term2 = r / volSqT;
  const charm = pdfD1 * (term1 - term2);

  // 6. 计算 Vanna (Delta 随波动率变化率: dDelta / dSigma = dVega / dS)
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

// ============================================================
// FILE: src/engine/aggregator.js
// ============================================================
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

// ============================================================
// FILE: src/engine/decisionEngine.js
// ============================================================
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

// ============================================================
// FILE: src/engine/flowProcessor.js
// ============================================================
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

// ============================================================
// FILE: src/engine/priceVerifier.js
// ============================================================
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

// ============================================================
// FILE: src/engine/regimeManager.js
// ============================================================
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

// ============================================================
// FILE: src/server.js
// ============================================================
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
const { calculateImpliedVolatility, calculateBSGreeks } = require('./calculator/bsCalculator');
const { calculateT, clampTradingTime } = require('./utils/sharedUtils');
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
const FlowProcessor = require('./engine/flowProcessor');
const Aggregator = require('./engine/aggregator');
const RegimeManager = require('./engine/regimeManager');
const PriceVerifier = require('./engine/priceVerifier');
const DecisionEngine = require('./engine/decisionEngine');

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
const store = new PositionStore({ oiFactor: 0.5 });
const aggregator = new Aggregator();
const regimeManager = new RegimeManager();
const priceVerifier = new PriceVerifier();
const decisionEngine = new DecisionEngine();

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
const GEX_IV_DISPLAY_T = 1.0 / 365.0;
const GEX_MIN_REALTIME_DISPLAY_T = 1.0 / (365.0 * 24.0 * 60.0);
const liveTickerCounts = {};
const knownSignalIds = new Set();
let lastUpdatedCursor = 0;

// Bug #12: 宏观事件日历支持 (FOMC 会议日程写死，CPI/NFP/PPI 动态从 FRED API 拉取)
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
  const apiKey = '4e13c5d72bb728e85358893dfae823ae'; // process.env.FRED_API_KEY;
  if (!apiKey) {
    logger.warn(`[MacroEvents] No FRED_API_KEY environment variable found. Only static FOMC calendar will be used.`);
    return;
  }
  logger.info(`[MacroEvents] Initializing macro calendar from FRED API...`);
  await fetchFredReleaseDates(10, apiKey); // CPI (ID: 10)
  await fetchFredReleaseDates(50, apiKey); // NFP (ID: 50)
  await fetchFredReleaseDates(46, apiKey); // PPI (ID: 46)
  logger.info(`[MacroEvents] Total macro event dates loaded: ${macroEventDates.size}`);
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

// 快速获取某时刻 GEX 暴露的静态汇总数据，用于纯前端的高速回放
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
    gexRealTimeValues.push(strikeGexRealTime[k] / 1e6); // 折算为百万美元
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

/**
 * 断点高精度时序回补：利用 trades.json 和期权定价反推，重建缺失的分钟走势数据
 */
function backfillHistoryPoints(ticker, existingTrades, existingHistory, flowProcessorInstance) {
  const todayStr = getEstDateStr();
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

  if (flowProcessorInstance) {
    flowProcessorInstance.clear();
  }

  let vwapVolume = 0;
  let vwapNotional = 0;

  // 如果大单为空且没有任何快照，则不需要回补
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

      const tradePrice = parseFloat(trade.underlying_price);
      const tradeSize = parseInt(trade.size) || 0;
      if (!isNaN(tradePrice) && tradePrice > 0 && tradeSize > 0) {
        vwapVolume += tradeSize;
        vwapNotional += tradePrice * tradeSize;
      }

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

    // 执行 Greeks 与 DPI 生成并加入历史（即使没有今日的开盘 chainData，只要 store 里面有合约就行）
    // clamp：收盘后(>= 16:00)统一用 15:59:50，防止 T=0 导致 GEX 全部归零
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

      // DPI 与决策报告计算
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

  // 4. 对 history 数据进行最终的整分去重与对齐保护，清洗可能残留的重复分钟点
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

  // 重置做市商大单压力队列，防止旧的压力数据跨天污染
  if (state.flowProcessor) {
    state.flowProcessor.clear();
  }

  // 6. 恢复历史大单，重建做市商今天的 Dealer 持仓状态并执行断点高精度历史回补
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

          // Bug #15: 防御 spot 为 null
          if (!state.spot) {
            return;
          }
          const greeks = calculateBSGreeks(state.spot, strike, T, 0.05, iv, type, {});
          let latestDpi = 0;
          if (state.flowProcessor) {
            const result = state.flowProcessor.processTrade(trade, greeks, state.spot);
            latestDpi = result.dpi;
          }

          // 更新实时加权 VWAP
          const tradePrice = parseFloat(trade.underlying_price);
          const tradeSize = parseInt(trade.size) || 0;
          if (!isNaN(tradePrice) && tradePrice > 0 && tradeSize > 0) {
            state.vwapVolume = (state.vwapVolume || 0) + tradeSize;
            state.vwapNotional = (state.vwapNotional || 0) + tradePrice * tradeSize;
            state.vwap = state.vwapNotional / state.vwapVolume;
          }

          // 更新最新报告中的 DPI 数值
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
  const finalMatrix = store.calculateMatrixGEX(ticker, state.spot, 0.05, todayStr, clampedTimeNowStr);
  const matrixViews = buildExpiryViews(finalMatrix, todayStr);
  const gexSummary = buildGexSummaries(matrixViews, state.spot);
  state.calculatedMatrix = finalMatrix;
  state.matrixViews = matrixViews;
  state.gexSummary = gexSummary;

  const aggPressure = aggregator.aggregatePressure(finalMatrix, state.spot);

  // Bug #12: 宏观事件评估与定价权自动扣分计算
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

  const minuteStr = timeNowStr.substring(0, 5); // 例如 "18:52"
  const alignedSec = Math.floor(state.currentTimeSeconds / 60) * 60; // 对齐整分秒数，例如 67920

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
    if (!tickerStates[ticker].latestReport || !fs.existsSync(openChainPath)) {
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

// 启动 Express 监听并加载宏观日历
app.listen(PORT, async () => {
  await initializeMacroEvents();
  logger.info(`==========================================`);
  logger.info(`Dealer Pressure Engine v2.0 is running at:`);
  logger.info(`🚀 http://localhost:${PORT}`);
  logger.info(`==========================================`);
});

// ============================================================
// FILE: src/store/positionStore.js
// ============================================================
/**
 * @file positionStore.js
 * @description 做市商期权持仓矩阵存储与更新管理器。
 * 负责管理各标的资产 (Ticker) 的期权持仓，并支持开盘利用 Benzinga 全期权链数据进行底仓初始化，
 * 以及盘中根据交易流水进行增量异步修正，避免高频读写冲突。
 */

const { calculateBSGreeks, calculateImpliedVolatility } = require('../calculator/bsCalculator');
const { calculateT, calculateDayT, determineTradeDirection } = require('../utils/sharedUtils');

class PositionStore {
  constructor(config = {}) {
    // 内存持仓字典：{ [ticker]: { [optionSymbol]: optionContractObject } }
    this.store = {};
    
    // 默认配置
    this.oiFactor = config.oiFactor !== undefined ? config.oiFactor : 0.5;
  }

  /**
   * 清空存储器
   */
  clear() {
    this.store = {};
  }

  /**
   * 使用 Benzinga 完整期权链数据初始化指定 Ticker 的持仓矩阵
   * @param {string} ticker - 标的资产代码 (如 "AAPL")
   * @param {object} benzingaChain - Benzinga 期权链 API 响应对象
   */
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

    // 遍历每一个到期日的分组
    tickerChain.chains.forEach(expiryGroup => {
      const expirationDateStr = this._parseExpirationDate(expiryGroup.mmy); // 将 YYYYMMDD 转为 YYYY-MM-DD
      
      // 过滤到期日，最多两个星期内（14天）
      // Bug #14: 显式指定美东时区防止时区歧义
      const expDate = new Date(expirationDateStr + 'T00:00:00-04:00');
      const curDate = new Date(currentDateStr + 'T00:00:00-04:00');
      const diffDays = Math.round((expDate - curDate) / (1000 * 60 * 60 * 24));
      if (diffDays < 0 || diffDays > 14) {
        return; // 跳过
      }

      // 处理 Calls
      if (expiryGroup.calls) {
        expiryGroup.calls.forEach(opt => {
          this._registerOption(uppercaseTicker, opt, 'CALL', expirationDateStr);
        });
      }

      // 处理 Puts
      if (expiryGroup.puts) {
        expiryGroup.puts.forEach(opt => {
          this._registerOption(uppercaseTicker, opt, 'PUT', expirationDateStr);
        });
      }
    });
  }

  /**
   * 盘中收到大单交易时，增量更新做市商的持仓矩阵
   * @param {string} ticker - 标的资产代码
   * @param {object} trade - 交易数据对象 (格式同 2026-06-18.json 中的记录)
   * @returns {boolean} 是否更新成功
   */
  applyTrade(ticker, trade, currentDateStr = new Date().toISOString().split('T')[0]) {
    const uppercaseTicker = ticker.toUpperCase();
    const symbol = trade.option_symbol;

    // 过滤到期日，最多两个星期内（14天）
    const expirationStr = trade.date_expiration;
    if (expirationStr) {
      // Bug #14: 显式指定美东时区防止时区歧义
      const expDate = new Date(expirationStr + 'T00:00:00-04:00');
      const curDate = new Date(currentDateStr + 'T00:00:00-04:00');
      const diffDays = Math.round((expDate - curDate) / (1000 * 60 * 60 * 24));
      if (diffDays < 0 || diffDays > 14) {
        return false; // 过滤不处理
      }
    }

    // 1. 如果该 Ticker 尚未初始化，则为其创建空字典
    if (!this.store[uppercaseTicker]) {
      this.store[uppercaseTicker] = {};
    }

    // 2. 如果是新发现的期权合约 (可能 API 期权链未覆盖)，先进行动态初始化
    if (!this.store[uppercaseTicker][symbol]) {
      const oi = parseInt(trade.open_interest, 10) || 0;
      const type = trade.put_call.toUpperCase();
      this.store[uppercaseTicker][symbol] = {
        symbol: symbol,
        strike: parseFloat(trade.strike_price),
        type: type,
        expiration: trade.date_expiration,
        openInterest: oi,
        // 根据解耦架构初始化持仓
        structurePosition: type === 'CALL' ? (oi * this.oiFactor) : (-oi * this.oiFactor),
        dealerPosition: -oi * this.oiFactor,
        iv: undefined
      };
    }

    // 3. 计算本笔交易导致的持仓变动量 (PRD Step 2 & 3)
    const size = parseInt(trade.size, 10) || 0;
    const direction = this._determineTradeDirection(trade);
    const contract = this.store[uppercaseTicker][symbol];
    const isCall = contract.type === 'CALL';

    if (direction === 'BUY') {
      // 客户买入，做市商卖出 => 做市商持仓减少
      contract.dealerPosition -= size;
      // 结构层：多头买入 CALL => 多头地形增加；多头买入 PUT => 空头地形增加 (即更加负)
      if (isCall) {
        contract.structurePosition += size;
      } else {
        contract.structurePosition -= size;
      }
    } else if (direction === 'SELL') {
      // 客户卖出，做市商买入 => 做市商持仓增加
      contract.dealerPosition += size;
      // 结构层：多头卖出 CALL => 多头地形减少；多头卖出 PUT => 空头地形减少 (即更加正)
      if (isCall) {
        contract.structurePosition -= size;
      } else {
        contract.structurePosition += size;
      }
    }

    return true;
  }

  /**
   * 获取指定 Ticker 的当前完整持仓矩阵
   * @param {string} ticker - 标的资产代码
   * @returns {Array<object>} 持仓合约数组
   */
  getPositionMatrix(ticker) {
    const uppercaseTicker = ticker.toUpperCase();
    if (!this.store[uppercaseTicker]) {
      return [];
    }
    return Object.values(this.store[uppercaseTicker]);
  }

  /**
   * 根据当前持仓与当前股价，重新计算每个合约的希腊字母和 GEX
   * @param {string} ticker - 标的资产代码
   * @param {number} spot - 当前正股价格
   * @param {number} r - 年化无风险利率 (默认 0.05)
   * @param {string} currentDateStr - 当前计算日期 (YYYY-MM-DD，用于计算剩余期限 T)
   * @param {string} [currentTimeStr="09:30:00"] - 盘中当前时间 (HH:MM:SS)
   * @param {string} [expiryFilter="all"] - 到期日过滤器 (all / 0dte / weekly)
   * @param {object} [greeksConfig] - Clamping 限幅等配置
   * @returns {Array<object>} 计算完 Greeks 和 GEX 后的合约列表
   */
  calculateMatrixGEX(ticker, spot, r, currentDateStr, currentTimeStr = "09:30:00", expiryFilter = "all", greeksConfig = {}) {
    if (!spot) {
      return [];
    }
    const matrix = this.getPositionMatrix(ticker);

    return matrix.map(contract => {
      // 过滤逻辑
      // Bug #14: 显式指定美东时区防止时区歧义
      const expDate = new Date(contract.expiration + 'T00:00:00-04:00');
      const curDate = new Date(currentDateStr + 'T00:00:00-04:00');
      const diffDays = Math.round((expDate - curDate) / (1000 * 60 * 60 * 24));

      // 物理裁剪：最多只保留两星期内（14天）的期权合约
      if (diffDays < 0 || diffDays > 14) {
        return null;
      }

      if (expiryFilter === '0dte' && diffDays !== 0) {
        return null;
      }
      if (expiryFilter === 'weekly' && (diffDays < 1 || diffDays > 5)) {
        return null;
      }

      // 计算日内高频年化剩余期限 T (修复 0DTE T=0 的 Bug)
      // Bug #7: 使用共享工具类计算 T
      const T = calculateT(currentDateStr, currentTimeStr, contract.expiration);

      const marketPrice = contract.midpoint || ((contract.bid + contract.ask) / 2.0) || 0.1;

      // 动态反推实时 IV：使用分钟/秒级 T，供实时 GEX 与 Dealer Pressure 使用
      let ivRealtime = contract.ivRealtime;
      if (ivRealtime === undefined || ivRealtime === null) {
        ivRealtime = calculateImpliedVolatility(spot, contract.strike, T, r, marketPrice, contract.type);
        if (isNaN(ivRealtime) || ivRealtime <= 0.0002) {
          ivRealtime = 0.20; // 实在算不出来的回退默认值为 20%，更贴近真实大盘 (SPY/QQQ) 的底噪 IV
        }
        contract.ivRealtime = ivRealtime;
        contract.iv = ivRealtime; // 兼容旧字段
      }

      // 计算实时 Greeks
      const greeks = calculateBSGreeks(spot, contract.strike, T, r, ivRealtime, contract.type, greeksConfig);

      // 结构层与做市商持仓解耦后，直接利用 structurePosition 进行 GEX 地图计算
      // GEX = structurePosition * Gamma * 100 * Spot^2 * 0.01
      const gex = contract.structurePosition * greeks.gamma * 100 * (spot * spot) * 0.01;

      // 全局地图 GEX：使用静态 OI（即开盘未平仓量）与天级 T/IV
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
        gex: gex, // 用于实时状态
        gexGlobal: gexGlobal // 用于全局地图
      };
    }).filter(item => item !== null);
  }

  /**
   * 批量初始化指定 Ticker 所有合约的 IV (一次性预计算，彻底消除盘中高频二分法 IV 计算瓶颈)
   * @param {string} ticker - 标的资产代码
   * @param {number} spot - 当前正股价格
   * @param {number} r - 无风险利率
   * @param {string} currentDateStr - 当前日期
   * @param {string} currentTimeStr - 当前时间
   */
  initializeIVs(ticker, spot, r, currentDateStr, currentTimeStr = "09:30:00") {
    if (!spot) {
      return;
    }
    const uppercaseTicker = ticker.toUpperCase();
    const matrix = this.getPositionMatrix(uppercaseTicker);
    
    matrix.forEach(contract => {
      // Bug #7: 使用共享工具类计算 T
      const T = calculateT(currentDateStr, currentTimeStr, contract.expiration);
      const marketPrice = contract.midpoint || ((contract.bid + contract.ask) / 2.0) || 0.1;
      let iv = calculateImpliedVolatility(spot, contract.strike, T, r, marketPrice, contract.type);
      if (isNaN(iv) || iv <= 0.0002) {
        iv = 0.20; // 实在算不出的回退默认值为 20%
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

  /**
   * 内部方法：计算剩余年化时间 T (支持日内秒级衰减)
   * @private
   */
  _calculateT(currentDateStr, currentTimeStr, expirationDateStr) {
    return calculateT(currentDateStr, currentTimeStr, expirationDateStr);
  }

  /**
   * 内部方法：注册期权链合约
   * @private
   */
  _registerOption(ticker, opt, type, expirationStr) {
    const symbol = opt.symbol;
    const oi = parseInt(opt.openInterest, 10) || 0;
    
    // 计算买卖中价
    const bid = parseFloat(opt.bidPrice) || 0;
    const ask = parseFloat(opt.askPrice) || 0;
    const midpoint = (bid + ask) / 2.0;

    this.store[ticker][symbol] = {
      symbol: symbol,
      strike: parseFloat(opt.strike),
      type: type,
      expiration: expirationStr,
      openInterest: oi,
      // 结构层与做市商持仓解耦
      structurePosition: type === 'CALL' ? (oi * this.oiFactor) : (-oi * this.oiFactor),
      dealerPosition: -oi * this.oiFactor,
      bid: bid,
      ask: ask,
      midpoint: midpoint,
      iv: undefined // 设为 undefined，便于后续通过初始化或反推填充
    };
  }

  /**
   * 内部方法：解析 API 返回的 MMY 格式 (YYYYMMDD) 为 YYYY-MM-DD
   * @private
   */
  _parseExpirationDate(mmy) {
    if (!mmy || mmy.length !== 8) return mmy;
    return `${mmy.substring(0, 4)}-${mmy.substring(4, 6)}-${mmy.substring(6, 8)}`;
  }

  /**
   * 内部方法：判定盘中大单交易的方向是客户买入（BUY）还是客户卖出（SELL）
   * @private
   */
  _determineTradeDirection(trade) {
    return determineTradeDirection(trade.execution_estimate, trade.aggressor_ind);
  }

  /**
   * 盘中每分钟用最新期权链更新已有合约的报价，供重算实时 Greeks 使用
   * @param {string} ticker - 标的代码
   * @param {object} benzingaChain - Benzinga 期权链 API 响应对象
   */
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
            // 报价变了，强制清除缓存的旧 IV，使后续计算重新反推
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

// ============================================================
// FILE: src/utils/logger.js
// ============================================================
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
      // - Write all logs with importance level of `error` or higher to `error.log`
      // new winston.transports.File({ filename: 'news.log', level: 'error' }),
      // new winston.transports.File({ filename: 'combined.log' }),
    ],
  })
};

// ============================================================
// FILE: src/utils/sharedUtils.js
// ============================================================
/**
 * @file sharedUtils.js
 * @description 共享工具函数，包括年化剩余期限计算、成交方向判定、GEX 结构位识别等
 */

/**
 * 将时间字符串 "HH:MM:SS" 转换成秒数
 * @param {string} timeStr 
 * @returns {number}
 */
function timeStringToSeconds(timeStr) {
  if (!timeStr) return 9.5 * 3600; // 默认 09:30:00
  const [h, m, s] = timeStr.split(':').map(Number);
  return h * 3600 + m * 60 + (s || 0);
}

/**
 * 计算剩余年化时间 T (支持日内秒级衰减，指定东部时区)
 * @param {string} currentDateStr - 当前计算日期 (YYYY-MM-DD)
 * @param {string} currentTimeStr - 当前时间 (HH:MM:SS)
 * @param {string} expirationDateStr - 期权到期日期 (YYYY-MM-DD)
 * @returns {number} 年化剩余时间
 */
function calculateT(currentDateStr, currentTimeStr, expirationDateStr) {
  // Bug #14: 指定美东时区 "T00:00:00-04:00" 解决时区歧义
  const currentDay = new Date(currentDateStr + 'T00:00:00-04:00');
  const expDay = new Date(expirationDateStr + 'T00:00:00-04:00');
  const diffDays = Math.round((expDay - currentDay) / (1000 * 60 * 60 * 24));

  const currentSeconds = timeStringToSeconds(currentTimeStr);
  const closeSeconds = 16 * 3600; // 16:00:00 收盘
  const secondsRemainingToday = Math.max(0, closeSeconds - currentSeconds);

  const totalSecondsRemaining = diffDays * 24 * 3600 + secondsRemainingToday;
  return totalSecondsRemaining / (365 * 24 * 3600);
}

/**
 * 计算天级剩余期限 T，用于稳定的 Global GEX 地图。
 * 0DTE 至少按 1 天处理；其他期限按自然日差处理。
 * @param {string} currentDateStr - 当前计算日期 (YYYY-MM-DD)
 * @param {string} expirationDateStr - 期权到期日期 (YYYY-MM-DD)
 * @returns {number} 年化剩余时间
 */
function calculateDayT(currentDateStr, expirationDateStr) {
  const currentDay = new Date(currentDateStr + 'T00:00:00-04:00');
  const expDay = new Date(expirationDateStr + 'T00:00:00-04:00');
  const diffDays = Math.round((expDay - currentDay) / (1000 * 60 * 60 * 24));
  return Math.max(1, diffDays) / 365.0;
}

/**
 * 根据计算矩阵提取 Call Wall, Put Wall 和 Zero Gamma
 * @param {Array} calculatedMatrix 
 * @returns {object} { callWall, putWall, zeroGamma }
 */
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

/**
 * 判定盘中大单交易的方向是客户买入（BUY）还是客户卖出（SELL）
 * @param {string} executionEstimate - trade.execution_estimate
 * @param {string|number} aggressorInd - trade.aggressor_ind
 * @returns {string} 'BUY' | 'SELL' | 'NEUTRAL'
 */
function determineTradeDirection(executionEstimate, aggressorInd) {
  // Bug #5: 防御 executionEstimate 可能为 undefined/null 的情况
  const est = (executionEstimate || '').toUpperCase();
  if (est === 'AT_ASK' || est === 'ABOVE_ASK') {
    return 'BUY'; // 客户买入
  }
  if (est === 'AT_BID' || est === 'BELOW_BID') {
    return 'SELL'; // 客户卖出
  }
  
  // 如果是中价成交，使用 aggressor_ind 辅助判断
  if (est === 'AT_MIDPOINT') {
    const aggInd = parseFloat(aggressorInd);
    if (!isNaN(aggInd)) {
      return aggInd >= 0.5 ? 'BUY' : 'SELL';
    }
  }

  // 默认作为中性或不影响
  return 'NEUTRAL';
}

/**
 * 将交易时间 clamp 到收盘前最后一个有效时间点
 * 防止 T=0 导致 Black-Scholes 计算返回 gamma=0，进而使 GEX 曲线全部归零
 * @param {string} timeStr - HH:MM:SS 或 HH:MM 格式
 * @returns {string} clamp 后的时间字符串 (>= 16:00:00 时返回 '15:59:50')
 */
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
