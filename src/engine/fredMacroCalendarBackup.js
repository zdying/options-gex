const logger = require('../utils/logger')('fredMacroCalendarBackup');

// 备份模块：这是旧版 FRED 宏观日历逻辑，目前主服务不再调用。
// 保留它是为了以后 Finviz 不可用时，可以快速恢复 CPI/NFP/PPI/FOMC 的兜底方案。

const FOMC_DATES = new Set([
  '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17',
  '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09'
]);

const FRED_RELEASE_LABELS = {
  10: 'CPI',
  50: 'NFP',
  46: 'PPI'
};

const macroEventDates = new Set([...FOMC_DATES]);

/**
 * 带超时和重试的请求工具。
 * 这里独立实现，避免备份模块依赖 server.js 内部函数。
 */
async function fetchWithRetry(url, options = {}, timeout = 10000, maxRetries = 3, delay = 2000) {
  if (!options.headers) {
    options.headers = {};
  }
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
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

/**
 * 从 FRED release/dates 接口加载某个 release 的发布日期。
 * 旧逻辑只用于 CPI/NFP/PPI 这类官方 release 日期。
 */
async function fetchFredReleaseDates(releaseId, apiKey) {
  const url = `https://api.stlouisfed.org/fred/release/dates?release_id=${releaseId}&api_key=${apiKey}&file_type=json&include_release_dates_with_no_data=true&realtime_start=2026-06-01`;
  const releaseLabel = FRED_RELEASE_LABELS[releaseId] || `Release ${releaseId}`;

  try {
    const res = await fetchWithRetry(url, { headers: { 'Accept': 'application/json' } }, 10000);
    if (res.status === 200) {
      const data = await res.json();
      if (data && Array.isArray(data.release_dates)) {
        const loadedDates = [];
        data.release_dates.forEach(d => {
          if (d.date) {
            macroEventDates.add(d.date);
            loadedDates.push(d.date);
          }
        });
        logger.info(`[FRED Backup] Loaded ${data.release_dates.length} dates for ${releaseLabel}`);
        logger.info(`[FRED Backup] ${releaseLabel} dates: ${loadedDates.length ? loadedDates.join(', ') : 'none'}`);
      }
    } else {
      logger.warn(`[FRED Backup] FRED returned status ${res.status} for Release ID ${releaseId}`);
    }
  } catch (err) {
    logger.error(`[FRED Backup] Failed to fetch dates for Release ID ${releaseId}:`, err.message);
  }
}

/**
 * 初始化旧版 FRED 宏观事件日历。
 * 当前主服务不调用，仅作为后续兜底恢复入口。
 */
async function initializeFredMacroEvents(apiKey = '4e13c5d72bb728e85358893dfae823ae') {
  if (!apiKey) {
    logger.warn('[FRED Backup] No API key. Only static FOMC calendar will be used.');
    return macroEventDates;
  }

  logger.info('[FRED Backup] Initializing FRED macro calendar...');
  logger.info(`[FRED Backup] Static FOMC dates: ${[...FOMC_DATES].join(', ')}`);
  await fetchFredReleaseDates(10, apiKey);
  await fetchFredReleaseDates(50, apiKey);
  await fetchFredReleaseDates(46, apiKey);
  logger.info(`[FRED Backup] Total macro dates loaded: ${macroEventDates.size}`);

  return macroEventDates;
}

/**
 * 获取当前备份日历中的日期集合。
 */
function getFredMacroEventDates() {
  return new Set(macroEventDates);
}

module.exports = {
  FOMC_DATES,
  FRED_RELEASE_LABELS,
  getFredMacroEventDates,
  initializeFredMacroEvents
};
