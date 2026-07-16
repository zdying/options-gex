/**
 * Stream Benzinga option chain responses and stop after a target expiration.
 *
 * The Benzinga response is shaped like:
 * {
 *   "optionChains": [
 *     {
 *       "symbol": "QQQ",
 *       "chains": [
 *         { "mmy": "20260716", ... },
 *         ...
 *       ]
 *     }
 *   ]
 * }
 *
 * This module avoids parsing the whole body. It reads until the chains array is
 * found, extracts complete chain objects one at a time, and aborts the request
 * once the target expiration has been captured.
 */

const DEFAULT_TIMEOUT_MS = 20000;

function normalizeMmy(value) {
  if (!value) return null;
  const str = String(value).replace(/-/g, '');
  return /^\d{8}$/.test(str) ? str : null;
}

function extractStringField(jsonText, fieldName) {
  const pattern = new RegExp(`"${fieldName}"\\s*:\\s*"([^"]*)"`);
  const match = pattern.exec(jsonText);
  return match ? match[1] : null;
}

function findChainsArrayStart(buffer) {
  const keyIdx = buffer.indexOf('"chains"');
  if (keyIdx === -1) return -1;

  const colonIdx = buffer.indexOf(':', keyIdx + 8);
  if (colonIdx === -1) return -1;

  const arrayIdx = buffer.indexOf('[', colonIdx + 1);
  return arrayIdx === -1 ? -1 : arrayIdx + 1;
}

function findFirstObjectStart(buffer) {
  for (let i = 0; i < buffer.length; i += 1) {
    const ch = buffer[i];
    if (ch === '{') return i;
    if (ch === ']') return -2;
  }
  return -1;
}

function findCompleteJsonObjectEnd(buffer, startIdx = 0) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIdx; i < buffer.length; i += 1) {
    const ch = buffer[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }

  return -1;
}

function pruneBufferBeforeChains(buffer) {
  const start = findChainsArrayStart(buffer);
  if (start === -1) {
    const keyIdx = buffer.indexOf('"chains"');
    if (keyIdx !== -1) {
      return { buffer: buffer.slice(keyIdx), found: false };
    }
    return { buffer: buffer.slice(-64), found: false };
  }
  return { buffer: buffer.slice(start), found: true };
}

function makeOptionChainResult(symbol, chains) {
  return {
    optionChains: [
      {
        symbol: String(symbol || '').toUpperCase(),
        chains
      }
    ]
  };
}

async function readBodyStream(response, onText) {
  if (!response.body) {
    onText(await response.text());
    return;
  }

  if (typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onText(decoder.decode(value, { stream: true }));
    }
    const tail = decoder.decode();
    if (tail) onText(tail);
    return;
  }

  response.body.setEncoding('utf8');
  for await (const chunk of response.body) {
    onText(chunk);
  }
}

/**
 * Fetch an option chain and stop after the target expiration.
 *
 * @param {object} params
 * @param {string} params.symbol
 * @param {string} params.targetMmy - YYYYMMDD or YYYY-MM-DD.
 * @param {typeof fetch} [params.fetchImpl]
 * @param {number} [params.timeoutMs]
 * @param {object} [params.headers]
 * @param {boolean} [params.includeTarget=true]
 * @returns {Promise<{data: object, meta: object}>}
 */
async function fetchOptionChainUntilExpiration(params) {
  const {
    symbol,
    targetMmy,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    headers = {},
    includeTarget = true
  } = params || {};

  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  const cutoffMmy = normalizeMmy(targetMmy);

  if (!normalizedSymbol) throw new Error('symbol is required');
  if (!cutoffMmy) throw new Error('targetMmy must be YYYYMMDD or YYYY-MM-DD');
  if (typeof fetchImpl !== 'function') throw new Error('fetchImpl must be a function');

  const url = `https://data-api.benzinga.com/rest/v1/optionchain?apikey=2RiuR92vjytxS8r93w3c8WTpGSd3y9Gk&symbols=${encodeURIComponent(normalizedSymbol)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const chains = [];
  const meta = {
    symbol: normalizedSymbol,
    targetMmy: cutoffMmy,
    stoppedEarly: false,
    matchedTarget: false,
    readBytes: 0,
    jsonParseMs: 0,
    parsedChains: 0
  };

  let buffer = '';
  let chainsStarted = false;
  let shouldAbort = false;

  function consumeChunk(text) {
    if (shouldAbort || !text) return;

    meta.readBytes += Buffer.byteLength(text);
    buffer += text;

    if (!chainsStarted) {
      const result = pruneBufferBeforeChains(buffer);
      chainsStarted = result.found;
      buffer = result.buffer;
      if (!chainsStarted) {
        return;
      }
    }

    while (!shouldAbort) {
      const objectStart = findFirstObjectStart(buffer);
      if (objectStart === -2) return;
      if (objectStart === -1) {
        buffer = buffer.slice(-64);
        return;
      }
      if (objectStart > 0) {
        buffer = buffer.slice(objectStart);
      }

      const objectEnd = findCompleteJsonObjectEnd(buffer, 0);
      if (objectEnd === -1) return;

      const objectText = buffer.slice(0, objectEnd);
      buffer = buffer.slice(objectEnd);

      const mmy = normalizeMmy(extractStringField(objectText, 'mmy'));
      if (mmy && mmy > cutoffMmy) {
        meta.stoppedEarly = true;
        shouldAbort = true;
        controller.abort();
        return;
      }

      if (!mmy || mmy < cutoffMmy || includeTarget) {
        const parseStartedAt = Date.now();
        chains.push(JSON.parse(objectText));
        meta.jsonParseMs += Date.now() - parseStartedAt;
        meta.parsedChains += 1;
      }

      if (mmy === cutoffMmy) {
        meta.matchedTarget = true;
        meta.stoppedEarly = true;
        shouldAbort = true;
        controller.abort();
        return;
      }
    }
  }

  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0',
        ...headers
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Benzinga optionchain returned status ${response.status}`);
    }

    await readBodyStream(response, consumeChunk);
  } catch (err) {
    if (!shouldAbort || err.name !== 'AbortError') {
      throw err;
    }
  } finally {
    clearTimeout(timeout);
  }

  return {
    data: makeOptionChainResult(normalizedSymbol, chains),
    meta
  };
}

module.exports = {
  fetchOptionChainUntilExpiration,
  normalizeMmy,
  findCompleteJsonObjectEnd
};
