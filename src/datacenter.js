/**
 * @file datacenter.js
 * @description 所有云端接口数据获取的统一客户端，包含超时控制与重试机制。
 */

const dns = require('dns');
const env = require('./env');
const logger = require('./utils/logger')('data');
const { getEstDate } = require('./utils/timeUtils');
const { fetchOptionChainUntilExpiration } = require('./benzingaOptionChainStream');

dns.setDefaultResultOrder('ipv4first');

logger.info(`Using Benzinga Token: ${env.BENZINGA_COOKIE}`);

const OPTION_CHAIN_TIMEOUT_MS = 20000;
const OPTION_CHAIN_MAX_RETRIES = 3;
const OPTION_CHAIN_RETRY_DELAY_MS = 500;
const OPTION_CHAIN_DEFAULT_MAX_DAYS = 14;
const BENZINGA_OPTIONCHAIN_HEADERS = {
  'Accept': 'application/json',
  'Connection': 'close',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
};

/**
 * 辅助工具：带超时控制与失败重试机制的 fetch 请求，支持 Connection: close 避免 keep-alive 假死
 */
async function fetchWithRetry(url, options = {}, timeout = 20000, maxRetries = 3, delay = 500) {
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

function addDaysToDateString(dateStr, days) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

function getOptionChainTargetMmy(options = {}) {
  if (options.targetMmy) {
    return options.targetMmy;
  }
  const maxDays = Number.isFinite(options.maxDays)
    ? options.maxDays
    : OPTION_CHAIN_DEFAULT_MAX_DAYS;
  return addDaysToDateString(getEstDate(), maxDays);
}

/**
 * 拉取指定标的的 Benzinga 期权链数据
 * @param {string} ticker
 * @returns {Promise<any>}
 */
async function fetchOptionChain(ticker, options = {}) {
  const uppercaseTicker = ticker.toUpperCase();
  const targetMmy = getOptionChainTargetMmy(options);
  const timeout = options.timeoutMs || OPTION_CHAIN_TIMEOUT_MS;
  const maxRetries = options.maxRetries || OPTION_CHAIN_MAX_RETRIES;
  const retryDelay = options.retryDelayMs || OPTION_CHAIN_RETRY_DELAY_MS;

  for (let i = 0; i < maxRetries; i++) {
    const startedAt = Date.now();
    let responseAt = startedAt;
    let chainContentLength = 0;

    try {
      const result = await fetchOptionChainUntilExpiration({
        symbol: uppercaseTicker,
        targetMmy,
        timeoutMs: timeout,
        headers: BENZINGA_OPTIONCHAIN_HEADERS,
        fetchImpl: async (url, fetchOptions) => {
          const response = await fetch(url, fetchOptions);
          responseAt = Date.now();
          chainContentLength = Number(response.headers.get('content-length')) || 0;
          return response;
        }
      });

      if (options.metrics) {
        options.metrics.chainHttp = responseAt - startedAt;
        options.metrics.chainContentLength = chainContentLength;
        options.metrics.chainReadBody = Date.now() - responseAt;
        options.metrics.chainJsonParse = result.meta.jsonParseMs || 0;
        options.metrics.chainBodyBytes = result.meta.readBytes || 0;
      }
      return result.data;
    } catch (error) {
      if (i === maxRetries - 1) {
        throw error;
      }
      logger.warn(`[API] Stream optionchain failed/timeout for ${uppercaseTicker}. Retrying in ${retryDelay}ms... (${i + 1}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
}

async function fetchOpeningChain(ticker, options = {}) {
  return fetchOptionChain(ticker, options);
}

async function fetchLiveChain(ticker, options = {}) {
  return fetchOptionChain(ticker, options);
}

/**
 * 分页拉取增量大单数据
 * @param {number} lastUpdatedCursor
 * @returns {Promise<any>}
 */
async function fetchLiveTrades(lastUpdatedCursor) {
  const params = new URLSearchParams({
    pagesize: 200,
    'parameters[updated]': lastUpdatedCursor,
    'parameters[dateSearchField]': 'target'
  });
  const url = `https://api.benzinga.com/api/v1/signal/option_activity?${params.toString()}`;

  logger.debug(`[Trades] Fetching live trades with cursor ${lastUpdatedCursor}, cookie: ${env.BENZINGA_COOKIE}`);

  const response = await fetchWithRetry(url, {
    headers: {
      'Accept': 'application/json',
      'Cookie': env.BENZINGA_COOKIE,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
  }, 20000);

  if (response.status !== 200) {
    throw new Error(`Benzinga trades returned status ${response.status}`);
  }
  return response.json();
}

/**
 * 批量拉取多个 ticker 的实时报价并提取股价
 * @param {string[]} tickers
 * @returns {Promise<Record<string, number>>}
 */
async function fetchQuotes(tickers) {
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
    const res = await fetchWithRetry(url, { headers: { 'Accept': 'application/json' } }, 10000, 2, 1000);
    if (res.status !== 200) {
      logger.warn(`[Quotes] TipRanks returned status ${res.status} for ${uniqueTickers.join(',')}`);
      return {};
    }

    const data = await res.json();
    const prices = {};
    if (data && Array.isArray(data.quotes)) {
      data.quotes.forEach(quote => {
        const ticker = String(quote.ticker || '').toUpperCase();
        const regularPrice = parseFloat(quote.price);
        if (ticker && !isNaN(regularPrice) && regularPrice > 0) {
          prices[ticker] = regularPrice;
        }
      });
    }
    return prices;
  } catch (err) {
    logger.warn(`[Quotes] Failed to fetch TipRanks quotes for ${uniqueTickers.join(',')}: ${err.message}`);
    return {};
  }
}

async function fetchQuotePrices(tickers) {
  return fetchQuotes(tickers);
}

async function fetchProPlusUsers() {
  if (!env.PRO_PLUS_USERS_AUTHORIZATION) {
    throw new Error('PRO_PLUS_USERS_AUTHORIZATION is not configured');
  }

  const host = 'https://app.kairalert.pro';
  const url = `${host}/api/internal/pro-plus-users`;

  const response = await fetchWithRetry(url, {
    headers: {
      'Accept': 'application/json',
      'Authorization': env.PRO_PLUS_USERS_AUTHORIZATION
    }
  }, 10000);

  if (response.status !== 200) {
    throw new Error(`Pro plus users API returned status ${response.status}`);
  }

  const data = await response.json();

  if (!data || !Array.isArray(data.users)) {
    throw new Error('Pro plus users API returned invalid users payload');
  }

  return data.users;
}

module.exports = {
  fetchOptionChain,
  fetchOpeningChain,
  fetchLiveChain,
  fetchLiveTrades,
  fetchQuotes,
  fetchQuotePrices,
  fetchProPlusUsers
};
