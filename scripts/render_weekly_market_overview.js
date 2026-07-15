#!/usr/bin/env node
/**
 * Render a weekly market overview from report.json.
 *
 * The output is SVG and does not require third-party packages.
 */

const fs = require('fs');
const path = require('path');

const WIDTH = 1200;
const HEIGHT = 740;
const CARD_X = 16;
const CARD_Y = 28;
const CARD_W = WIDTH - CARD_X * 2;
const CARD_H = HEIGHT - CARD_Y * 2;
const CONTENT_LEFT = 42;
const CONTENT_RIGHT = WIDTH - 42;
const BLUE = '#2563eb';
const RED = '#dc2626';
const TEXT = '#0f172a';
const MUTED = '#64748b';
const BORDER = '#e2e8f0';
const SCORE_COLORS = [
  '#16a34a',
  '#20b653',
  '#2fc45f',
  '#57cf64',
  '#8ccf5b',
  '#c9c84a',
  '#f0b63f',
  '#f28b32',
  '#ef5a3c',
  '#dc2626',
];
const SCORE_INACTIVE_COLOR = '#e5e7eb';
const LOGO_PATH = path.join(__dirname, 'Logo.svg');
const LOGO_WIDTH = 84;
const LOGO_HEIGHT = 41;
const LOGO_OPACITY = 0.32;
let logoInnerSvg = null;

const GROUPS = [
  { key: 'indexEtfs', title: 'Index ETF' },
  { key: 'megaCap', title: 'Mega Cap' },
  { key: 'semis', title: 'Semis' },
  { key: 'riskHedges', title: 'Risk / Hedge' },
];

