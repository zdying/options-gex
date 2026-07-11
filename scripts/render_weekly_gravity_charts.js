#!/usr/bin/env node
/**
 * Render weekly gravity summary charts from report.json.
 *
 * This intentionally mirrors scripts/render_weekly_gravity_charts.py.
 * The output is SVG and does not require third-party packages.
 */

const fs = require('fs');
const path = require('path');

const WIDTH = 960;
const HEIGHT = 540;
const CONTENT_LEFT = 48;
const CONTENT_RIGHT = 912;
const PLOT_LEFT = CONTENT_LEFT;
const PLOT_RIGHT = CONTENT_RIGHT;
const PLOT_TOP = 228;
const PLOT_BOTTOM = 360;
const ZERO_Y = 322;
const BAR_LEFT = CONTENT_LEFT;
const BAR_TOP = 122;
const BAR_WIDTH = CONTENT_RIGHT - CONTENT_LEFT;
const BAR_HEIGHT = 34;
const ZONE_LIMIT = 10;
const LABEL_LIMIT = 6;
const SPOT_COLOR = '#ea580c';
const UP_MARK_COLOR = '#3b82f6';
const DOWN_MARK_COLOR = '#ef4444';
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

function fmt(value, digits = 2) {
  if (value === null || value === undefined) return 'N/A';
  const num = Number(value);
  if (!Number.isFinite(num)) return 'N/A';
  return num.toFixed(digits).replace(/\.?0+$/, '');
}

function slug(value) {
  return String(value || '').trim().replace(/[^A-Za-z0-9._-]+/g, '_') || 'ticker';
}

