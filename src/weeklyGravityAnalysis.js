/**
 * @file weeklyGravityAnalysis.js
 * @description 周度市场引力分析。直接运行 `node src/weeklyGravityAnalysis.js` 即可生成报告。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const datacenter = require('./datacenter');
const PositionStore = require('./positionStore');
const GexAggregator = require('./gexAggregator');
const pricingConfig = require('./pricingConfig');
const {
  inferUnderlyingPrice,
  filterOptionChainByExpiration
} = require('./utils/optionChainAnalysisUtils');
const { getExpirationDayDiff } = require('./utils/sharedUtils');

const BASE_DATE = '2026-07-10';
const CALC_TIME = '15:59:50';
const OUTPUT_DIR = path.join(__dirname, '../data/weekly-gravity', BASE_DATE);
const SPOT_RETRIES = 3;
const SPOT_RETRY_DELAY_MS = 800;
const REQUEST_DELAY_MS = 250;

const BASKETS = {
  indexEtfs: ['SPY', 'QQQ', 'IWM', 'DIA'],
  megaCap: ['NVDA', 'AAPL', 'MSFT', 'AMZN', 'META', 'GOOGL', 'TSLA'],
  semis: ['NVDA', 'AMD', 'AVGO', 'MU', 'INTC', 'TSM', 'SMH', 'SOXX', 'SNDK'],
  riskHedges: ['TLT', 'GLD', 'VIX']
};

const WINDOWS = {
  nextWeek: { minDays: 1, maxDays: 7 },
  twoWeeks: { minDays: 1, maxDays: 14 }
};
const GRAVITY_ZONE_LIMIT = 5;
const NEAR_SPOT_PCT = 0.05;
const PULL_BIAS_THRESHOLD = 0.12;
const DISTANCE_WEIGHT_SCALE_PCT = 0.05;

function logInfo(message) {
  console.log(`[WeeklyGravity] ${message}`);
}

function uniqueTickers(baskets) {
  return [...new Set(Object.values(baskets).flat().map(t => t.toUpperCase()))];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchSpotWithFallback(ticker, chainData) {
  for (let i = 0; i < SPOT_RETRIES; i++) {
    const prices = await datacenter.fetchQuotePrices([ticker]);
    const spot = Number(prices[ticker]);
    if (Number.isFinite(spot) && spot > 0) {
      return { spot, spotSource: 'tipranks' };
    }
    if (i < SPOT_RETRIES - 1) {
      await sleep(SPOT_RETRY_DELAY_MS);
    }
  }

  const inferredSpot = Number(inferUnderlyingPrice(chainData));
  if (Number.isFinite(inferredSpot) && inferredSpot > 0) {
    return { spot: inferredSpot, spotSource: 'option_chain' };
  }

  return { spot: null, spotSource: 'unavailable' };
}

function filterMatrixByDayRange(matrix, baseDate, minDays, maxDays) {
  return (matrix || []).filter(contract => {
    const diffDays = getExpirationDayDiff(baseDate, contract.expiration);
    return Number.isFinite(diffDays) && diffDays >= minDays && diffDays <= maxDays;
  });
}

function countChainStats(chainData) {
  if (!chainData || !Array.isArray(chainData.optionChains)) {
    return { expirations: 0, calls: 0, puts: 0, contracts: 0 };
  }

  return chainData.optionChains.reduce((sum, tickerChain) => {
    const chains = Array.isArray(tickerChain && tickerChain.chains) ? tickerChain.chains : [];
    chains.forEach(group => {
      const calls = Array.isArray(group.calls) ? group.calls.length : 0;
      const puts = Array.isArray(group.puts) ? group.puts.length : 0;
      sum.expirations += 1;
      sum.calls += calls;
      sum.puts += puts;
      sum.contracts += calls + puts;
    });
    return sum;
  }, { expirations: 0, calls: 0, puts: 0, contracts: 0 });
}

function summarizeWindow(rawSummary, matrix, spot) {
  const referenceUpperGravity = rawSummary.globalCallWall || null;
  const referenceLowerGravity = rawSummary.globalPutWall || null;
  const referenceGravityAxis = rawSummary.globalZeroGamma || null;
  const distribution = analyzeGravityDistribution(matrix, spot);

  return {
    contractCount: rawSummary.contractCount || 0,
    netGravity: round(rawSummary.globalTotalGex),
    totalAbsGravity: distribution.totalAbsGravity,
    upperAbsGravity: distribution.upperAbsGravity,
    lowerAbsGravity: distribution.lowerAbsGravity,
    upperAbsGravityPct: distribution.upperAbsGravityPct,
    lowerAbsGravityPct: distribution.lowerAbsGravityPct,
    rawPullSkew: distribution.rawPullSkew,
    totalWeightedGravity: distribution.totalWeightedGravity,
    upperWeightedGravity: distribution.upperWeightedGravity,
    lowerWeightedGravity: distribution.lowerWeightedGravity,
    upperWeightedGravityPct: distribution.upperWeightedGravityPct,
    lowerWeightedGravityPct: distribution.lowerWeightedGravityPct,
    pullSkew: distribution.weightedPullSkew,
    upperGravityZones: distribution.upperGravityZones,
    lowerGravityZones: distribution.lowerGravityZones,
    nearGravityZones: distribution.nearGravityZones,
    strongestGravityZones: distribution.strongestGravityZones,
    strongestWeightedGravityZones: distribution.strongestWeightedGravityZones,
    gravityCurve: distribution.gravityCurve,
    reference: {
      upperGravity: referenceUpperGravity,
      lowerGravity: referenceLowerGravity,
      gravityAxis: referenceGravityAxis,
      upperDistancePct: distancePct(spot, referenceUpperGravity),
      lowerDistancePct: distancePct(spot, referenceLowerGravity),
      axisDistancePct: distancePct(spot, referenceGravityAxis)
    },
    structure: classifyPullStructure(distribution),
    score: scoreWindow(distribution)
  };
}

function buildTickerAnalysis(ticker, chainData, spot) {
  const store = new PositionStore(pricingConfig);
  const aggregator = new GexAggregator(pricingConfig);
  const filteredChain = filterOptionChainByExpiration(
    chainData,
    BASE_DATE,
    WINDOWS.twoWeeks.minDays,
    WINDOWS.twoWeeks.maxDays
  );

  store.initializeChain(ticker, filteredChain, BASE_DATE);
  store.initializeIVs(ticker, spot, pricingConfig.riskFreeRate, BASE_DATE, CALC_TIME);

  const fullMatrix = store.calculateMatrixGEX(
    ticker,
    spot,
    pricingConfig.riskFreeRate,
    BASE_DATE,
    CALC_TIME
  );

  const windows = {};
  Object.entries(WINDOWS).forEach(([name, range]) => {
    const matrix = filterMatrixByDayRange(fullMatrix, BASE_DATE, range.minDays, range.maxDays);
    const summary = aggregator.buildSummary(matrix, spot);
    windows[name] = summarizeWindow({
      ...summary,
      contractCount: matrix.length
    }, matrix, spot);
  });

  return {
    ticker,
    spot: round(spot, 2),
    contracts: fullMatrix.length,
    chainStats: {
      raw: countChainStats(chainData),
      filtered: countChainStats(filteredChain)
    },
    windows
  };
}

async function analyzeTicker(ticker) {
  const chainData = await datacenter.fetchOptionChain(ticker);
  const rawStats = countChainStats(chainData);
  logInfo(`${ticker} chain fetched: expirations=${rawStats.expirations}, contracts=${rawStats.contracts} (${rawStats.calls}C/${rawStats.puts}P)`);

  const { spot, spotSource } = await fetchSpotWithFallback(ticker, chainData);
  logInfo(`${ticker} spot=${Number.isFinite(spot) ? round(spot, 2) : 'N/A'} source=${spotSource}`);

  if (!Number.isFinite(spot) || spot <= 0) {
    logInfo(`${ticker} skipped: no usable spot price`);
    return {
      ticker,
      status: 'skipped',
      error: 'No usable spot price'
    };
  }

  const analysis = buildTickerAnalysis(ticker, chainData, spot);
  logInfo(`${ticker} filtered chain: expirations=${analysis.chainStats.filtered.expirations}, contracts=${analysis.chainStats.filtered.contracts} (${analysis.chainStats.filtered.calls}C/${analysis.chainStats.filtered.puts}P)`);
  logInfo(`${ticker} matrix contracts=${analysis.contracts}, nextWeek=${analysis.windows.nextWeek.contractCount}, twoWeeks=${analysis.windows.twoWeeks.contractCount}`);

  if (analysis.contracts === 0) {
    logInfo(`${ticker} skipped: no contracts in analysis window`);
    return {
      ticker,
      status: 'skipped',
      spot: round(spot, 2),
      spotSource,
      error: 'No contracts in analysis window'
    };
  }

  return {
    status: 'ok',
    spotSource,
    ...analysis
  };
}

function analyzeGroup(name, tickers, tickerResults, windowName = 'nextWeek') {
  const members = tickers
    .map(ticker => tickerResults[ticker])
    .filter(result => {
      const window = result && result.windows && result.windows[windowName];
      return result && result.status === 'ok' && window && window.contractCount > 0;
    });

  if (members.length === 0) {
    return {
      name,
      tickers,
      available: 0,
      bias: '数据不足',
      agreementScore: 0,
      leaders: [],
      laggards: []
    };
  }

  const scored = members.map(result => ({
    ticker: result.ticker,
    score: result.windows[windowName].score,
    structure: result.windows[windowName].structure,
    pullSkew: result.windows[windowName].pullSkew,
    rawPullSkew: result.windows[windowName].rawPullSkew,
    upperWeightedGravityPct: result.windows[windowName].upperWeightedGravityPct,
    lowerWeightedGravityPct: result.windows[windowName].lowerWeightedGravityPct,
    upperAbsGravityPct: result.windows[windowName].upperAbsGravityPct,
    lowerAbsGravityPct: result.windows[windowName].lowerAbsGravityPct
  }));
  const avgScore = scored.reduce((sum, item) => sum + item.score, 0) / scored.length;

  return {
    name,
    tickers,
    available: members.length,
    bias: classifyGroupBias(avgScore),
    agreementScore: round(avgScore * 100, 0),
    leaders: scored.filter(item => item.score > 0.35).map(item => item.ticker),
    laggards: scored.filter(item => item.score < -0.35).map(item => item.ticker),
    structures: scored
  };
}

function buildMarketView(groups) {
  const indexScore = groups.indexEtfs ? groups.indexEtfs.agreementScore : 0;
  const megaCapScore = groups.megaCap ? groups.megaCap.agreementScore : 0;
  const semisScore = groups.semis ? groups.semis.agreementScore : 0;
  const riskSignal = groups.riskHedges ? groups.riskHedges.bias : '数据不足';
  const composite = round((indexScore * 0.45 + megaCapScore * 0.35 + semisScore * 0.2), 0);

  return {
    state: classifyGroupBias(composite / 100),
    compositeScore: composite,
    riskSignal,
    notes: [
      `指数ETF: ${groups.indexEtfs ? groups.indexEtfs.bias : '数据不足'}`,
      `核心权重: ${groups.megaCap ? groups.megaCap.bias : '数据不足'}`,
      `半导体链: ${groups.semis ? groups.semis.bias : '数据不足'}`,
      `风险/避险: ${groups.riskHedges ? groups.riskHedges.bias : '数据不足'}`
    ]
  };
}

async function runWeeklyGravityAnalysis() {
  const tickerResults = {};
  const tickers = uniqueTickers(BASKETS);

  for (const ticker of tickers) {
    try {
      logInfo(`Analyzing ${ticker}...`);
      tickerResults[ticker] = await analyzeTicker(ticker);
    } catch (err) {
      logInfo(`${ticker} error: ${err.message}`);
      tickerResults[ticker] = {
        ticker,
        status: 'error',
        error: err.message
      };
    }
    await sleep(REQUEST_DELAY_MS);
  }

  const groups = {};
  Object.entries(BASKETS).forEach(([name, basketTickers]) => {
    groups[name] = analyzeGroup(name, basketTickers, tickerResults, 'nextWeek');
  });

  const report = {
    baseDate: BASE_DATE,
    calculationTime: CALC_TIME,
    generatedAt: new Date().toISOString(),
    windows: WINDOWS,
    baskets: BASKETS,
    marketView: buildMarketView(groups),
    groups,
    tickers: tickerResults
  };

  await fs.promises.mkdir(OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(OUTPUT_DIR, 'report.json');
  await fs.promises.writeFile(outputPath, JSON.stringify(report, null, 2));
  renderCharts(outputPath, OUTPUT_DIR);
  logInfo(`Market view: ${report.marketView.state}, score=${report.marketView.compositeScore}, risk=${report.marketView.riskSignal}`);
  logInfo(`Report saved to ${outputPath}`);

  return report;
}

function renderCharts(reportPath, outputDir) {
  const scriptPaths = [
    path.join(__dirname, '../scripts/render_weekly_gravity_charts.js'),
    path.join(__dirname, '../scripts/render_weekly_market_overview.js')
  ];

  scriptPaths.forEach(scriptPath => {
    const result = spawnSync(process.execPath, [scriptPath, reportPath, outputDir], {
      encoding: 'utf8'
    });

    if (result.error) {
      logInfo(`Chart rendering skipped: ${path.basename(scriptPath)}: ${result.error.message}`);
      return;
    }

    if (result.stdout) {
      result.stdout.trim().split('\n').forEach(line => logInfo(line));
    }

    if (result.status !== 0) {
      const details = result.stderr ? result.stderr.trim() : `exit code ${result.status}`;
      logInfo(`Chart rendering failed (${path.basename(scriptPath)}): ${details}`);
    }
  });
}

function analyzeGravityDistribution(matrix, spot) {
  const rows = {};

  (matrix || []).forEach(contract => {
    const strike = Number(contract.strike);
    const gex = Number(contract.globalGex);
    if (!Number.isFinite(strike) || !Number.isFinite(gex)) return;

    if (!rows[strike]) {
      rows[strike] = { strike, netGravity: 0, absGravity: 0 };
    }
    rows[strike].netGravity += gex;
    rows[strike].absGravity += Math.abs(gex);
  });

  const zones = Object.values(rows)
    .map(zone => {
      const distance = distancePct(spot, zone.strike);
      const distanceRatio = Math.abs(Number(distance) || 0) / 100;
      const distanceWeight = getDistanceWeight(distanceRatio);
      return {
        strike: zone.strike,
        netGravity: round(zone.netGravity),
        absGravity: round(zone.absGravity),
        weightedGravity: round(zone.absGravity * distanceWeight),
        distancePct: distance,
        distanceWeight: round(distanceWeight, 4)
      };
    })
    .filter(zone => zone.absGravity !== null && zone.absGravity > 0)
    .sort((a, b) => b.absGravity - a.absGravity);

  const upperZones = zones.filter(zone => zone.strike > spot);
  const lowerZones = zones.filter(zone => zone.strike < spot);
  const nearZones = zones.filter(zone => Math.abs(Number(zone.distancePct)) <= NEAR_SPOT_PCT * 100);
  const weightedZones = [...zones].sort((a, b) => b.weightedGravity - a.weightedGravity);

  const upperAbsGravity = sumAbsGravity(upperZones);
  const lowerAbsGravity = sumAbsGravity(lowerZones);
  const totalAbsGravity = upperAbsGravity + lowerAbsGravity;
  const upperWeightedGravity = sumWeightedGravity(upperZones);
  const lowerWeightedGravity = sumWeightedGravity(lowerZones);
  const totalWeightedGravity = upperWeightedGravity + lowerWeightedGravity;

  return {
    totalAbsGravity: round(totalAbsGravity),
    upperAbsGravity: round(upperAbsGravity),
    lowerAbsGravity: round(lowerAbsGravity),
    upperAbsGravityPct: totalAbsGravity > 0 ? round((upperAbsGravity / totalAbsGravity) * 100, 2) : null,
    lowerAbsGravityPct: totalAbsGravity > 0 ? round((lowerAbsGravity / totalAbsGravity) * 100, 2) : null,
    rawPullSkew: totalAbsGravity > 0 ? round((upperAbsGravity - lowerAbsGravity) / totalAbsGravity, 2) : 0,
    totalWeightedGravity: round(totalWeightedGravity),
    upperWeightedGravity: round(upperWeightedGravity),
    lowerWeightedGravity: round(lowerWeightedGravity),
    upperWeightedGravityPct: totalWeightedGravity > 0 ? round((upperWeightedGravity / totalWeightedGravity) * 100, 2) : null,
    lowerWeightedGravityPct: totalWeightedGravity > 0 ? round((lowerWeightedGravity / totalWeightedGravity) * 100, 2) : null,
    weightedPullSkew: totalWeightedGravity > 0 ? round((upperWeightedGravity - lowerWeightedGravity) / totalWeightedGravity, 2) : 0,
    upperGravityZones: upperZones.slice(0, GRAVITY_ZONE_LIMIT),
    lowerGravityZones: lowerZones.slice(0, GRAVITY_ZONE_LIMIT),
    nearGravityZones: nearZones.slice(0, GRAVITY_ZONE_LIMIT),
    strongestGravityZones: zones.slice(0, GRAVITY_ZONE_LIMIT),
    strongestWeightedGravityZones: weightedZones.slice(0, GRAVITY_ZONE_LIMIT),
    gravityCurve: [...zones].sort((a, b) => a.strike - b.strike)
  };
}

function scoreWindow(distribution) {
  return clamp(round(distribution.weightedPullSkew || 0, 2), -1, 1);
}

function classifyPullStructure(distribution) {
  const skew = Number(distribution.weightedPullSkew) || 0;
  const totalAbsGravity = Number(distribution.totalAbsGravity) || 0;
  const nearZones = Array.isArray(distribution.nearGravityZones) ? distribution.nearGravityZones : [];

  if (totalAbsGravity <= 0) return 'unclear-pull';
  if (Math.abs(skew) < PULL_BIAS_THRESHOLD && nearZones.length >= 2) return 'near-balanced-pull';
  if (Math.abs(skew) < PULL_BIAS_THRESHOLD) return 'balanced-pull';
  return skew > 0 ? 'upward-pull' : 'downward-pull';
}

function sumAbsGravity(zones) {
  return zones.reduce((sum, zone) => sum + (Number(zone.absGravity) || 0), 0);
}

function sumWeightedGravity(zones) {
  return zones.reduce((sum, zone) => sum + (Number(zone.weightedGravity) || 0), 0);
}

function getDistanceWeight(distanceRatio) {
  return 1 / (1 + distanceRatio / DISTANCE_WEIGHT_SCALE_PCT);
}

function classifyGroupBias(score) {
  if (score >= 0.35) return '偏强';
  if (score <= -0.35) return '偏弱';
  if (score >= 0.12) return '震荡偏强';
  if (score <= -0.12) return '震荡偏弱';
  return '拉扯/中性';
}

function distancePct(spot, level) {
  const value = Number(level);
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(spot) || spot <= 0) {
    return null;
  }
  return round(((value - spot) / spot) * 100, 2);
}

function round(value, digits = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const scale = 10 ** digits;
  return Math.round(num * scale) / scale;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

if (require.main === module) {
  runWeeklyGravityAnalysis().catch(err => {
    console.error('[WeeklyGravity] Failed:', err);
    process.exitCode = 1;
  });
}

module.exports = {
  runWeeklyGravityAnalysis,
  analyzeTicker,
  buildTickerAnalysis,
  BASKETS,
  WINDOWS
};