function fmt(value, digits = 2) {
  if (value === null || value === undefined) return 'N/A';
  const num = Number(value);
  if (!Number.isFinite(num)) return 'N/A';
  if (digits === 0) return num.toFixed(0);
  return num.toFixed(digits).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function svgText(x, y, text, size = 16, weight = 400, fill = TEXT, anchor = 'start') {
  return `<text x="${x}" y="${y}" font-family="Inter, Arial, sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${escapeHtml(text)}</text>`;
}

function groupTitleText(x, y, title, label, color) {
  return [
    `<text x="${x}" y="${y}" font-family="Inter, Arial, sans-serif" font-size="18" font-weight="800" text-anchor="start">`,
    `<tspan fill="${TEXT}">${escapeHtml(title)}</tspan>`,
    `<tspan fill="#94a3b8"> · </tspan>`,
    `<tspan fill="${color}">${escapeHtml(label)}</tspan>`,
    '</text>',
  ].join('');
}

function biasLabel(value) {
  const text = String(value || '');
  if (text.includes('偏弱')) return 'Weak Choppy';
  if (text.includes('偏强')) return 'Strong Choppy';
  if (text.includes('中性')) return 'Mixed / Neutral';
  return text || 'N/A';
}

function marketLabel(value) {
  const text = String(value || '');
  if (text.includes('偏弱')) return 'Weak Choppy';
  if (text.includes('偏强')) return 'Strong Choppy';
  if (text.includes('中性')) return 'Mixed / Neutral';
  return text || 'N/A';
}

function scoreLevel(score, maxAbs = 1) {
  let value = Number(score);
  if (!Number.isFinite(value)) value = 0;
  value = clamp(value / maxAbs, -1, 1);
  return clamp(Math.ceil(((value + 1) / 2) * 10), 1, 10);
}

function marketScoreLevel(score) {
  return scoreLevel(score, 50);
}

function tickerScoreLevel(score) {
  return scoreLevel(score, 1);
}

function pullStructureLabelFromPull(pull) {
  const skew = ((Number(pull.up) || 0) - (Number(pull.down) || 0)) / 100;
  if (skew <= -0.12) return 'Pull: downside-heavy';
  if (skew >= 0.12) return 'Pull: upside-heavy';
  return 'Pull: balanced';
}

function scoreLabelFromLevel(level) {
  if (level <= 2) return 'Very Weak';
  if (level <= 4) return 'Weak';
  if (level <= 6) return 'Balanced';
  if (level <= 8) return 'Strong';
  return 'Very Strong';
}

function scoreColor(score, maxAbs = 1) {
  const num = Number(score);
  if (!Number.isFinite(num)) return '#94a3b8';
  const intensity = clamp(Math.abs(num) / maxAbs, 0, 1);
  if (num < -0.12 * maxAbs) return blend('#fee2e2', '#dc2626', intensity);
  if (num > 0.12 * maxAbs) return blend('#dbeafe', '#2563eb', intensity);
  return '#e5e7eb';
}

function scoreLevelColor(level) {
  return SCORE_COLORS[clamp(Number(level) || 1, 1, 10) - 1];
}

function readableTextColor(fill) {
  const [r, g, b] = hexToRgb(fill);
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  return brightness > 150 ? '#0f172a' : '#ffffff';
}

function textColorForScore(score, maxAbs = 1) {
  const num = Number(score);
  if (!Number.isFinite(num)) return MUTED;
  if (num < -0.12 * maxAbs) return '#991b1b';
  if (num > 0.12 * maxAbs) return '#1d4ed8';
  return '#334155';
}

function blend(from, to, ratio) {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  const r = clamp(ratio, 0, 1);
  return rgbToHex(
    Math.round(a[0] + (b[0] - a[0]) * r),
    Math.round(a[1] + (b[1] - a[1]) * r),
    Math.round(a[2] + (b[2] - a[2]) * r),
  );
}

function hexToRgb(hex) {
  const normalized = hex.replace('#', '');
  return [
    parseInt(normalized.slice(0, 2), 16),
    parseInt(normalized.slice(2, 4), 16),
    parseInt(normalized.slice(4, 6), 16),
  ];
}

function rgbToHex(r, g, b) {
  return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

function average(values) {
  const nums = values.map(Number).filter(Number.isFinite);
  if (!nums.length) return 0;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function groupPull(group) {
  const structures = group && Array.isArray(group.structures) ? group.structures : [];
  return {
    up: average(structures.map(item => item.upperWeightedGravityPct)),
    down: average(structures.map(item => item.lowerWeightedGravityPct)),
  };
}

function polarPoint(cx, cy, radius, angleDeg) {
  const angle = angleDeg * Math.PI / 180;
  return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
}

function ringSegmentPath(cx, cy, outerR, innerR, startAngle, endAngle, cornerRadius = 2.4) {
  const outerInset = cornerRadius / outerR * 180 / Math.PI;
  const innerInset = cornerRadius / innerR * 180 / Math.PI;
  let outerStartAngle = startAngle + outerInset;
  let outerEndAngle = endAngle - outerInset;
  let innerStartAngle = startAngle + innerInset;
  let innerEndAngle = endAngle - innerInset;

  if (outerEndAngle <= outerStartAngle || innerEndAngle <= innerStartAngle) {
    outerStartAngle = startAngle;
    outerEndAngle = endAngle;
    innerStartAngle = startAngle;
    innerEndAngle = endAngle;
  }

  const outerStart = polarPoint(cx, cy, outerR, outerStartAngle);
  const outerEnd = polarPoint(cx, cy, outerR, outerEndAngle);
  const innerEnd = polarPoint(cx, cy, innerR, innerEndAngle);
  const innerStart = polarPoint(cx, cy, innerR, innerStartAngle);
  const endOuterCorner = polarPoint(cx, cy, outerR, endAngle);
  const endInnerCorner = polarPoint(cx, cy, innerR, endAngle);
  const startInnerCorner = polarPoint(cx, cy, innerR, startAngle);
  const startOuterCorner = polarPoint(cx, cy, outerR, startAngle);
  const endRadialOuter = polarPoint(cx, cy, outerR - cornerRadius, endAngle);
  const endRadialInner = polarPoint(cx, cy, innerR + cornerRadius, endAngle);
  const startRadialInner = polarPoint(cx, cy, innerR + cornerRadius, startAngle);
  const startRadialOuter = polarPoint(cx, cy, outerR - cornerRadius, startAngle);
  const largeArc = outerEndAngle - outerStartAngle > 180 ? 1 : 0;

  return [
    `M ${outerStart[0].toFixed(2)} ${outerStart[1].toFixed(2)}`,
    `A ${outerR.toFixed(2)} ${outerR.toFixed(2)} 0 ${largeArc} 1 ${outerEnd[0].toFixed(2)} ${outerEnd[1].toFixed(2)}`,
    `Q ${endOuterCorner[0].toFixed(2)} ${endOuterCorner[1].toFixed(2)} ${endRadialOuter[0].toFixed(2)} ${endRadialOuter[1].toFixed(2)}`,
    `L ${endRadialInner[0].toFixed(2)} ${endRadialInner[1].toFixed(2)}`,
    `Q ${endInnerCorner[0].toFixed(2)} ${endInnerCorner[1].toFixed(2)} ${innerEnd[0].toFixed(2)} ${innerEnd[1].toFixed(2)}`,
    `A ${innerR.toFixed(2)} ${innerR.toFixed(2)} 0 ${largeArc} 0 ${innerStart[0].toFixed(2)} ${innerStart[1].toFixed(2)}`,
    `Q ${startInnerCorner[0].toFixed(2)} ${startInnerCorner[1].toFixed(2)} ${startRadialInner[0].toFixed(2)} ${startRadialInner[1].toFixed(2)}`,
    `L ${startRadialOuter[0].toFixed(2)} ${startRadialOuter[1].toFixed(2)}`,
    `Q ${startOuterCorner[0].toFixed(2)} ${startOuterCorner[1].toFixed(2)} ${outerStart[0].toFixed(2)} ${outerStart[1].toFixed(2)} Z`,
  ].join(' ');
}

function renderScoreRing(score, x, y) {
  const level = marketScoreLevel(score);
  const cx = x + 104;
  const cy = y + 46;
  const outerR = 38;
  const innerR = 27;
  const gap = 1.1;
  const segment = (360 - gap * 10) / 10;
  const start = -90;
  const parts = [];

  for (let idx = 0; idx < 10; idx++) {
    const segmentStart = start + idx * (segment + gap) + gap / 2;
    const segmentEnd = segmentStart + segment;
    const color = idx < level ? SCORE_COLORS[idx] : SCORE_INACTIVE_COLOR;
    parts.push(`<path d="${ringSegmentPath(cx, cy, outerR, innerR, segmentStart, segmentEnd)}" fill="${color}"/>`);
  }

  const activeColor = SCORE_COLORS[level - 1];
  parts.push(
    svgText(cx, cy + 8, String(level), 24, 850, activeColor, 'middle'),
    svgText(x + 38, y + 36, `${level}/10`, 24, 850, '#334155', 'end'),
    svgText(x + 38, y + 66, scoreLabelFromLevel(level), 18, 850, TEXT, 'end'),
  );
  return parts.join('\n');
}

function loadLogoInnerSvg() {
  if (logoInnerSvg !== null) return logoInnerSvg;
  if (!fs.existsSync(LOGO_PATH)) {
    logoInnerSvg = '';
    return logoInnerSvg;
  }
  logoInnerSvg = fs.readFileSync(LOGO_PATH, 'utf8')
    .trim()
    .replace(/^<svg\b[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .trim();
  return logoInnerSvg;
}

function renderLogo(x, y) {
  const logo = loadLogoInnerSvg();
  if (!logo) return '';
  return `<svg x="${x}" y="${y}" width="${LOGO_WIDTH}" height="${LOGO_HEIGHT}" viewBox="0 0 819 401" opacity="${LOGO_OPACITY}">${logo}</svg>`;
}

function renderPullBar(x, y, width, height, up, down) {
  const upPct = clamp(Number(up) || 0, 0, 100);
  const downPct = clamp(Number(down) || 0, 0, 100);
  const total = upPct + downPct || 100;
  const downW = width * downPct / total;
  const upW = width - downW;
  return [
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="7" fill="#e2e8f0"/>`,
    `<rect x="${x}" y="${y}" width="${downW}" height="${height}" rx="7" fill="${RED}" opacity="0.82"/>`,
    `<rect x="${x + downW}" y="${y}" width="${upW}" height="${height}" rx="7" fill="${BLUE}" opacity="0.82"/>`,
    svgText(x + 10, y + 18, `Down ${fmt(downPct)}%`, 12, 750, '#ffffff'),
    svgText(x + width - 10, y + 18, `Up ${fmt(upPct)}%`, 12, 750, '#ffffff', 'end'),
  ].join('\n');
}

function renderGroupCard(groupDef, group, x, y, width, height) {
  const pull = groupPull(group);
  const leaders = (group && group.leaders || []).slice(0, 3);
  const laggards = (group && group.laggards || []).slice(0, 3);
  const structures = group && Array.isArray(group.structures) ? group.structures : [];
  const score = Number(group && group.agreementScore || 0);
  const color = textColorForScore(score, 50);
  const label = biasLabel(group && group.bias);

  const parts = [
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="10" fill="#ffffff" stroke="${BORDER}"/>`,
    groupTitleText(x + 18, y + 28, groupDef.title, label, color),
    svgText(x + width - 18, y + 28, `Score ${score >= 0 ? '+' : ''}${fmt(score, 0)}`, 14, 800, color, 'end'),
    renderPullBar(x + 18, y + 44, width - 36, 28, pull.up, pull.down),
  ];

  const leaderText = leaders.length ? leaders.join(', ') : 'None';
  const laggardText = laggards.length ? laggards.join(', ') : 'None';
  parts.push(
    svgText(x + 18, y + 92, pullStructureLabelFromPull(pull), 12, 750, '#334155'),
    svgText(x + width - 18, y + 92, `Stronger: ${leaderText} · Weaker: ${laggardText}`, 12, 700, '#334155', 'end'),
  );

  const chipY = y + 111;
  structures.slice(0, 6).forEach((item, idx) => {
    const chipW = 68;
    const chipX = x + 18 + idx * (chipW + 8);
    const level = tickerScoreLevel(item.score);
    const fill = scoreLevelColor(level);
    const textFill = TEXT;
    parts.push(
      `<rect x="${chipX}" y="${chipY}" width="${chipW}" height="30" rx="7" fill="${fill}" opacity="0.2"/>`,
      svgText(chipX + chipW / 2, chipY + 18, `${item.ticker} ${level}/10`, 11, 800, textFill, 'middle'),
    );
  });

  return parts.join('\n');
}

function collectHeatmapItems(report) {
  const items = [];
  GROUPS.forEach(groupDef => {
    const group = report.groups && report.groups[groupDef.key];
    (group && group.structures || []).forEach(item => {
      items.push({
        group: groupDef.title,
        ticker: item.ticker,
        score: Number(item.score || 0),
      });
    });
  });
  return items;
}

function uniqueTickersFromGroups(report, groupKeys) {
  const seen = new Set();
  const tickers = [];
  groupKeys.forEach(key => {
    const group = report.groups && report.groups[key];
    (group && group.structures || []).forEach(item => {
      if (!item.ticker || seen.has(item.ticker)) return;
      seen.add(item.ticker);
      tickers.push(item.ticker);
    });
  });
  return tickers;
}

function collectTickerZones(report, ticker) {
  const data = report.tickers && report.tickers[ticker];
  const window = data && data.windows && data.windows.nextWeek;
  if (!window) return [];
  const seen = new Set();
  const zones = [];
  ['strongestWeightedGravityZones', 'nearGravityZones', 'upperGravityZones', 'lowerGravityZones'].forEach(key => {
    (window[key] || []).forEach(zone => {
      const strike = zone && zone.strike;
      if (strike === null || strike === undefined || seen.has(strike)) return;
      seen.add(strike);
      zones.push(zone);
    });
  });
  return zones;
}

function buildMarketGravitySeries(report, tickers) {
  const minPct = -15;
  const maxPct = 15;
  const buckets = [];
  for (let pct = minPct; pct <= maxPct; pct += 1) {
    buckets.push({ pct, value: 0 });
  }

  let usedTickers = 0;
  tickers.forEach(ticker => {
    const zones = collectTickerZones(report, ticker)
      .filter(zone => Number.isFinite(Number(zone.distancePct)) && Number.isFinite(Number(zone.weightedGravity)));
    if (!zones.length) return;

    const maxGravity = Math.max(...zones.map(zone => Math.abs(Number(zone.weightedGravity))), 0);
    if (maxGravity <= 0) return;

    usedTickers += 1;
    zones.forEach(zone => {
      const distance = clamp(Number(zone.distancePct), minPct, maxPct);
      const idx = Math.round(distance - minPct);
      buckets[idx].value += Math.abs(Number(zone.weightedGravity)) / maxGravity;
    });
  });

  if (usedTickers > 0) {
    buckets.forEach(bucket => {
      bucket.value /= usedTickers;
    });
  }

  return smoothBuckets(buckets);
}

function smoothBuckets(buckets) {
  return buckets.map((bucket, idx) => {
    const prev = buckets[idx - 1] || bucket;
    const next = buckets[idx + 1] || bucket;
    return {
      pct: bucket.pct,
      value: (prev.value + bucket.value * 2 + next.value) / 4,
    };
  });
}

function curvePath(points) {
  if (!points.length) return '';
  if (points.length === 1) return `M ${points[0][0].toFixed(2)} ${points[0][1].toFixed(2)}`;
  const parts = [`M ${points[0][0].toFixed(2)} ${points[0][1].toFixed(2)}`];
  for (let idx = 1; idx < points.length; idx++) {
    const [x0, y0] = points[idx - 1];
    const [x1, y1] = points[idx];
    const cx = (x0 + x1) / 2;
    parts.push(`C ${cx.toFixed(2)} ${y0.toFixed(2)}, ${cx.toFixed(2)} ${y1.toFixed(2)}, ${x1.toFixed(2)} ${y1.toFixed(2)}`);
  }
  return parts.join(' ');
}

function renderCurveLine(series, plot, maxValue, color, width = 2.5) {
  const points = series.map(point => {
    const x = plot.x + (point.pct + 15) / 30 * plot.width;
    const ratio = maxValue > 0 ? point.value / maxValue : 0;
    const y = plot.y + plot.height - ratio * plot.height;
    return [x, y];
  });
  return `<path d="${curvePath(points)}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function renderMarketGravityCurve(report, x, y, width, height) {
  const coreTickers = uniqueTickersFromGroups(report, ['indexEtfs', 'megaCap', 'semis']);
  const riskTickers = uniqueTickersFromGroups(report, ['riskHedges']);
  const coreSeries = buildMarketGravitySeries(report, coreTickers);
  const riskSeries = buildMarketGravitySeries(report, riskTickers);
  const maxValue = Math.max(
    ...coreSeries.map(point => point.value),
    ...riskSeries.map(point => point.value),
    0.01,
  );
  const plot = { x: x + 18, y: y + 42, width: width - 36, height: 78 };
  const spotX = plot.x + plot.width / 2;
  const tickY = plot.y + plot.height + 18;
  const ticks = [-15, -10, -5, 0, 5, 10, 15];

  const parts = [
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="10" fill="#ffffff" stroke="${BORDER}"/>`,
    svgText(x + 18, y + 28, 'Market Gravity Curve', 18, 800),
    svgText(x + width - 18, y + 28, 'Normalized by ticker · Equal weighted', 12, 500, MUTED, 'end'),
    `<rect x="${plot.x}" y="${plot.y}" width="${plot.width / 2}" height="${plot.height}" rx="7" fill="${RED}" opacity="0.045"/>`,
    `<rect x="${spotX}" y="${plot.y}" width="${plot.width / 2}" height="${plot.height}" rx="7" fill="${BLUE}" opacity="0.045"/>`,
    `<line x1="${plot.x}" y1="${plot.y + plot.height}" x2="${plot.x + plot.width}" y2="${plot.y + plot.height}" stroke="#cbd5e1" stroke-width="1"/>`,
    `<line x1="${spotX}" y1="${plot.y - 6}" x2="${spotX}" y2="${plot.y + plot.height + 14}" stroke="#ea580c" stroke-width="1.8" stroke-dasharray="4 4"/>`,
    renderCurveLine(coreSeries, plot, maxValue, BLUE, 3),
    renderCurveLine(riskSeries, plot, maxValue, '#f97316', 2.4),
    ...ticks.map(tick => {
      const tx = plot.x + (tick + 15) / 30 * plot.width;
      const color = tick === 0 ? '#ea580c' : MUTED;
      const label = tick > 0 ? `+${tick}%` : `${tick}%`;
      return [
        `<line x1="${tx}" y1="${plot.y + plot.height}" x2="${tx}" y2="${plot.y + plot.height + 5}" stroke="${tick === 0 ? '#ea580c' : '#cbd5e1'}" stroke-width="1"/>`,
        svgText(tx, tickY, label, 10, tick === 0 ? 750 : 600, color, 'middle'),
      ].join('\n');
    }),
    `<circle cx="${x + 20}" cy="${y + height - 18}" r="4" fill="${BLUE}"/>`,
    svgText(x + 30, y + height - 14, 'Core market', 12, 700, TEXT),
    `<circle cx="${x + 138}" cy="${y + height - 18}" r="4" fill="#f97316"/>`,
    svgText(x + 148, y + height - 14, 'Risk / Hedge', 12, 700, TEXT),
  ];

  return parts.join('\n');
}

function renderRiskDashboard(report, x, y, width, height) {
  const marketView = report.marketView || {};
  const indexGroup = report.groups && report.groups.indexEtfs;
  const megaGroup = report.groups && report.groups.megaCap;
  const semisGroup = report.groups && report.groups.semis;
  const riskGroup = report.groups && report.groups.riskHedges;
  const rows = [
    { dot: RED, label: 'Market', value: marketLabel(marketView.state) },
    { dot: RED, label: 'Index Pressure', value: (indexGroup && indexGroup.laggards || []).join(', ') || 'None' },
    { dot: '#94a3b8', label: 'Mega Cap', value: biasLabel(megaGroup && megaGroup.bias) },
    { dot: '#94a3b8', label: 'Semis', value: `${biasLabel(semisGroup && semisGroup.bias)} / SMH weak` },
    { dot: BLUE, label: 'Hedge / Vol', value: (riskGroup && riskGroup.leaders || []).join(', ') || biasLabel(riskGroup && riskGroup.bias) },
  ];

  const parts = [
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="10" fill="#ffffff" stroke="${BORDER}"/>`,
    svgText(x + 18, y + 28, 'Risk Dashboard', 18, 800),
    svgText(x + width - 18, y + 28, 'Weekly read', 12, 600, MUTED, 'end'),
  ];

  rows.forEach((row, idx) => {
    const rowX = x + 18;
    const rowY = y + 42 + idx * 22;
    const fill = idx % 2 === 0 ? '#f8fafc' : '#ffffff';
    parts.push(
      `<rect x="${rowX}" y="${rowY}" width="${width - 36}" height="21" rx="6" fill="${fill}"/>`,
      `<circle cx="${rowX + 10}" cy="${rowY + 10.5}" r="4" fill="${row.dot}" opacity="0.86"/>`,
      svgText(rowX + 22, rowY + 14, row.label, 12, 850, TEXT),
      svgText(rowX + width - 36, rowY + 14, row.value, 12, 700, MUTED, 'end'),
    );
  });

  return parts.join('\n');
}

function renderOverview(report) {
  const marketView = report.marketView || {};
  const score = Number(marketView.compositeScore || 0);
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
    '<rect width="100%" height="100%" fill="#f8fafc"/>',
    `<rect x="${CARD_X}" y="${CARD_Y}" width="${CARD_W}" height="${CARD_H}" rx="16" fill="#ffffff" stroke="${BORDER}"/>`,
    svgText(CONTENT_LEFT, 74, 'KairAlert Gravity Weekly Market Overview', 30, 850),
    svgText(CONTENT_LEFT, 101, `Base date ${report.baseDate} · Market Structure: ${marketLabel(marketView.state)}`, 15, 550, '#475569'),
    renderScoreRing(score, CONTENT_RIGHT - 155, 42),
  ];

  const cardW = 544;
  const cardH = 154;
  parts.push(
    renderGroupCard(GROUPS[0], report.groups && report.groups[GROUPS[0].key], 42, 138, cardW, cardH),
    renderGroupCard(GROUPS[1], report.groups && report.groups[GROUPS[1].key], 614, 138, cardW, cardH),
    renderGroupCard(GROUPS[2], report.groups && report.groups[GROUPS[2].key], 42, 308, cardW, cardH),
    renderGroupCard(GROUPS[3], report.groups && report.groups[GROUPS[3].key], 614, 308, cardW, cardH),
    renderMarketGravityCurve(report, 42, 486, 732, 178),
    renderRiskDashboard(report, 794, 486, 364, 178),
    svgText(CONTENT_LEFT, 690, 'Disclaimer: For informational purposes only. Not investment advice.', 12, 650, '#ea580c'),
    renderLogo(CONTENT_RIGHT - LOGO_WIDTH, 666),
    '</svg>',
  );

  return parts.join('\n');
}

function main() {
  if (process.argv.length !== 4) {
    console.error('Usage: render_weekly_market_overview.js <report.json> <output_dir>');
    return 2;
  }

  const reportPath = process.argv[2];
  const outputDir = process.argv[3];
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const chartsDir = path.join(outputDir, 'charts');
  fs.mkdirSync(chartsDir, { recursive: true });
  const svg = renderOverview(report);
  const outputPath = path.join(chartsDir, 'MARKET_OVERVIEW.svg');
  fs.writeFileSync(outputPath, svg, 'utf8');
  console.log(`Rendered market overview to ${outputPath}`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  renderOverview,
};