function formatStructureLabel(value) {
  return String(value || '')
    .trim()
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function formatGravityValue(value) {
  const num = Math.abs(Number(value));
  if (!Number.isFinite(num)) return 'N/A';
  return fmt(num / 1_000_000, 1);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function weightedColor(distancePct) {
  if (distancePct === null || distancePct === undefined) return '#64748b';
  return Number(distancePct) >= 0 ? UP_MARK_COLOR : DOWN_MARK_COLOR;
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function scoreLevel(score) {
  let value = Number(score);
  if (!Number.isFinite(value)) value = 0;
  return clamp(Math.ceil(((value + 1) / 2) * 10), 1, 10);
}

function scoreLabel(score) {
  const value = Number(score);
  if (value <= -0.35) return 'Very Weak';
  if (value <= -0.12) return 'Weak';
  if (value < 0.12) return 'Balanced';
  if (value < 0.35) return 'Strong';
  return 'Very Strong';
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

function renderScoreBadge(score) {
  const level = scoreLevel(score);
  const parts = [];
  const cx = 872;
  const cy = 69;
  const outerR = 34;
  const innerR = 24;
  const gap = 1.1;
  const segment = (360 - gap * 10) / 10;
  const start = -90;

  for (let idx = 0; idx < 10; idx++) {
    const segmentStart = start + idx * (segment + gap) + gap / 2;
    const segmentEnd = segmentStart + segment;
    const color = idx < level ? SCORE_COLORS[idx] : SCORE_INACTIVE_COLOR;
    parts.push(`<path d="${ringSegmentPath(cx, cy, outerR, innerR, segmentStart, segmentEnd)}" fill="${color}"/>`);
  }

  const activeColor = SCORE_COLORS[level - 1];
  parts.push(
    svgText(cx, cy + 8, String(level), 22, 850, activeColor, 'middle'),
    svgText(820, 60, `${level}/10`, 22, 850, '#334155', 'end'),
    svgText(820, 88, scoreLabel(score), 20, 850, '#0f172a', 'end'),
  );
  return parts;
}

function collectZones(window) {
  const zones = [];
  const seen = new Set();
  ['strongestWeightedGravityZones', 'nearGravityZones', 'upperGravityZones', 'lowerGravityZones'].forEach(key => {
    (window[key] || []).forEach(zone => {
      const strike = zone.strike;
      if (strike === null || strike === undefined || seen.has(strike)) return;
      seen.add(strike);
      zones.push(zone);
    });
  });
  return zones;
}

function scaleForZones(spot, zones) {
  let strikes = (zones || [])
    .filter(z => z.strike !== null && z.strike !== undefined)
    .map(z => Number(z.strike));

  if (strikes.length === 0) {
    strikes = [spot * 0.95, spot, spot * 1.05];
  }

  strikes.push(spot);
  const low = Math.min(...strikes);
  const high = Math.max(...strikes);
  const pad = Math.max((high - low) * 0.12, spot * 0.015);
  return [low - pad, high + pad];
}

function scaleForCurve(spot, curve, zones) {
  let strikes = (curve || [])
    .filter(z => z.strike !== null && z.strike !== undefined)
    .map(z => Number(z.strike));

  if (strikes.length === 0) {
    strikes = (zones || [])
      .filter(z => z.strike !== null && z.strike !== undefined)
      .map(z => Number(z.strike));
  }
  if (strikes.length === 0) {
    strikes = [spot * 0.95, spot, spot * 1.05];
  }

  strikes.push(spot);
  const low = Math.min(...strikes);
  const high = Math.max(...strikes);
  const pad = Math.max((high - low) * 0.04, spot * 0.01);
  return [low - pad, high + pad];
}

function xForPrice(price, low, high) {
  if (high <= low) return (PLOT_LEFT + PLOT_RIGHT) / 2;
  return PLOT_LEFT + (Number(price) - low) / (high - low) * (PLOT_RIGHT - PLOT_LEFT);
}

function yForWeighted(value, maxValue) {
  if (maxValue <= 0) return PLOT_BOTTOM;
  const ratio = Math.max(0, Number(value)) / maxValue;
  return PLOT_BOTTOM - ratio * (PLOT_BOTTOM - PLOT_TOP);
}

function yForNet(value, maxAbs) {
  if (maxAbs <= 0) return ZERO_Y;
  const ratio = Math.max(-1, Math.min(1, Number(value) / maxAbs));
  return ZERO_Y - ratio * 42;
}

function svgText(x, y, text, size = 16, weight = 400, fill = '#0f172a', anchor = 'start') {
  return `<text x="${x}" y="${y}" font-family="Inter, Arial, sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${escapeHtml(text)}</text>`;
}

function renderChart(ticker, tickerData, report) {
  const window = tickerData.windows.nextWeek;
  const spot = Number(tickerData.spot);
  const zones = collectZones(window);
  const curve = zones;
  const [low, high] = scaleForZones(spot, zones);
  const curvePoints = curve.filter(z => z.strike !== null && z.strike !== undefined);
  const displayCurvePoints = filterPointsToDomain(curvePoints, low, high);
  const maxWeighted = Math.max(...displayCurvePoints.map(z => Number(z.weightedGravity || 0)), 0);
  const maxNetAbs = Math.max(...displayCurvePoints.map(z => Math.abs(Number(z.netGravity || 0))), 0);

  const upperPct = Number(window.upperWeightedGravityPct || 0);
  const lowerPct = Number(window.lowerWeightedGravityPct || 0);
  const upperWidth = BAR_WIDTH * upperPct / 100.0;
  const lowerWidth = BAR_WIDTH - upperWidth;
  const pullSkew = Number(window.pullSkew || 0);
  const rawSkew = Number(window.rawPullSkew || 0);

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
    '<rect width="100%" height="100%" fill="#f8fafc"/>',
    `<rect x="24" y="24" width="${WIDTH - 48}" height="${HEIGHT - 48}" rx="12" fill="#ffffff" stroke="#e2e8f0"/>`,
    svgText(48, 62, `${ticker} Weekly Gravity Structure`, 24, 700),
    svgText(48, 80, `Base date ${report.baseDate} · Spot ${fmt(spot)} · ${formatStructureLabel(window.structure)}`, 14, 500, '#475569'),
  ];
  parts.push(...renderScoreBadge(window.score));

  parts.push(
    svgText(CONTENT_LEFT, BAR_TOP - 8, 'Weighted pull distribution', 14, 700, '#334155'),
    `<rect x="${BAR_LEFT}" y="${BAR_TOP}" width="${BAR_WIDTH}" height="${BAR_HEIGHT}" rx="8" fill="#e2e8f0"/>`,
    `<rect x="${BAR_LEFT}" y="${BAR_TOP}" width="${lowerWidth}" height="${BAR_HEIGHT}" rx="8" fill="#dc2626" opacity="0.82"/>`,
    `<rect x="${BAR_LEFT + lowerWidth}" y="${BAR_TOP}" width="${upperWidth}" height="${BAR_HEIGHT}" rx="8" fill="#2563eb" opacity="0.82"/>`,
    svgText(BAR_LEFT + 12, BAR_TOP + 23, `Down ${fmt(lowerPct)}%`, 14, 700, '#ffffff'),
    svgText(BAR_LEFT + BAR_WIDTH - 12, BAR_TOP + 23, `Up ${fmt(upperPct)}%`, 14, 700, '#ffffff', 'end'),
    svgText(CONTENT_LEFT, BAR_TOP + 50, `Weighted skew ${fmt(pullSkew)} · Raw skew ${fmt(rawSkew)}`, 13, 500, '#64748b'),
  );

  const weightedPath = buildWeightedAreaPath(curvePoints, low, high, maxWeighted);
  const weightedLine = buildWeightedLinePath(curvePoints, low, high, maxWeighted);
  const netLine = buildNetLinePath(curvePoints, low, high, maxNetAbs);
  const spotX = xForPrice(spot, low, high);
  const spotLabelX = Math.min(spotX + 8, PLOT_RIGHT - 8);
  const spotLabelAnchor = spotLabelX >= PLOT_RIGHT - 8 ? 'end' : 'start';

  parts.push(
    svgText(CONTENT_LEFT, 204, 'Weighted gravity curve', 14, 700, '#334155'),
    svgText(CONTENT_RIGHT, 204, 'Filled Curve = Effective Pull · Thin Line = Signed Structure', 12, 500, '#64748b', 'end'),
    `<rect x="${PLOT_LEFT}" y="${PLOT_TOP}" width="${PLOT_RIGHT - PLOT_LEFT}" height="${PLOT_BOTTOM - PLOT_TOP}" rx="8" fill="#f8fafc" stroke="#e2e8f0"/>`,
    `<line x1="${PLOT_LEFT}" y1="${ZERO_Y}" x2="${PLOT_RIGHT}" y2="${ZERO_Y}" stroke="#cbd5e1" stroke-width="1.5"/>`,
    `<path d="${weightedPath}" fill="#60a5fa" opacity="0.24"/>`,
    `<path d="${weightedLine}" fill="none" stroke="#2563eb" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`,
    `<path d="${netLine}" fill="none" stroke="#475569" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" opacity="0.72"/>`,
    `<line x1="${spotX}" y1="${PLOT_TOP - 4}" x2="${spotX}" y2="${PLOT_BOTTOM + 24}" stroke="${SPOT_COLOR}" stroke-width="2.2" stroke-dasharray="5 5"/>`,
    svgText(spotLabelX, PLOT_TOP + 16, `Spot ${fmt(spot)}`, 13, 800, SPOT_COLOR, spotLabelAnchor),
    svgText(PLOT_LEFT, PLOT_BOTTOM + 22, fmt(low), 12, 500, '#64748b', 'start'),
    svgText(PLOT_RIGHT, PLOT_BOTTOM + 22, fmt(high), 12, 500, '#64748b', 'end'),
  );

  (window.strongestWeightedGravityZones || []).slice(0, LABEL_LIMIT).forEach((zone, idx) => {
    const strike = Number(zone.strike);
    const distance = Number(zone.distancePct || 0);
    const x = xForPrice(strike, low, high);
    const y = yForWeighted(Number(zone.weightedGravity || 0), maxWeighted);
    const color = weightedColor(distance);
    const labelY = idx % 2 === 0 ? PLOT_TOP - 8 : PLOT_BOTTOM + 18;
    parts.push(
      `<line x1="${x}" y1="${y}" x2="${x}" y2="${labelY + (idx % 2 === 0 ? 4 : -14)}" stroke="${color}" stroke-width="0.9" opacity="0.5"/>`,
      `<circle cx="${x}" cy="${y}" r="3.9" fill="${color}" opacity="0.9" stroke="#ffffff" stroke-width="1.2"/>`,
      svgText(x, labelY, fmt(strike), 11, 600, color, 'middle'),
    );
  });

  parts.push(
    svgText(CONTENT_LEFT, 420, 'Upper zones', 14, 700, '#2563eb'),
    svgText(352, 420, 'Lower zones', 14, 700, '#dc2626'),
    svgText(656, 420, 'Near spot', 14, 700, '#334155'),
  );

  drawZoneList(parts, CONTENT_LEFT, 444, (window.upperGravityZones || []).slice(0, 3), '#2563eb');
  drawZoneList(parts, 352, 444, (window.lowerGravityZones || []).slice(0, 3), '#dc2626');
  drawZoneList(parts, 656, 444, (window.nearGravityZones || []).slice(0, 3), '#334155');

  parts.push('</svg>');
  return parts.join('\n');
}

function buildWeightedAreaPath(points, low, high, maxWeighted) {
  if (!points.length) return '';
  const sortedPoints = filterPointsToDomain(points, low, high);
  let coords = sortedPoints.map(z => [xForPrice(z.strike, low, high), yForWeighted(z.weightedGravity || 0, maxWeighted)]);
  const edgeBaseline = coords.length ? Math.max(...coords.map(([, y]) => y)) : PLOT_BOTTOM;
  coords = extendCoordsToEdges(coords, edgeBaseline);
  const line = smoothPath(coords);
  return `M ${coords[0][0].toFixed(2)} ${PLOT_BOTTOM.toFixed(2)} L ${line.slice(2)} L ${coords[coords.length - 1][0].toFixed(2)} ${PLOT_BOTTOM.toFixed(2)} Z`;
}

function buildWeightedLinePath(points, low, high, maxWeighted) {
  if (!points.length) return '';
  const sortedPoints = filterPointsToDomain(points, low, high);
  let coords = sortedPoints.map(z => [xForPrice(z.strike, low, high), yForWeighted(z.weightedGravity || 0, maxWeighted)]);
  const edgeBaseline = coords.length ? Math.max(...coords.map(([, y]) => y)) : PLOT_BOTTOM;
  coords = extendCoordsToEdges(coords, edgeBaseline);
  return smoothPath(coords);
}

function buildNetLinePath(points, low, high, maxNetAbs) {
  if (!points.length) return '';
  const sortedPoints = filterPointsToDomain(points, low, high);
  let coords = sortedPoints.map(z => [xForPrice(z.strike, low, high), yForNet(z.netGravity || 0, maxNetAbs)]);
  coords = extendCoordsToEdges(coords, ZERO_Y);
  return smoothPath(coords);
}

function filterPointsToDomain(points, low, high) {
  let filtered = points.filter(z => z.strike !== null && z.strike !== undefined && low <= Number(z.strike) && Number(z.strike) <= high);
  if (filtered.length < 2) {
    filtered = points.filter(z => z.strike !== null && z.strike !== undefined);
  }
  return filtered.sort((a, b) => Number(a.strike) - Number(b.strike));
}

function extendCoordsToEdges(coords, baseline = null) {
  if (!coords.length) return coords;
  const extended = [...coords];
  const leftY = baseline !== null ? baseline : extended[0][1];
  const rightY = baseline !== null ? baseline : extended[extended.length - 1][1];
  if (extended[0][0] > PLOT_LEFT) {
    extended.unshift([PLOT_LEFT, leftY]);
  }
  if (extended[extended.length - 1][0] < PLOT_RIGHT) {
    extended.push([PLOT_RIGHT, rightY]);
  }
  return extended;
}

function smoothPath(coords) {
  if (!coords.length) return '';
  if (coords.length === 1) return `M ${coords[0][0].toFixed(2)} ${coords[0][1].toFixed(2)}`;
  const parts = [`M ${coords[0][0].toFixed(2)} ${coords[0][1].toFixed(2)}`];
  for (let idx = 1; idx < coords.length; idx++) {
    const [x0, y0] = coords[idx - 1];
    const [x1, y1] = coords[idx];
    const cx = (x0 + x1) / 2;
    parts.push(`C ${cx.toFixed(2)} ${y0.toFixed(2)}, ${cx.toFixed(2)} ${y1.toFixed(2)}, ${x1.toFixed(2)} ${y1.toFixed(2)}`);
  }
  return parts.join(' ');
}

function drawZoneList(parts, x, y, zones, color) {
  if (!zones.length) {
    parts.push(svgText(x, y, 'N/A', 13, 500, '#94a3b8'));
    return;
  }
  zones.forEach((zone, idx) => {
    const yy = y + idx * 24;
    const strike = fmt(zone.strike);
    const distance = fmt(zone.distancePct);
    const weight = fmt(zone.distanceWeight, 2);
    const gravity = formatGravityValue(zone.weightedGravity);
    parts.push(svgText(x, yy, `${strike} (${distance}%, ${gravity}, w ${weight})`, 13, 600, color));
  });
}

function main() {
  if (process.argv.length !== 4) {
    console.error('Usage: render_weekly_gravity_charts.js <report.json> <output_dir>');
    return 2;
  }

  const reportPath = process.argv[2];
  const outputDir = process.argv[3];
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const chartsDir = path.join(outputDir, 'charts');
  fs.mkdirSync(chartsDir, { recursive: true });

  let rendered = 0;
  Object.entries(report.tickers || {}).forEach(([ticker, tickerData]) => {
    if (tickerData.status !== 'ok') return;
    const svg = renderChart(ticker, tickerData, report);
    fs.writeFileSync(path.join(chartsDir, `${slug(ticker)}.svg`), svg, 'utf8');
    rendered += 1;
  });

  console.log(`Rendered ${rendered} charts to ${chartsDir}`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  renderChart,
};
