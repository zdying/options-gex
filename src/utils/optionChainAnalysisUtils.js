const {
  getExpirationDayDiff,
  getOptionGroupExpiration
} = require('./sharedUtils');

function inferUnderlyingPrice(chainData) {
  if (!chainData || !chainData.optionChains || chainData.optionChains.length === 0) {
    return null;
  }
  const tickerChain = chainData.optionChains[0];
  if (!tickerChain || !tickerChain.chains || tickerChain.chains.length === 0) {
    return null;
  }

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

  spotEstimates.sort((a, b) => a - b);
  const mid = Math.floor(spotEstimates.length / 2);
  return spotEstimates.length % 2 !== 0
    ? spotEstimates[mid]
    : (spotEstimates[mid - 1] + spotEstimates[mid]) / 2;
}

function filterMatrixByExpiry(matrix, currentDateStr, expiryFilter = 'all') {
  if (expiryFilter === 'all') return matrix || [];
  return (matrix || []).filter(contract => {
    const expDate = new Date(contract.expiration + 'T00:00:00Z');
    const curDate = new Date(currentDateStr + 'T00:00:00Z');
    const diffDays = Math.round((expDate - curDate) / (1000 * 60 * 60 * 24));
    if (expiryFilter === '0dte') return diffDays === 0;
    if (expiryFilter === 'weekly') return diffDays >= 0 && diffDays <= 5;
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

function filterOptionChainByExpiration(chainData, baseDateStr, minDays = 1, maxDays = 14) {
  if (!chainData || !Array.isArray(chainData.optionChains)) {
    return chainData;
  }

  return {
    ...chainData,
    optionChains: chainData.optionChains.map(tickerChain => {
      if (!tickerChain || !Array.isArray(tickerChain.chains)) {
        return tickerChain;
      }

      return {
        ...tickerChain,
        chains: tickerChain.chains.filter(group => {
          const expirationStr = getOptionGroupExpiration(group);
          const diffDays = getExpirationDayDiff(baseDateStr, expirationStr);
          return Number.isFinite(diffDays) && diffDays >= minDays && diffDays <= maxDays;
        })
      };
    })
  };
}

module.exports = {
  inferUnderlyingPrice,
  filterMatrixByExpiry,
  buildExpiryViews,
  filterOptionChainByExpiration
};
