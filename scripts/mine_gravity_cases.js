#!/usr/bin/env node

/**
 * Scan data/live_data for teaching-oriented Gravity Map cases.
 *
 * This is intentionally a structure miner, not a return backtest. It only uses
 * information present in each minute's history snapshot and reports patterns
 * that are useful when explaining how to read the map:
 *
 *   - a persistent single core;
 *   - a core that migrates during the session;
 *   - a multi-peak / tug-of-war structure;
 *   - a clear structure that later degrades.
 *
 * Usage:
 *   node scripts/mine_gravity_cases.js
 *   node scripts/mine_gravity_cases.js --json /tmp/gravity-cases.json
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIVE_ROOT = path.join(ROOT, 'data', 'live_data');
const STRUCTURE_RANGE_PCT = 0.03;
const STRONG_PEAK_RATIO = 0.6;
const SIGNIFICANT_PEAK_RATIO = 0.2;

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function pickHorizon(history) {
  for (const expiry of ['0dte', 'weekly', 'all']) {
    if (history.some(point => point.gexData?.[expiry]?.strikes?.length)) {
      return expiry;
    }
  }
  return null;
}

function realtimeValues(summary = {}) {
  if (Array.isArray(summary.strikeGexRealtime) && summary.strikeGexRealtime.length) {
    return summary.strikeGexRealtime;
  }
  if (Array.isArray(summary.realtimeStrikeGexMillions)) {
    return summary.realtimeStrikeGexMillions.map(value => finite(value, 0) * 1e6);
  }
  return [];
}

function analyzeSnapshot(point, expiry) {
  const summary = point.gexData?.[expiry];
  const spot = finite(point.spot);
  if (!summary || !spot) return null;

  const values = realtimeValues(summary);
  const rows = (summary.strikes || [])
    .map((strike, index) => {
      const strikeValue = finite(strike);
      const gex = finite(values[index]);
      if (!strikeValue || gex === null || gex === 0) return null;
      const distanceRatio = (strikeValue - spot) / spot;
      if (Math.abs(distanceRatio) > STRUCTURE_RANGE_PCT) return null;
      return {
        strike: strikeValue,
        gex,
        absGex: Math.abs(gex),
        distancePct: distanceRatio * 100
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.strike - b.strike);

  if (rows.length < 2) return null;
  const byStrength = [...rows].sort((a, b) => b.absGex - a.absGex);
  const top = byStrength[0];
  const second = byStrength[1];
  const dominance = top.absGex / second.absGex;
  const strongPeakCount = rows.filter(row => row.absGex >= top.absGex * STRONG_PEAK_RATIO).length;

  let signFlipCount = 0;
  let priorSign = 0;
  rows.forEach(row => {
    if (row.absGex < top.absGex * SIGNIFICANT_PEAK_RATIO) return;
    const sign = Math.sign(row.gex);
    if (priorSign && sign && priorSign !== sign) signFlipCount += 1;
    if (sign) priorSign = sign;
  });

  const isClear = dominance >= 1.35 && strongPeakCount <= 3 && signFlipCount <= 1;
  return {
    time: point.time,
    sec: finite(point.sec),
    spot,
    topStrike: top.strike,
    topDistancePct: top.distancePct,
    dominance,
    strongPeakCount,
    signFlipCount,
    isClear
  };
}

function mode(values) {
  const counts = new Map();
  values.forEach(value => counts.set(value, (counts.get(value) || 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || [null, 0];
}

function countEpisodes(snapshots, strike, tolerancePct) {
  let episodes = 0;
  let near = false;
  let firstTouch = null;
  snapshots.forEach(snapshot => {
    const isNear = Math.abs(snapshot.spot - strike) / snapshot.spot <= tolerancePct;
    if (isNear && !near) {
      episodes += 1;
      firstTouch ||= snapshot.time;
    }
    near = isNear;
  });
  return { episodes, firstTouch };
}

function persistentBlocks(snapshots, minimumMinutes = 15) {
  const blocks = [];
  let start = 0;
  for (let index = 1; index <= snapshots.length; index += 1) {
    if (index < snapshots.length &&
        snapshots[index].topStrike === snapshots[start].topStrike) {
      continue;
    }
    const length = index - start;
    if (length >= minimumMinutes) {
      blocks.push({
        strike: snapshots[start].topStrike,
        from: snapshots[start].time,
        to: snapshots[index - 1].time,
        minutes: length
      });
    }
    start = index;
  }
  return blocks;
}

function quarterMode(snapshots, startMinute, endMinute) {
  const selected = snapshots.slice(startMinute, endMinute);
  const [strike, count] = mode(selected.map(snapshot => snapshot.topStrike));
  return {
    strike,
    share: selected.length ? count / selected.length : 0
  };
}

function analyzeSession(date, ticker, history) {
  const expiry = pickHorizon(history);
  if (!expiry || history.length < 300) return null;

  const snapshots = history
    .map(point => analyzeSnapshot(point, expiry))
    .filter(Boolean);
  if (snapshots.length < 300) return null;

  const [coreStrike, coreCount] = mode(snapshots.map(snapshot => snapshot.topStrike));
  const coreShare = coreCount / snapshots.length;
  const topFlips = snapshots.reduce((count, snapshot, index) => (
    index > 0 && snapshot.topStrike !== snapshots[index - 1].topStrike
      ? count + 1
      : count
  ), 0);
  const clearRatio = snapshots.filter(snapshot => snapshot.isClear).length / snapshots.length;
  const averageDominance = snapshots.reduce((sum, snapshot) => sum + snapshot.dominance, 0) / snapshots.length;
  const spacing = median([...new Set(
    history[0].gexData?.[expiry]?.strikes?.map(Number).filter(Number.isFinite) || []
  )].sort((a, b) => a - b).slice(1).map((strike, index, strikes) => (
    index === 0
      ? strike - finite(history[0].gexData?.[expiry]?.strikes?.[0], strike)
      : strike - strikes[index - 1]
  )).filter(value => value > 0));
  const tolerancePct = Math.max(0.0015, spacing && coreStrike ? (spacing * 0.25) / coreStrike : 0);
  const touch = countEpisodes(snapshots, coreStrike, tolerancePct);
  const blocks = persistentBlocks(snapshots);
  const quarters = [
    quarterMode(snapshots, 0, 90),
    quarterMode(snapshots, 90, 195),
    quarterMode(snapshots, 195, 300),
    quarterMode(snapshots, 300, snapshots.length)
  ];

  const early = snapshots.slice(0, 120);
  const late = snapshots.slice(-120);
  const earlyClearRatio = early.filter(snapshot => snapshot.isClear).length / early.length;
  const lateClearRatio = late.filter(snapshot => snapshot.isClear).length / late.length;
  const direction = Math.sign(snapshots.at(-1).spot - snapshots[0].spot);
  const quarterDirection = Math.sign((quarters.at(-1).strike || 0) - (quarters[0].strike || 0));

  const labels = [];
  if (coreShare >= 0.7 && touch.episodes >= 1) labels.push('SINGLE_CORE');
  if (blocks.length >= 2 &&
      new Set(blocks.map(block => block.strike)).size >= 2 &&
      direction !== 0 &&
      quarterDirection === direction) {
    labels.push('MIGRATING_CORE');
  }
  if (coreShare < 0.5 && topFlips >= 40 && averageDominance < 1.5) {
    labels.push('RANGE_TUG');
  }
  if (earlyClearRatio >= 0.6 && lateClearRatio <= 0.35) {
    labels.push('CLEAR_TO_WEAK');
  }

  const spots = snapshots.map(snapshot => snapshot.spot);
  const high = Math.max(...spots);
  const low = Math.min(...spots);
  const highSnapshot = snapshots[spots.indexOf(high)];
  const lowSnapshot = snapshots[spots.indexOf(low)];
  return {
    date,
    ticker,
    expiry,
    labels,
    price: {
      open: round(snapshots[0].spot),
      high: round(high),
      highTime: highSnapshot.time,
      low: round(low),
      lowTime: lowSnapshot.time,
      close: round(snapshots.at(-1).spot),
      returnPct: round((snapshots.at(-1).spot / snapshots[0].spot - 1) * 100)
    },
    core: {
      strike: coreStrike,
      sharePct: round(coreShare * 100, 1),
      touchEpisodes: touch.episodes,
      firstTouch: touch.firstTouch
    },
    structure: {
      clearPct: round(clearRatio * 100, 1),
      earlyClearPct: round(earlyClearRatio * 100, 1),
      lateClearPct: round(lateClearRatio * 100, 1),
      averageDominance: round(averageDominance, 2),
      topFlips
    },
    quarters: quarters.map(quarter => ({
      strike: quarter.strike,
      sharePct: round(quarter.share * 100, 1)
    })),
    persistentBlocks: blocks
  };
}

function readSessions() {
  const sessions = [];
  if (!fs.existsSync(LIVE_ROOT)) return sessions;
  const dates = fs.readdirSync(LIVE_ROOT).sort();
  dates.forEach(date => {
    const dateDir = path.join(LIVE_ROOT, date);
    if (!fs.statSync(dateDir).isDirectory()) return;
    fs.readdirSync(dateDir).sort().forEach(ticker => {
      const historyPath = path.join(dateDir, ticker, 'history.json');
      if (!fs.existsSync(historyPath)) return;
      const history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
      const result = analyzeSession(date, ticker, history);
      if (result) sessions.push(result);
    });
  });
  return sessions;
}

function markdownReport(sessions) {
  const candidates = sessions.filter(session => session.labels.length);
  const lines = [
    '# Gravity Map 教学案例候选',
    '',
    '> 自动扫描只负责发现结构；写作前仍需逐分钟验证角色变化和失效条件。',
    '',
    '| 日期 | 标的 | 周期 | 候选类型 | 核心/占比 | 开高低收 | 结构摘要 |',
    '| --- | --- | --- | --- | --- | --- | --- |'
  ];
  candidates.forEach(session => {
    const { price, core, structure } = session;
    lines.push(
      `| ${session.date} | ${session.ticker} | ${session.expiry} | ${session.labels.join(', ')} | ` +
      `${core.strike} / ${core.sharePct}% | ` +
      `${price.open} / ${price.high} / ${price.low} / ${price.close} | ` +
      `清晰 ${structure.clearPct}%，切换 ${structure.topFlips} 次 |`
    );
  });
  lines.push('', '## 全部完整交易日', '');
  sessions.forEach(session => {
    lines.push(
      `- ${session.date} ${session.ticker}: ` +
      `${session.labels.join(', ') || '未命中自动标签'}；` +
      `季度核心 ${session.quarters.map(item => `${item.strike}(${item.sharePct}%)`).join(' → ')}`
    );
  });
  return `${lines.join('\n')}\n`;
}

function main() {
  const sessions = readSessions();
  const jsonIndex = process.argv.indexOf('--json');
  if (jsonIndex >= 0) {
    const output = process.argv[jsonIndex + 1];
    if (!output) throw new Error('--json requires an output path');
    fs.writeFileSync(output, `${JSON.stringify(sessions, null, 2)}\n`);
  }
  process.stdout.write(markdownReport(sessions));
}

main();
