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
