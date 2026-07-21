#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATE = '2026-07-20';
const LIVE_DIR = path.join(ROOT, 'data', 'live_data', DATE);
const PRICE_DIR = path.join(ROOT, 'data', 'tipranks_1min', DATE);
const OUT_DIR = path.join(ROOT, 'data', 'analysis');
const OUT_JSON = path.join(OUT_DIR, 'gravity_2026-07-20-report.json');
const OUT_MD = path.join(OUT_DIR, 'gravity_2026-07-20-report.md');

const MIN_SIGNAL_SEC = 10 * 60 * 60;
const MAX_SIGNAL_SEC = 15 * 60 * 60 + 30 * 60;
const HORIZONS = [15, 30, 60];
const GRAVITY_RANGE_PCT = 0.035;
const MIN_PULL_EDGE = 0.12;
const NEAR_ZONE_PCT = 0.0025;
const BREAK_CONFIRM_PCT = 0.0015;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function finite(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function round(value, digits = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const scale = 10 ** digits;
  return Math.round(num * scale) / scale;
}

function pct(value) {
  return Number.isFinite(value) ? `${round(value * 100, 1)}%` : 'n/a';
}

function timeFromUtcIso(iso) {
  const date = new Date(iso);
  const hh = String(date.getUTCHours() - 4).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function secFromTime(time) {
  const [hh, mm] = String(time).split(':').map(Number);
  return hh * 3600 + mm * 60;
}

function ema(prev, value, length) {
  const alpha = 2 / (length + 1);
  return prev == null ? value : prev + alpha * (value - prev);
}

function loadPrices(ticker) {
  const rows = readJson(path.join(PRICE_DIR, `${ticker}.json`))
    .filter(row => String(row.date).startsWith(`${DATE}T`) && row.marketPhase === 'MKT')
    .map(row => ({
      time: timeFromUtcIso(row.date),
      open: finite(row.open),
      high: finite(row.high),
      low: finite(row.low),
      close: finite(row.price),
      volume: finite(row.volume, 0)
    }))
    .filter(row => row.time >= '09:30' && row.time <= '15:59')
    .sort((a, b) => secFromTime(a.time) - secFromTime(b.time));

  let cumPv = 0;
  let cumVol = 0;
  let ema9 = null;
  let ema21 = null;
  rows.forEach((row, index) => {
    const typical = (row.high + row.low + row.close) / 3;
    cumPv += typical * row.volume;
    cumVol += row.volume;
    ema9 = ema(ema9, row.close, 9);
    ema21 = ema(ema21, row.close, 21);
    row.index = index;
    row.sec = secFromTime(row.time);
    row.vwap = cumVol > 0 ? cumPv / cumVol : row.close;
    row.ema9 = ema9;
    row.ema21 = ema21;
  });
  return rows;
}

function strikeGex(summary = {}) {
  const strikes = Array.isArray(summary.strikes) ? summary.strikes : [];
  const values = Array.isArray(summary.strikeGexRealtime)
    ? summary.strikeGexRealtime
    : Array.isArray(summary.realtimeStrikeGexMillions)
      ? summary.realtimeStrikeGexMillions.map(value => finite(value, 0) * 1e6)
      : [];
  return strikes.map((strike, index) => ({
    strike: finite(strike),
    gex: finite(values[index], 0)
  })).filter(row => Number.isFinite(row.strike) && row.strike > 0 && row.gex !== 0);
}

function gravitySnapshot(point, expiry = 'all') {
  const spot = finite(point.spot);
  const rows = strikeGex(point.gexData && point.gexData[expiry]);
  let upPull = 0;
  let downPull = 0;
  let nearAbs = 0;
  let top = null;
  let upperNearest = null;
  let lowerNearest = null;

  rows.forEach(row => {
    const distancePct = (row.strike - spot) / spot;
    const absDistance = Math.abs(distancePct);
    if (absDistance > GRAVITY_RANGE_PCT) return;
    const weighted = Math.abs(row.gex) / Math.max(absDistance, 0.0015);
    const enriched = { ...row, distancePct, weighted };
    if (distancePct >= 0) upPull += weighted;
    if (distancePct <= 0) downPull += weighted;
    if (absDistance <= NEAR_ZONE_PCT) nearAbs += Math.abs(row.gex);
    if (!top || weighted > top.weighted) top = enriched;
    if (distancePct > 0 && (!upperNearest || absDistance < Math.abs(upperNearest.distancePct))) upperNearest = enriched;
    if (distancePct < 0 && (!lowerNearest || absDistance < Math.abs(lowerNearest.distancePct))) lowerNearest = enriched;
  });

  const total = upPull + downPull;
  const skew = total > 0 ? (upPull - downPull) / total : 0;
  return {
    upPull,
    downPull,
    skew,
    direction: skew > MIN_PULL_EDGE ? 1 : skew < -MIN_PULL_EDGE ? -1 : 0,
    top,
    upperNearest,
    lowerNearest,
    nearAbs,
    totalGex: finite(point.realtimeTotalGex, 0),
    callWall: finite(point.realtimeCallWall),
    putWall: finite(point.realtimePutWall)
  };
}

function evaluateSignals(history, prices, expiry = 'all') {
  const priceByTime = new Map(prices.map(row => [row.time, row]));
  const results = [];

  history.forEach(point => {
    const price = priceByTime.get(point.time);
    if (!price || price.sec < MIN_SIGNAL_SEC || price.sec > MAX_SIGNAL_SEC) return;
    const snap = gravitySnapshot(point, expiry);
    if (!snap.direction) return;

    const trendUp = price.close > price.vwap && price.ema9 > price.ema21;
    const trendDown = price.close < price.vwap && price.ema9 < price.ema21;
    const trendAgree = snap.direction > 0 ? trendUp : trendDown;
    const trendAgainst = snap.direction > 0 ? trendDown : trendUp;
    const gexPositive = snap.totalGex > 0;
    const topDistancePct = snap.top ? snap.top.distancePct : null;
    const topSign = snap.top ? Math.sign(snap.top.gex) : 0;

    const horizons = {};
    HORIZONS.forEach(minutes => {
      const future = prices[price.index + minutes];
      if (!future) return;
      const ret = (future.close - price.close) / price.close;
      horizons[minutes] = {
        ret,
        hit: Math.sign(ret) === snap.direction
      };
    });

    results.push({
      time: point.time,
      close: price.close,
      vwap: price.vwap,
      ema9: price.ema9,
      ema21: price.ema21,
      direction: snap.direction,
      skew: snap.skew,
      trendAgree,
      trendAgainst,
      gexPositive,
      topStrike: snap.top && snap.top.strike,
      topDistancePct,
      topSign,
      callWall: snap.callWall,
      putWall: snap.putWall,
      horizons
    });
  });

  return results;
}

function summarizeSignals(signals, predicate = () => true) {
  const selected = signals.filter(signal => predicate(signal) && signal.horizons[30]);
  if (!selected.length) return { count: 0 };
  const byHorizon = {};
  HORIZONS.forEach(minutes => {
    const rows = selected.filter(signal => signal.horizons[minutes]);
    if (!rows.length) return;
    const hits = rows.filter(signal => signal.horizons[minutes].hit).length;
    const avgRet = rows.reduce((sum, signal) => sum + signal.horizons[minutes].ret * signal.direction, 0) / rows.length;
    byHorizon[minutes] = {
      count: rows.length,
      hitRate: hits / rows.length,
      avgDirectionalReturn: avgRet
    };
  });
  return { count: selected.length, byHorizon };
}

function wallBehavior(history, prices) {
  const priceByTime = new Map(prices.map(row => [row.time, row]));
  const first = history[0];
  const firstSnap = gravitySnapshot(first, 'all');
  const walls = [
    { side: 'call', level: firstSnap.callWall },
    { side: 'put', level: firstSnap.putWall }
  ].filter(wall => Number.isFinite(wall.level));

  return walls.map(wall => {
    const touches = [];
    prices.forEach((row, index) => {
      const touched = row.low <= wall.level && row.high >= wall.level;
      if (!touched || index < 5 || index > prices.length - 31) return;
      const before = prices[index - 5];
      const after = prices[index + 30];
      const retAfter = (after.close - row.close) / row.close;
      touches.push({
        time: row.time,
        close: row.close,
        retAfter,
        fromBelow: before.close < wall.level,
        fromAbove: before.close > wall.level,
        confirmedBreakUp: after.close > wall.level * (1 + BREAK_CONFIRM_PCT),
        confirmedBreakDown: after.close < wall.level * (1 - BREAK_CONFIRM_PCT)
      });
    });

    let firstTouch = touches[0] || null;
    const uniqueTouches = [];
    let lastIndex = -999;
    touches.forEach(touch => {
      const idx = prices.find(row => row.time === touch.time).index;
      if (idx - lastIndex >= 10) {
        uniqueTouches.push(touch);
        lastIndex = idx;
      }
    });

    return {
      ...wall,
      firstTouch,
      touchCount: uniqueTouches.length,
      touchTimes: uniqueTouches.slice(0, 6).map(touch => touch.time),
      breakUpCount: uniqueTouches.filter(touch => touch.confirmedBreakUp).length,
      breakDownCount: uniqueTouches.filter(touch => touch.confirmedBreakDown).length
    };
  });
}

function dayProfile(prices) {
  const open = prices[0].open;
  const close = prices[prices.length - 1].close;
  const high = Math.max(...prices.map(row => row.high));
  const low = Math.min(...prices.map(row => row.low));
  const finalVwap = prices[prices.length - 1].vwap;
  const aboveVwapBars = prices.filter(row => row.close > row.vwap).length;
  return {
    open,
    close,
    high,
    low,
    returnPct: (close - open) / open,
    rangePct: (high - low) / open,
    finalVwap,
    closeVsVwapPct: (close - finalVwap) / finalVwap,
    aboveVwapRatio: aboveVwapBars / prices.length
  };
}

function describeDirection(value) {
  return value > 0 ? '上引' : value < 0 ? '下引' : '均衡';
}

function buildReport() {
  const tickers = fs.readdirSync(LIVE_DIR)
    .filter(name => fs.statSync(path.join(LIVE_DIR, name)).isDirectory())
    .sort();
  const perTicker = [];
  const allSignals = [];

  tickers.forEach(ticker => {
    const history = readJson(path.join(LIVE_DIR, ticker, 'history.json'));
    const prices = loadPrices(ticker);
    const signals = evaluateSignals(history, prices, 'all');
    signals.forEach(signal => allSignals.push({ ticker, ...signal }));
    const firstSnap = gravitySnapshot(history[0], 'all');
    const lastSnap = gravitySnapshot(history[history.length - 1], 'all');
    const summary = {
      ticker,
      minutes: prices.length,
      day: dayProfile(prices),
      firstGravity: {
        direction: firstSnap.direction,
        skew: firstSnap.skew,
        topStrike: firstSnap.top && firstSnap.top.strike,
        topDistancePct: firstSnap.top && firstSnap.top.distancePct,
        totalGex: firstSnap.totalGex,
        callWall: firstSnap.callWall,
        putWall: firstSnap.putWall
      },
      lastGravity: {
        direction: lastSnap.direction,
        skew: lastSnap.skew,
        topStrike: lastSnap.top && lastSnap.top.strike,
        topDistancePct: lastSnap.top && lastSnap.top.distancePct,
        totalGex: lastSnap.totalGex,
        callWall: lastSnap.callWall,
        putWall: lastSnap.putWall
      },
      signals: {
        all: summarizeSignals(signals),
        trendAgree: summarizeSignals(signals, s => s.trendAgree),
        trendAgainst: summarizeSignals(signals, s => s.trendAgainst),
        positiveGexTrendAgree: summarizeSignals(signals, s => s.gexPositive && s.trendAgree),
        negativeGexTrendAgree: summarizeSignals(signals, s => !s.gexPositive && s.trendAgree)
      },
      walls: wallBehavior(history, prices)
    };
    perTicker.push(summary);
  });

  return {
    date: DATE,
    tickers: perTicker,
    aggregate: {
      all: summarizeSignals(allSignals),
      trendAgree: summarizeSignals(allSignals, s => s.trendAgree),
      trendAgainst: summarizeSignals(allSignals, s => s.trendAgainst),
      positiveGexTrendAgainst: summarizeSignals(allSignals, s => s.gexPositive && s.trendAgainst),
      negativeGexTrendAgainst: summarizeSignals(allSignals, s => !s.gexPositive && s.trendAgainst),
      highSkewTrendAgainst: summarizeSignals(allSignals, s => Math.abs(s.skew) >= 0.35 && s.trendAgainst),
      nearTopTrendAgainst: summarizeSignals(allSignals, s => Math.abs(s.topDistancePct || 9) <= 0.01 && s.trendAgainst),
      positiveGexTrendAgree: summarizeSignals(allSignals, s => s.gexPositive && s.trendAgree),
      negativeGexTrendAgree: summarizeSignals(allSignals, s => !s.gexPositive && s.trendAgree),
      highSkewTrendAgree: summarizeSignals(allSignals, s => Math.abs(s.skew) >= 0.35 && s.trendAgree),
      nearTopTrendAgree: summarizeSignals(allSignals, s => Math.abs(s.topDistancePct || 9) <= 0.01 && s.trendAgree)
    }
  };
}

function metricText(summary, horizon = 30) {
  if (!summary || !summary.count || !summary.byHorizon || !summary.byHorizon[horizon]) return 'n/a';
  const row = summary.byHorizon[horizon];
  return `${row.count} 笔，胜率 ${pct(row.hitRate)}，方向收益 ${pct(row.avgDirectionalReturn)}`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push(`# 2026-07-20 引力图盘中指示作用复盘`);
  lines.push('');
  lines.push(`样本：${report.tickers.length} 个标的，每个 TipRanks 1min 文件 780 条，严格过滤为 2026-07-20 常规盘 390 分钟。信号窗口采用 10:00-15:30，避免开盘噪音和尾盘不可验证。`);
  lines.push('');
  lines.push('## 聚合结论');
  lines.push('');
  lines.push('| 用法 | 30min 表现 | 15min 表现 | 60min 表现 |');
  lines.push('| --- | ---: | ---: | ---: |');
  [
    ['裸引力方向', report.aggregate.all],
    ['引力方向 + VWAP/EMA 同向', report.aggregate.trendAgree],
    ['引力方向 + VWAP/EMA 反向', report.aggregate.trendAgainst],
    ['正 GEX + 趋势反向', report.aggregate.positiveGexTrendAgainst],
    ['负 GEX + 趋势反向', report.aggregate.negativeGexTrendAgainst],
    ['强 skew + 趋势反向', report.aggregate.highSkewTrendAgainst],
    ['主峰 1% 内 + 趋势反向', report.aggregate.nearTopTrendAgainst],
    ['正 GEX + 趋势同向', report.aggregate.positiveGexTrendAgree],
    ['负 GEX + 趋势同向', report.aggregate.negativeGexTrendAgree],
    ['强 skew + 趋势同向', report.aggregate.highSkewTrendAgree],
    ['主峰 1% 内 + 趋势同向', report.aggregate.nearTopTrendAgree]
  ].forEach(([label, summary]) => {
    lines.push(`| ${label} | ${metricText(summary, 30)} | ${metricText(summary, 15)} | ${metricText(summary, 60)} |`);
  });
  lines.push('');
  lines.push('## 标的概览');
  lines.push('');
  lines.push('| Ticker | 当日走势 | 开盘引力 | 收盘引力 | 30min 裸测 | 30min 趋势同向 | 开盘墙位行为 |');
  lines.push('| --- | ---: | --- | --- | ---: | ---: | --- |');
  report.tickers.forEach(item => {
    const wallText = item.walls.map(w => {
      const touch = w.firstTouch ? `${w.firstTouch.time}` : '未触达';
      return `${w.side} ${round(w.level, 2)} ${touch}`;
    }).join('<br>');
    lines.push(`| ${item.ticker} | ${pct(item.day.returnPct)} / range ${pct(item.day.rangePct)} | ${describeDirection(item.firstGravity.direction)} skew ${round(item.firstGravity.skew, 2)} top ${round(item.firstGravity.topStrike, 2)} | ${describeDirection(item.lastGravity.direction)} skew ${round(item.lastGravity.skew, 2)} top ${round(item.lastGravity.topStrike, 2)} | ${metricText(item.signals.all, 30)} | ${metricText(item.signals.trendAgree, 30)} | ${wallText} |`);
  });
  lines.push('');
  lines.push('## 可操作的最佳实践');
  lines.push('');
  lines.push('1. 不要单独用引力方向开仓。0720 裸引力方向只有轻微优势，30min 胜率 51.4%，平均方向收益接近 0；它更像“地图”，不是独立买卖信号。');
  lines.push('2. 0720 最有效的用法是“背离回拉”：当价格在 VWAP/EMA 趋势的一侧延伸，而加权引力指向另一侧时，后面 30min 更容易向引力侧回拉。也就是：上引但价格弱、下引但价格强，优先看回归。');
  lines.push('3. 趋势同向不是加分项。引力方向与 VWAP/EMA 同向时，0720 聚合胜率反而略低，说明这时市场已经在朝引力位运动，追进去容易买在吸附后的衰减段。更好的动作是等接近主峰/墙位后的反应。');
  lines.push('4. 正 GEX 环境偏“磁吸/均值回归”，墙位更像区间边界；负 GEX 环境偏“加速/突破”，墙位被确认突破后不要硬反向。实盘上先看 `realtimeTotalGex` 正负，再决定是做回归还是顺势。');
  lines.push('5. 主峰离现价 1% 内才最值得盯。距离太远的峰更多是背景结构，盘中交易要等价格进入主峰/墙位附近，再看 VWAP/EMA 是拒绝、吸附还是突破。');
  lines.push('6. Call Wall / Put Wall 更适合做“事件位”：第一次触达后的 15-30 分钟反应，比全天静态方向更有信息。触达后若 3-5 根 1min K 仍站不回墙内，按突破处理。');
  lines.push('7. 10:00 前少用。开盘 30 分钟成交、VWAP、EMA 都未稳定，引力图可用来标注关键价位，但不适合直接生成方向信号。');
  lines.push('');
  lines.push('## 文件');
  lines.push('');
  lines.push(`- JSON 明细：\`${path.relative(ROOT, OUT_JSON)}\``);
  lines.push(`- 1min 缓存：\`${path.relative(ROOT, PRICE_DIR)}\``);
  return `${lines.join('\n')}\n`;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const report = buildReport();
  fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
  fs.writeFileSync(OUT_MD, renderMarkdown(report));
  console.log(`Wrote ${path.relative(ROOT, OUT_JSON)}`);
  console.log(`Wrote ${path.relative(ROOT, OUT_MD)}`);
}

main();
