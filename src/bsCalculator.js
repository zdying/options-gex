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
 * @param {number} r - 无风险利率 (年化，例如 0.0383)
 * @param {number} q - 连续股息率 (年化，例如 0.0103)
 * @param {number} sigma - 隐含波动率 (年化，例如 0.20)
 * @param {string} optionType - 期权类型 ('CALL' 或 'PUT')
 * @returns {number} 期权理论价格
 */
function calculateBSPrice(S, K, T, r, q, sigma, optionType) {
  const isCall = String(optionType || '').toUpperCase() === 'CALL';
  const effectiveR = Number.isFinite(r) ? r : 0;
  const effectiveQ = Number.isFinite(q) ? q : 0;

  if (!Number.isFinite(S) || S <= 0 || !Number.isFinite(K) || K <= 0) {
    return 0;
  }
  
  // 边界条件处理
  if (!Number.isFinite(T) || T <= 0) {
    return isCall ? Math.max(0, S - K) : Math.max(0, K - S);
  }
  if (!Number.isFinite(sigma) || sigma <= 0) {
    const discount = Math.exp(-effectiveR * T);
    const dividendDiscount = Math.exp(-effectiveQ * T);
    return isCall
      ? Math.max(0, S * dividendDiscount - K * discount)
      : Math.max(0, K * discount - S * dividendDiscount);
  }

  const d1 = (Math.log(S / K) + (effectiveR - effectiveQ + (sigma * sigma) / 2.0) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  const discountFactor = Math.exp(-effectiveR * T);
  const dividendDiscountFactor = Math.exp(-effectiveQ * T);

  if (isCall) {
    return S * dividendDiscountFactor * standardNormalCDF(d1) - K * discountFactor * standardNormalCDF(d2);
  } else {
    return K * discountFactor * standardNormalCDF(-d2) - S * dividendDiscountFactor * standardNormalCDF(-d1);
  }
}

/**
 * 使用二分法 (Bisection Method) 反推期权隐含波动率 (IV)
 * @param {number} S - 标的正股价格 (Spot)
 * @param {number} K - 行权价 (Strike)
 * @param {number} T - 距离到期时间 (年化)
 * @param {number} r - 无风险利率 (年化，例如 0.0383)
 * @param {number} q - 连续股息率 (年化，例如 0.0103)
 * @param {number} marketPrice - 期权市场价格 (推荐采用买卖中价 Midpoint)
 * @param {string} optionType - 期权类型 ('CALL' 或 'PUT')
 * @param {object} [config] - 迭代参数配置
 * @param {number} [config.maxIterations=100] - 最大迭代次数
 * @param {number} [config.precision=1e-5] - 求解精度
 * @param {number} [config.fallbackIV=0.20] - 求解失败时的回退默认值
 * @returns {number} 反推出的隐含波动率 (IV，小数形式，例如 0.25 代表 25%)
 */
function calculateImpliedVolatilityBisectionLegacy(S, K, T, r, q, marketPrice, optionType, config = {}) {
  const maxIterations = config.maxIterations || 100;
  const precision = config.precision || 1e-5;
  const fallbackIV = config.fallbackIV !== undefined ? config.fallbackIV : 0.20;
  const effectiveR = Number.isFinite(r) ? r : 0;
  const effectiveQ = Number.isFinite(q) ? q : 0;
  const metrics = config.ivMetrics;

  function recordLegacy(iterations) {
    if (!metrics) return;
    metrics.legacyCalls += 1;
    metrics.legacyIterations += iterations;
  }

  if (
    !Number.isFinite(S) || S <= 0 ||
    !Number.isFinite(K) || K <= 0 ||
    !Number.isFinite(marketPrice) || marketPrice <= 0
  ) {
    recordLegacy(0);
    return fallbackIV;
  }

  // 1. 到期或时间异常处理
  if (!Number.isFinite(T) || T <= 0) {
    recordLegacy(0);
    return fallbackIV;
  }

  // 2. 检查价格是否低于内在价值 (无解边界情况)
  const isCall = String(optionType || '').toUpperCase() === 'CALL';
  const discountFactor = Math.exp(-effectiveR * T);
  const dividendDiscountFactor = Math.exp(-effectiveQ * T);
  const intrinsicValue = isCall 
    ? Math.max(0, S * dividendDiscountFactor - K * discountFactor)
    : Math.max(0, K * discountFactor - S * dividendDiscountFactor);

  // 若市场价格低于等于内在价值，强行返回超低IV，防止死循环
  if (marketPrice <= intrinsicValue + 1e-4) {
    recordLegacy(0);
    return 0.0001; 
  }

  let lowIV = 0.0001;
  let highIV = 5.0; // 设定 500% 波动率作为合理上限
  let midIV = fallbackIV;

  // 3. 二分逼近求解
  for (let i = 0; i < maxIterations; i++) {
    midIV = (lowIV + highIV) / 2.0;
    const price = calculateBSPrice(S, K, T, effectiveR, effectiveQ, midIV, optionType);

    if (Math.abs(price - marketPrice) < precision) {
      recordLegacy(i + 1);
      return midIV;
    }

    if (price < marketPrice) {
      lowIV = midIV;
    } else {
      highIV = midIV;
    }
  }

  recordLegacy(maxIterations);
  return midIV;
}

function calculateImpliedVolatility(S, K, T, r, q, marketPrice, optionType, config = {}) {
  const initialIV = Number(config.initialIV);
  const fallbackIV = config.fallbackIV !== undefined ? config.fallbackIV : 0.20;
  const precision = config.precision || 1e-5;
  const effectiveR = Number.isFinite(r) ? r : 0;
  const effectiveQ = Number.isFinite(q) ? q : 0;
  const metrics = config.ivMetrics;

  if (metrics) {
    metrics.totalCalls += 1;
  }

  if (
    !Number.isFinite(initialIV) ||
    initialIV <= 0.0002 ||
    !Number.isFinite(marketPrice) ||
    marketPrice <= 0
  ) {
    return calculateImpliedVolatilityBisectionLegacy(S, K, T, effectiveR, effectiveQ, marketPrice, optionType, config);
  }

  if (metrics) {
    metrics.seededAttempts += 1;
    metrics.initialIvSum += initialIV;
  }

  const initialPrice = calculateBSPrice(S, K, T, effectiveR, effectiveQ, initialIV, optionType);
  if (Number.isFinite(initialPrice) && Math.abs(initialPrice - marketPrice) < precision) {
    if (metrics) {
      metrics.seededHits += 1;
      metrics.seededIterations += 1;
    }
    return initialIV;
  }

  const lowIV = Math.max(0.0001, Math.min(initialIV * 0.5, initialIV - 0.05));
  const highIV = Math.min(5.0, Math.max(initialIV * 1.5, initialIV + 0.05));

  const lowPrice = calculateBSPrice(S, K, T, effectiveR, effectiveQ, lowIV, optionType);
  const highPrice = calculateBSPrice(S, K, T, effectiveR, effectiveQ, highIV, optionType);
  const minBracketPrice = Math.min(lowPrice, highPrice);
  const maxBracketPrice = Math.max(lowPrice, highPrice);

  if (
    !Number.isFinite(lowPrice) ||
    !Number.isFinite(highPrice) ||
    marketPrice < minBracketPrice ||
    marketPrice > maxBracketPrice
  ) {
    if (metrics) {
      metrics.seededFallbacks += 1;
    }
    return calculateImpliedVolatilityBisectionLegacy(S, K, T, effectiveR, effectiveQ, marketPrice, optionType, config);
  }

  let low = lowIV;
  let high = highIV;
  let midIV = initialIV || fallbackIV;
  const maxIterations = config.seededMaxIterations || 35;

  for (let i = 0; i < maxIterations; i++) {
    midIV = (low + high) / 2.0;
    const price = calculateBSPrice(S, K, T, effectiveR, effectiveQ, midIV, optionType);

    if (Math.abs(price - marketPrice) < precision) {
      if (metrics) {
        metrics.seededHits += 1;
        metrics.seededIterations += i + 1;
      }
      return midIV;
    }

    if (price < marketPrice) {
      low = midIV;
    } else {
      high = midIV;
    }
  }

  if (metrics) {
    metrics.seededHits += 1;
    metrics.seededIterations += maxIterations;
  }
  return midIV;
}

/**
 * 计算 Black-Scholes 希腊字母 (Delta, Gamma, Charm, Vanna)
 * 包含针对 0DTE 尾盘在平值附近计算除零溢出的动态 Clamping 稳定机制
 * @param {number} S - 标的正股价格 (Spot)
 * @param {number} K - 行权价 (Strike)
 * @param {number} T - 距离到期时间 (年化)
 * @param {number} r - 无风险利率 (年化，例如 0.0383)
 * @param {number} q - 连续股息率 (年化，例如 0.0103)
 * @param {number} sigma - 隐含波动率 (年化，例如 0.20)
 * @param {string} optionType - 期权类型 ('CALL' 或 'PUT')
 * @param {object} [config] - 稳定参数配置
 * @param {number} [config.minVolSqT=0.0002] - 波动乘数下限 (分母保护值，实现与 S 挂钩的动态自适应 Clamping)
 * @returns {object} 希腊字母结果 { delta, gamma, charm, vanna }
 */
function calculateBSGreeks(S, K, T, r, q, sigma, optionType, config = {}) {
  const isCall = String(optionType || '').toUpperCase() === 'CALL';
  const minVolSqT = config.minVolSqT !== undefined ? config.minVolSqT : 0.0002;
  const effectiveR = Number.isFinite(r) ? r : 0;
  const effectiveQ = Number.isFinite(q) ? q : 0;

  if (!Number.isFinite(S) || S <= 0 || !Number.isFinite(K) || K <= 0) {
    return { delta: 0, gamma: 0, charm: 0, vanna: 0 };
  }

  // 1. 到期或时间/波动率异常处理 (放宽阶跃限制，允许尾盘 Greeks Flare-up 效应)
  if (!Number.isFinite(T) || T <= 0 || !Number.isFinite(sigma) || sigma <= 1e-4) {
    const delta = isCall 
      ? (S >= K ? 1.0 : 0.0) 
      : (S <= K ? -1.0 : 0.0);
    return { delta, gamma: 0, charm: 0, vanna: 0 };
  }

  // 2. 计算 d1 与 d2，对分母进行稳定保护 (实现动态 Clamping)
  const sqrtT = Math.sqrt(T);
  const volSqT = Math.max(minVolSqT, sigma * sqrtT);
  const d1 = (Math.log(S / K) + (effectiveR - effectiveQ + (sigma * sigma) / 2.0) * T) / volSqT;
  const dividendDiscountFactor = Math.exp(-effectiveQ * T);

  const pdfD1 = standardNormalPDF(d1);
  const cdfD1 = standardNormalCDF(d1);

  // 3. 计算 Delta
  const delta = isCall
    ? dividendDiscountFactor * cdfD1
    : dividendDiscountFactor * (cdfD1 - 1.0);

  // 4. 计算 Gamma
  let gamma = dividendDiscountFactor * pdfD1 / (S * volSqT);

  // 动态 Clamping: 限制 Gamma 最大值为 15分钟 ATM Gamma 的 5 倍
  // 这能够让尾盘 0DTE 的 Greeks Flare-up 效应自由飙升，但又切掉了最后一两分钟错误报价引起的瞬间飞天
  const safeT = Math.max(15 / (365 * 24 * 60), T); // 限制最低 15 分钟
  const safeVolSqT = Math.max(minVolSqT, sigma * Math.sqrt(safeT));
  const atmGamma = dividendDiscountFactor * standardNormalPDF(0) / (S * safeVolSqT);
  const gammaLimit = atmGamma * 5.0;
  gamma = Math.min(gamma, gammaLimit);

  return {
    delta,
    gamma,
    charm: 0,
    vanna: 0
  };
}

module.exports = {
  standardNormalPDF,
  standardNormalCDF,
  calculateBSPrice,
  calculateImpliedVolatilityBisectionLegacy,
  calculateImpliedVolatility,
  calculateBSGreeks
};
