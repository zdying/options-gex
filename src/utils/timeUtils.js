/**
 * @file timeUtils.js
 * @description 时区与时间计算工具函数（锁定美东时间 America/New_York）。
 */

/**
 * 获取美东时间当前日期字符串 (YYYY-MM-DD)
 * @returns {string}
 */
function getEstDate() {
  const parts = getEstParts();
  const yyyy = String(parts.year);
  const mm = String(parts.month).padStart(2, '0');
  const dd = String(parts.day).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * 获取美东时间当前时间的详细秒数和字符串信息
 * @returns {{ timeStr: string, timeStrCompact: string, seconds: number }}
 */
function getEstTime() {
  const parts = getEstParts();
  const hh = String(parts.hour).padStart(2, '0');
  const mm = String(parts.minute).padStart(2, '0');
  const ss = String(parts.second).padStart(2, '0');
  return {
    timeStr: `${hh}:${mm}:${ss}`,
    timeStrCompact: `${hh}${mm}${ss}`,
    seconds: parts.hour * 3600 + parts.minute * 60 + parts.second
  };
}

function getEstParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const parts = {};
  formatter.formatToParts(date).forEach(part => {
    if (part.type !== 'literal') {
      parts[part.type] = Number(part.value);
    }
  });
  if (parts.hour === 24) {
    parts.hour = 0;
  }
  return parts;
}

/**
 * 将总秒数转换为 "HH:MM:SS" 格式的时间字符串
 * @param {number} sec 
 * @returns {string}
 */
function formatTime(sec) {
  const h = Math.floor(sec / 3600).toString().padStart(2, '0');
  const m = Math.floor((sec % 3600) / 60).toString().padStart(2, '0');
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

module.exports = {
  getEstDate,
  getEstParts,
  getEstTime,
  formatTime
};
