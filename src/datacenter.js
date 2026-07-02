/**
 * @file datacenter.js
 * @description 所有云端接口数据获取的统一客户端，包含超时控制与重试机制。
 */

const dns = require('dns');
const env = require('./env');
const logger = require('./utils/logger')('data');

dns.setDefaultResultOrder('ipv4first');

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

/**
 * 拉取指定标的的 Benzinga 期权链数据
 * @param {string} ticker 
 * @returns {Promise<any>}
 */
async function fetchOptionChain(ticker) {
  const url = `https://data-api.benzinga.com/rest/v1/optionchain?apikey=${env.BENZINGA_API_KEY}&symbols=${ticker.toUpperCase()}`;
  const response = await fetchWithRetry(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
  }, 10000);
  if (response.status !== 200) {
    throw new Error(`Benzinga optionchain returned status ${response.status}`);
  }
  return response.json();
}

async function fetchOpeningChain(ticker) {
  return fetchOptionChain(ticker);
}

async function fetchLiveChain(ticker) {
  return fetchOptionChain(ticker);
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
  
  const response = await fetchWithRetry(url, {
    headers: {
      'Accept': 'application/json',
      'Cookie': env.BENZINGA_COOKIE,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
  }, 10000);

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

module.exports = {
  fetchOptionChain,
  fetchOpeningChain,
  fetchLiveChain,
  fetchLiveTrades,
  fetchQuotes,
  fetchQuotePrices
};
