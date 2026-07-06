// 全局图表实例
let gravityChart = null;
let historyChart = null;

// 本地回放专用的全局状态
let isReplaying = false;
let replayHistory = [];
let replayIndex = 0;
let replayTimer = null;
let replaySpeed = 60; // 默认 60 倍速
let tooltipDismissTimer = null;

const ACCESS_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0eXBlIjoiYWNjZXNzIiwic3ViIjoiYTdkNmE1NjgtNzdkMS00NGI0LWFhZTAtZjVmNmU1MGMwODY1IiwiZW1haWwiOiJkZXZAa2FpcmFsZXJ0LnBybyIsInRpZXIiOiJwcm8rIiwiaWF0IjoxNzgzMzAxOTI4LCJleHAiOjE3ODU4OTM5Mjh9.q7bcqZuCZ4psZH-ruul_rCDMke76ZrqqJP3FzFyit2k';

function fetchJson(url, options) {
  const fetchOptions = {
    ...(options || {}),
    headers: {
      ...(options && options.headers ? options.headers : {}),
      Authorization: `Bearer ${ACCESS_TOKEN}`
    }
  };

  return fetch(url, fetchOptions).then(async res => {
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const data = await res.json();
        if (data && data.error) {
          message = data.error;
        }
      } catch {
        // Ignore invalid error bodies.
      }
      throw new Error(message);
    }
    return res.json();
  });
}

function formatCompactNumber(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '';
  if (num === 0) return '0';

  const sign = num < 0 ? '-' : '';
  const abs = Math.abs(num);
  const units = [
    { threshold: 1e12, suffix: 'T' },
    { threshold: 1e9, suffix: 'B' },
    { threshold: 1e6, suffix: 'M' },
    { threshold: 1e3, suffix: 'K' }
  ];
  const unit = units.find(item => abs >= item.threshold);

  if (!unit) {
    return `${sign}${abs >= 100 ? abs.toFixed(0) : abs.toFixed(abs >= 10 ? 1 : 2).replace(/\.?0+$/, '')}`;
  }

  const scaled = abs / unit.threshold;
  const decimals = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${sign}${scaled.toFixed(decimals).replace(/\.?0+$/, '')}${unit.suffix}`;
}

function formatGravity(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '$0';
  return `${num < 0 ? '-' : ''}$${formatCompactNumber(Math.abs(num))}`;
}

function formatWall(value) {
  const num = Number(value);
  return Number.isFinite(num) ? `$${num.toFixed(num >= 100 ? 0 : 2)}` : '--';
}

function getReferenceCardClass(score) {
  if (score >= 80) return 'glass-panel metric-card green';
  if (score >= 50) return 'glass-panel metric-card gold';
  return 'glass-panel metric-card rose';
}

function updateReferenceCard(reference) {
  const score = Number(reference && reference.score);
  gravityReferenceVal.textContent = Number.isFinite(score) ? `${Math.round(score)}` : '--';
  gravityReferenceNote.textContent = reference && reference.message
    ? reference.message
    : '引力位不是预测目标，而是需要重点观察的关键价格。';
  referenceCard.className = Number.isFinite(score)
    ? getReferenceCardClass(score)
    : 'glass-panel metric-card gold';
}

function getPointGravityMetrics(point) {
  const source = point && point.gravityMap ? point.gravityMap : (point || {});
  const openingGravity = Number(source.openingGravity) || 0;
  const liveGravity = Number(source.liveGravity) || 0;
  const sourceGravityShift = Number(source.gravityShift);

  return {
    openingGravity,
    liveGravity,
    gravityShift: Number.isFinite(sourceGravityShift) ? sourceGravityShift : liveGravity - openingGravity,
    openingUpperGravity: source.openingUpperGravity,
    openingLowerGravity: source.openingLowerGravity,
    openingGravityAxis: source.openingGravityAxis,
    upperGravity: source.upperGravity,
    lowerGravity: source.lowerGravity,
    gravityAxis: source.gravityAxis
  };
}

// ==========================================
// 1. 初始化 Chart.js 垂直标注线插件
// ==========================================
const verticalLinePlugin = {
  id: 'verticalLinePlugin',
  afterDatasetsDraw: (chart) => {
    if (!chart.options.plugins.verticalLines) return;
    const { ctx, chartArea: { top, bottom }, scales: { x } } = chart;
    const lines = chart.options.plugins.verticalLines;

    lines.forEach(line => {
      if (line.value === null || line.value === undefined) return;
      const xPos = x.getPixelForValue(line.value);

      // 检查像素坐标是否越界
      if (isNaN(xPos) || xPos < chart.chartArea.left || xPos > chart.chartArea.right) return;

      ctx.save();
      ctx.strokeStyle = line.color || '#fff';
      ctx.lineWidth = line.lineWidth || 1;
      if (line.dash) {
        ctx.setLineDash(line.dash);
      }

      ctx.beginPath();
      ctx.moveTo(xPos, top);
      ctx.lineTo(xPos, bottom);
      ctx.stroke();

      // 绘制标签文本
      ctx.fillStyle = line.color || '#fff';
      ctx.font = 'bold 9px "Inter", sans-serif';
      ctx.fillText(line.label || '', xPos + 4, top + (line.offset || 12));
      ctx.restore();
    });
  }
};

function isMobileChartLayout(chart) {
  return chart && chart.width <= 640;
}

function getGravityLiveLineWidth(chart) {
  return isMobileChartLayout(chart) ? 2.5 : 3;
}

function getDisplayGravityMap(map, chart) {
  const strikes = Array.isArray(map && map.strikes) ? map.strikes : [];
  const liveGravityCurve = Array.isArray(map && map.liveGravityCurve) ? map.liveGravityCurve : [];
  const openingGravityCurve = Array.isArray(map && map.openingGravityCurve) ? map.openingGravityCurve : [];

  if (!isMobileChartLayout(chart) || strikes.length <= 30) {
    return { strikes, liveGravityCurve, openingGravityCurve };
  }

  const excess = strikes.length - 30;
  const start = Math.floor(excess / 2);
  const end = strikes.length - Math.ceil(excess / 2);
  return {
    strikes: strikes.slice(start, end),
    liveGravityCurve: liveGravityCurve.slice(start, end),
    openingGravityCurve: openingGravityCurve.slice(start, end)
  };
}

const mobileYAxisLabelsPlugin = {
  id: 'mobileYAxisLabelsPlugin',
  beforeUpdate: (chart) => {
    if (!chart.canvas || !['gravityChart', 'historyChart'].includes(chart.canvas.id)) return;

    const mobile = isMobileChartLayout(chart);
    const leftAxisId = chart.canvas.id === 'gravityChart' ? 'y' : 'yNotional';
    const rightAxisId = chart.canvas.id === 'gravityChart' ? 'yGlobal' : 'yChange';
    const y = chart.options.scales[leftAxisId];
    const yGlobal = chart.options.scales[rightAxisId];
    if (!y) return;

    y.ticks.display = true;
    y.ticks.mirror = mobile;
    y.ticks.padding = mobile ? 1 : 3;
    y.title.display = !mobile;
    y.afterFit = scale => {
      if (isMobileChartLayout(chart)) scale.width = 8;
    };

    if (!yGlobal || yGlobal === y) return;

    yGlobal.ticks.display = true;
    yGlobal.ticks.mirror = mobile;
    yGlobal.ticks.padding = mobile ? 1 : 3;
    yGlobal.title.display = !mobile;
    yGlobal.afterFit = scale => {
      if (isMobileChartLayout(chart)) scale.width = 8;
    };
  }
};

const topAxisGridPlugin = {
  id: 'topAxisGridPlugin',
  afterDatasetsDraw: (chart) => {
    if (!chart.canvas || chart.canvas.id !== 'gravityChart') return;

    const { ctx, chartArea, scales } = chart;
    const x = scales.x;
    if (!x) return;

    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(chartArea.left, chartArea.top);
    ctx.lineTo(chartArea.right, chartArea.top);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    x.ticks.forEach(tick => {
      const xPos = x.getPixelForValue(tick.value);
      if (isNaN(xPos) || xPos < chartArea.left || xPos > chartArea.right) return;
      ctx.beginPath();
      ctx.moveTo(xPos, chartArea.top);
      ctx.lineTo(xPos, chartArea.top + 5);
      ctx.stroke();
    });
    ctx.restore();
  }
};

const activePointPlugin = {
  id: 'activePointPlugin',
  afterDatasetsDraw: (chart) => {
    const activeElements = chart.getActiveElements();
    if (!activeElements || activeElements.length === 0) return;

    const { ctx, chartArea } = chart;
    activeElements.forEach(active => {
      const point = active.element;
      if (!point) return;
      const { x, y } = point;
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < chartArea.left ||
        x > chartArea.right ||
        y < chartArea.top ||
        y > chartArea.bottom
      ) {
        return;
      }

      const dataset = chart.data.datasets[active.datasetIndex] || {};
      const color = dataset.borderColor || '#ffffff';

      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#080a10';
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = color;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(x, y, 2.2, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.restore();
    });
  }
};

// 注册插件
Chart.register(verticalLinePlugin, mobileYAxisLabelsPlugin, topAxisGridPlugin, activePointPlugin);

// ==========================================
// 2. DOM 元素获取
// ==========================================
const tickerSelect = document.getElementById('tickerSelect');
const startBtn = document.getElementById('startBtn');
const pauseBtn = document.getElementById('pauseBtn');
const resetBtn = document.getElementById('resetBtn');
const speedSelect = document.getElementById('speedSelect');

const simClock = document.getElementById('simClock');
const timeProgressBar = document.getElementById('timeProgressBar');
const spotVal = document.getElementById('spotVal');
const gravityShiftVal = document.getElementById('gravityShiftVal');
const gravityReferenceVal = document.getElementById('gravityReferenceVal');
const gravityReferenceNote = document.getElementById('gravityReferenceNote');
const referenceCard = document.getElementById('referenceCard');

const openingGravityVal = document.getElementById('openingGravityVal');
const influenceCard = document.getElementById('influenceCard');

const liveGravityVal = document.getElementById('liveGravityVal');

const wallsVal = document.getElementById('wallsVal');
const gravityAxisVal = document.getElementById('gravityAxisVal');
const wallsCard = document.getElementById('wallsCard');

const statusBadge = document.getElementById('statusBadge');
const modelNoteContent = document.getElementById('modelNoteContent');

// ==========================================
// 3. 页面载入初始化
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  // 3.1 加载 Ticker 列表
  fetchJson('/api/tickers')
    .then(tickers => {
      tickerSelect.innerHTML = '';
      tickers.forEach(t => {
        const option = document.createElement('option');
        option.value = t.name;
        option.textContent = `${t.name} (${t.count} signals)`;
        tickerSelect.appendChild(option);
      });
      // 获取 URL 参数中的 ticker，若没有则默认选择 QQQ
      const urlParams = new URLSearchParams(window.location.search);
      const urlTicker = urlParams.get('ticker');
      if (urlTicker) {
        const uppercaseUrlTicker = urlTicker.toUpperCase();
        if (Array.from(tickerSelect.options).some(opt => opt.value === uppercaseUrlTicker)) {
          tickerSelect.value = uppercaseUrlTicker;
        } else {
          tickerSelect.value = 'QQQ';
        }
      } else {
        tickerSelect.value = 'QQQ';
      }
      initCharts();
      bindMobileTooltipDismissal();
      pollState();
    })
    .catch(err => {
      console.error('Failed to load tickers:', err);
      showErrorToast('加载标的列表失败');
    });

  // 3.2 绑定控制面板事件
  startBtn.addEventListener('click', () => handleStart());
  pauseBtn.addEventListener('click', () => handlePause());
  resetBtn.addEventListener('click', () => handleReset());
  speedSelect.addEventListener('change', () => {
    handleSpeedChange();
  });
  tickerSelect.addEventListener('change', () => {
    exitReplay();
    resetCharts();
    updateGravityChartTitle(tickerSelect.value, document.getElementById('rangeFilter').value, '', '');
    pollState();
  });

  const rangeFilter = document.getElementById('rangeFilter');
  rangeFilter.addEventListener('change', () => {
    updateGravityChartTitle(tickerSelect.value, rangeFilter.value, '', '');
    if (isReplaying) {
      renderReplayFrame();
    } else {
      updateCharts();
    }
  });

});

// ==========================================
// 4. 前端本地回放引擎核心逻辑
// ==========================================

function handleStart() {
  if (isReplaying) {
    if (!replayTimer && replayIndex < replayHistory.length) {
      startLocalReplayTimer();
    }
  } else {
    handleReset().then(() => {
      startLocalReplayTimer();
    });
  }
}

function handlePause() {
  pauseLocalReplay();
}

function handleReset() {
  exitReplay();
  resetCharts();

  const range = document.getElementById('rangeFilter').value;
  return fetchJson(`/api/gravity-history?ticker=${tickerSelect.value}&range=${range}`)
    .then(history => {
      replayHistory = history;
      replayIndex = 0;
      pauseLocalReplay();
      renderReplayFrame();
    })
    .catch(err => {
      console.error('Failed to reset simulation:', err);
      showErrorToast('重置模拟失败');
    });
}

function handleSpeedChange() {
  replaySpeed = parseInt(speedSelect.value) || 60;
  if (isReplaying && replayTimer) {
    startLocalReplayTimer();
  }
}

function startLocalReplayTimer() {
  isReplaying = true; // 开启回放状态，挂起实时数据轮询
  if (replayTimer) clearInterval(replayTimer);

  // 60倍速 -> 1秒(1000ms) 走 60秒(1分钟)
  // 120倍速 -> 500ms 走 1分钟
  // 300倍速 -> 200ms 走 1分钟
  const tickMs = Math.max(50, 60000 / replaySpeed);
  replayTimer = setInterval(() => {
    replayIndex++;
    if (replayIndex >= replayHistory.length) {
      replayIndex = replayHistory.length - 1;
      pauseLocalReplay();
    }
    renderReplayFrame();
  }, tickMs);

  startBtn.classList.add('active-btn');
  pauseBtn.classList.remove('active-btn');
}

function pauseLocalReplay() {
  if (replayTimer) {
    clearInterval(replayTimer);
    replayTimer = null;
  }
  startBtn.classList.remove('active-btn');
  pauseBtn.classList.add('active-btn');
}

function exitReplay() {
  isReplaying = false;
  if (replayTimer) {
    clearInterval(replayTimer);
    replayTimer = null;
  }
  replayHistory = [];
  replayIndex = 0;
}

function renderReplayFrame() {
  if (replayHistory.length === 0 || replayIndex >= replayHistory.length) return;

  const point = replayHistory[replayIndex];
  const range = document.getElementById('rangeFilter').value;
  const pointGravity = getPointGravityMetrics(point);

  // 1. 更新模拟时钟与进度条
  simClock.textContent = point.time + ":00";
  const pct = ((point.sec - 9.5 * 3600) / (6.5 * 3600)) * 100;
  timeProgressBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;

  // 2. 更新核心引力指标
  spotVal.textContent = `$${point.spot.toFixed(2)}`;
  gravityShiftVal.textContent = formatGravity(pointGravity.gravityShift);
  updateReferenceCard(point.gravityReference);
  openingGravityVal.textContent = formatGravity(pointGravity.openingGravity);
  liveGravityVal.textContent = formatGravity(pointGravity.liveGravity);
  wallsVal.textContent = `${formatWall(pointGravity.lowerGravity)} / ${formatWall(pointGravity.upperGravity)}`;
  gravityAxisVal.textContent = `引力中轴: ${formatWall(pointGravity.gravityAxis)}`;
  influenceCard.className = pointGravity.openingGravity >= 0 ? 'glass-panel metric-card green' : 'glass-panel metric-card rose';
  wallsCard.className = pointGravity.liveGravity >= 0 ? 'glass-panel metric-card cyan' : 'glass-panel metric-card rose';

  // 4. 更新引力分布图
  const gravityMap = point.gravityMap || null;
  updateGravityChartTitle(tickerSelect.value, range, point.date, point.time);

  if (gravityMap && gravityChart) {
    const displayMap = getDisplayGravityMap(gravityMap, gravityChart);
    const smoothData = smoothGravityData(
      displayMap.strikes,
      displayMap.liveGravityCurve,
      displayMap.openingGravityCurve
    );
    gravityChart.$rawGravityData = {
      strikes: displayMap.strikes,
      liveGravityCurve: displayMap.liveGravityCurve,
      openingGravityCurve: displayMap.openingGravityCurve
    };
    gravityChart.data.labels = [];

    // Dataset 0: 实时引力
    gravityChart.data.datasets[0].data = smoothData.liveGravityCurve;
    gravityChart.data.datasets[0].pointBackgroundColor = smoothData.liveGravityCurve.map(() => 'rgba(255, 42, 95, 1)');
    gravityChart.data.datasets[0].pointBorderColor = smoothData.liveGravityCurve.map(() => 'rgba(255, 42, 95, 0.3)');

    // Dataset 1: 开盘引力
    gravityChart.data.datasets[1].data = smoothData.openingGravityCurve;
    gravityChart.data.datasets[1].pointBackgroundColor = smoothData.openingGravityCurve.map(() => 'rgba(156, 163, 175, 0.85)');
    gravityChart.data.datasets[1].pointBorderColor = smoothData.openingGravityCurve.map(() => 'rgba(156, 163, 175, 0.25)');

    gravityChart.options.plugins.verticalLines = [
      { value: point.spot, color: 'rgba(255, 204, 0, 0.5)', lineWidth: 1, dash: [4, 4], label: 'Spot', offset: 12 },
      { value: gravityMap.upperGravity, color: 'rgba(156, 163, 175, 0.45)', lineWidth: 1, label: `上方引力位 (${gravityMap.upperGravity || '无'})`, offset: 35 },
      { value: gravityMap.lowerGravity, color: 'rgba(255, 42, 95, 0.45)', lineWidth: 1, label: `下方引力位 (${gravityMap.lowerGravity || '无'})`, offset: 55 },
      { value: gravityMap.gravityAxis, color: 'rgba(255, 255, 255, 0.35)', lineWidth: 1, dash: [2, 2], label: `引力中轴 (${gravityMap.gravityAxis || '无'})`, offset: 75 }
    ];
    gravityChart.update('none');
  }

  // 5. 更新时序图（只绘制到当前播放进度，实现折线向右流动的效果）
  if (historyChart) {
    const historySub = replayHistory.slice(0, replayIndex + 1);

    const labels = historySub.map(h => h.time);
    const openingGravitySeries = historySub.map(h => getPointGravityMetrics(h).openingGravity / 1e6);
    const liveGravitySeries = historySub.map(h => getPointGravityMetrics(h).liveGravity / 1e6);
    const gravityShift = historySub.map(h => getPointGravityMetrics(h).gravityShift / 1e6);

    historyChart.data.labels = labels;
    historyChart.data.datasets[0].data = openingGravitySeries;
    historyChart.data.datasets[1].data = liveGravitySeries;
    historyChart.data.datasets[2].data = gravityShift;

    historyChart.update('none');
  }
}

function catmullRomInterpolate(xs, ys, samplesPerSegment = 10) {
  if (!Array.isArray(xs) || !Array.isArray(ys) || xs.length !== ys.length || xs.length < 3) {
    return (xs || []).map((x, i) => ({ x, y: ys[i] || 0 }));
  }

  const points = [];
  for (let i = 0; i < xs.length - 1; i++) {
    const y0 = ys[Math.max(0, i - 1)];
    const y1 = ys[i];
    const y2 = ys[i + 1];
    const y3 = ys[Math.min(ys.length - 1, i + 2)];
    const x1 = xs[i];
    const x2 = xs[i + 1];

    for (let step = 0; step < samplesPerSegment; step++) {
      const t = step / samplesPerSegment;
      const t2 = t * t;
      const t3 = t2 * t;
      const y = 0.5 * (
        (2 * y1) +
        (-y0 + y2) * t +
        (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2 +
        (-y0 + 3 * y1 - 3 * y2 + y3) * t3
      );
      points.push({
        x: x1 + (x2 - x1) * t,
        y
      });
    }
  }

  points.push({ x: xs[xs.length - 1], y: ys[ys.length - 1] });
  return points;
}

function smoothGravityData(strikes, liveGravityCurve, openingGravityCurve) {
  const xs = (strikes || []).map(Number);
  return {
    liveGravityCurve: catmullRomInterpolate(xs, liveGravityCurve || []),
    openingGravityCurve: catmullRomInterpolate(xs, openingGravityCurve || [])
  };
}

function getRangeLabel(range) {
  if (range === 'today') return '当日引力';
  if (range === 'near') return '近期引力';
  return '全部引力';
}

function updateGravityChartTitle(ticker, range, date, time) {
  const titleEl = document.getElementById('gravityChartTitle');
  if (!titleEl) return;

  const parts = [
    ticker ? ticker.toUpperCase() : '',
    // '引力分布图',
    // getRangeLabel(range),
    [date, time].filter(Boolean).join(' ')
  ].filter(Boolean);

  titleEl.textContent = parts.join(' · ');
}

function findNearestRawGravityIndex(xValue) {
  const raw = gravityChart && gravityChart.$rawGravityData;
  if (!raw || !Array.isArray(raw.strikes) || raw.strikes.length === 0) return -1;

  let nearestIdx = 0;
  let nearestDiff = Math.abs(Number(raw.strikes[0]) - xValue);
  for (let i = 1; i < raw.strikes.length; i++) {
    const diff = Math.abs(Number(raw.strikes[i]) - xValue);
    if (diff < nearestDiff) {
      nearestDiff = diff;
      nearestIdx = i;
    }
  }
  return nearestIdx;
}

function hideChartTooltips() {
  if (tooltipDismissTimer) {
    clearTimeout(tooltipDismissTimer);
    tooltipDismissTimer = null;
  }
  [gravityChart, historyChart].forEach(chart => {
    if (!chart) return;
    chart.setActiveElements([]);
    if (chart.tooltip) {
      chart.tooltip.setActiveElements([], { x: 0, y: 0 });
    }
    chart.update('none');
  });
}

function scheduleChartTooltipDismissal() {
  if (!window.matchMedia('(max-width: 640px)').matches) return;
  if (tooltipDismissTimer) clearTimeout(tooltipDismissTimer);
  tooltipDismissTimer = setTimeout(hideChartTooltips, 2500);
}

function bindMobileTooltipDismissal() {
  document.addEventListener('pointerdown', event => {
    if (!window.matchMedia('(max-width: 640px)').matches) return;
    if (event.target === gravityChart?.canvas || event.target === historyChart?.canvas) return;
    hideChartTooltips();
  }, { capture: true });

  window.addEventListener('scroll', () => {
    if (window.matchMedia('(max-width: 640px)').matches) {
      hideChartTooltips();
    }
  }, { passive: true });

  window.addEventListener('touchmove', () => {
    if (window.matchMedia('(max-width: 640px)').matches) {
      hideChartTooltips();
    }
  }, { passive: true });

  [gravityChart, historyChart].forEach(chart => {
    if (!chart) return;
    chart.canvas.addEventListener('pointerup', scheduleChartTooltipDismissal, { passive: true });
    chart.canvas.addEventListener('touchend', scheduleChartTooltipDismissal, { passive: true });
  });
}

// ==========================================
// 5. 网页实时拉取刷新函数
// ==========================================

function pollState() {
  if (isReplaying) return; // 回放模式下挂起轮询请求，防止污染

  const ticker = tickerSelect.value;
  fetchJson(`/api/gravity-state?ticker=${ticker}`)
    .then(state => {
      updateUIState(state);
      if (state.isRunning || state.currentTime === '16:00:00') {
        updateCharts();
      }
    })
    .catch(err => {
      console.error('Failed to poll state:', err);
      showErrorToast('获取状态数据失败');
    });
}

function updateUIState(state) {
  if (!state) return;

  simClock.textContent = state.currentTime;
  timeProgressBar.style.width = `${state.currentTimePct}%`;

  if (state.isRunning) {
    startBtn.classList.add('active-btn');
    pauseBtn.classList.remove('active-btn');
  } else {
    startBtn.classList.remove('active-btn');
    pauseBtn.classList.add('active-btn');
  }

  spotVal.textContent = `$${state.spot.toFixed(2)}`;
  const gravity = state.latestGravity || {};
  gravityShiftVal.textContent = formatGravity(gravity.gravityShift);
  updateReferenceCard(state.gravityReference);
  openingGravityVal.textContent = formatGravity(gravity.openingGravity);
  liveGravityVal.textContent = formatGravity(gravity.liveGravity);
  wallsVal.textContent = `${formatWall(gravity.lowerGravity)} / ${formatWall(gravity.upperGravity)}`;
  gravityAxisVal.textContent = `引力中轴: ${formatWall(gravity.gravityAxis)}`;
  influenceCard.className = (gravity.openingGravity || 0) >= 0 ? 'glass-panel metric-card green' : 'glass-panel metric-card rose';
  wallsCard.className = (gravity.liveGravity || 0) >= 0 ? 'glass-panel metric-card cyan' : 'glass-panel metric-card rose';
  statusBadge.textContent = '引力流';
  statusBadge.className = 'status-badge badge-neutral';
  modelNoteContent.textContent = '引力流为模型估算值，引力位不是预测目标，而是需要重点观察的关键价格。';
}

// ==========================================
// 6. 图表绘制与更新 (Chart.js)
// ==========================================

function initCharts() {
  const gravityCtx = document.getElementById('gravityChart').getContext('2d');
  const historyCtx = document.getElementById('historyChart').getContext('2d');

  gravityChart = new Chart(gravityCtx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: '实时引力',
          data: [],
          yAxisID: 'y',
          borderColor: 'rgba(255, 42, 95, 1)',
          borderWidth: context => getGravityLiveLineWidth(context.chart),
          tension: 0,
          borderCapStyle: 'round',
          borderJoinStyle: 'round',
          pointRadius: 0,
          pointHoverRadius: 0,
          pointHitRadius: 6,
          pointBackgroundColor: [],
          pointBorderColor: [],
          fill: false
        },
        {
          label: '开盘引力',
          data: [],
          yAxisID: 'yGlobal',
          borderColor: 'rgba(156, 163, 175, 0.85)',
          borderWidth: 1.35,
          borderDash: [5, 5],
          tension: 0,
          borderCapStyle: 'round',
          borderJoinStyle: 'round',
          pointRadius: 0,
          pointHoverRadius: 0,
          pointHitRadius: 6,
          pointBackgroundColor: [],
          pointBorderColor: [],
          fill: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      scales: {
        x: {
          type: 'linear',
          bounds: 'data',
          grid: { color: 'rgba(255, 255, 255, 0.03)' },
          ticks: {
            color: '#9ca3af',
            font: { family: 'Inter' },
            maxTicksLimit: 16,
            callback: value => Number(value).toFixed(0)
          }
        },
        y: {
          type: 'linear',
          display: true,
          position: 'left',
          grid: {
            color: ctx => {
              if (ctx.tick && ctx.tick.value === 0) {
                return 'rgba(255, 255, 255, 0.2)'; // 高亮 0 轴线（颜色再浅一点）
              }
              return 'rgba(255, 255, 255, 0.05)';
            },
            lineWidth: ctx => {
              if (ctx.tick && ctx.tick.value === 0) {
                return 1.2; // 微加粗 0 轴线
              }
              return 1;
            }
          },
          ticks: {
            color: 'rgba(255, 42, 95, 0.8)',
            font: { family: 'Inter' },
            callback: value => formatCompactNumber(value)
          },
          title: {
            display: true,
            text: '实时引力',
            color: 'rgba(255, 42, 95, 0.8)',
            font: { family: 'Inter', size: 10, weight: 'bold' }
          }
        },
        yGlobal: {
          type: 'linear',
          display: true,
          position: 'right',
          grid: {
            drawOnChartArea: false, // avoid cluttered gridlines
            color: 'rgba(255, 255, 255, 0.05)'
          },
          ticks: {
            color: 'rgba(156, 163, 175, 0.75)',
            font: { family: 'Inter' },
            callback: value => formatCompactNumber(value)
          },
          title: {
            display: true,
            text: '全局引力',
            color: 'rgba(156, 163, 175, 0.75)',
            font: { family: 'Inter', size: 10, weight: 'bold' }
          }
        }
      },
      plugins: {
        legend: {
          display: false,
          position: 'top',
          labels: {
            color: '#9ca3af',
            font: { family: 'Inter', size: 11 }
          }
        },
        tooltip: {
          enabled: true,
          callbacks: {
            title: function (context) {
              const nearestIdx = findNearestRawGravityIndex(context[0].parsed.x);
              const raw = gravityChart && gravityChart.$rawGravityData;
              if (nearestIdx >= 0 && raw) {
                return `Price: $${Number(raw.strikes[nearestIdx]).toFixed(0)}`;
              }
              return `Price: $${context[0].parsed.x.toFixed(2)}`;
            },
            label: function (context) {
              const datasetLabel = context.dataset.label || '';
              const nearestIdx = findNearestRawGravityIndex(context.parsed.x);
              const raw = gravityChart && gravityChart.$rawGravityData;
              if (nearestIdx >= 0 && raw) {
                const values = context.datasetIndex === 0 ? raw.liveGravityCurve : raw.openingGravityCurve;
                const rawValue = values && values[nearestIdx];
                if (rawValue !== undefined) {
                  return `${datasetLabel}: ${formatCompactNumber(rawValue)}`;
                }
              }
              return `${datasetLabel}: ${formatCompactNumber(context.parsed.y)}`;
            }
          }
        },
        verticalLines: []
      }
    }
  });

  historyChart = new Chart(historyCtx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: '开盘引力',
          data: [],
          borderColor: 'rgba(156, 163, 175, 0.85)',
          borderWidth: 1.5,
          borderDash: [5, 5],
          yAxisID: 'yNotional',
          tension: 0.1,
          pointRadius: 0
        },
        {
          label: '实时引力',
          data: [],
          borderColor: '#00f2fe',
          borderWidth: 2,
          yAxisID: 'yNotional',
          tension: 0.1,
          pointRadius: 0
        },
        {
          label: '盘中引力偏移',
          data: [],
          borderColor: '#ffcc00',
          borderWidth: 2,
          borderDash: [2, 4],
          yAxisID: 'yChange',
          tension: 0.1,
          pointRadius: 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          grid: { color: 'rgba(255, 255, 255, 0.03)' },
          ticks: { color: '#9ca3af', font: { family: 'Inter' } }
        },
        yNotional: {
          position: 'left',
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: { color: '#00f2fe', font: { family: 'Inter' } },
          title: {
            display: true,
            text: '引力规模',
            color: '#00f2fe',
            font: { family: 'Inter', size: 10, weight: 'bold' }
          }
        },
        yChange: {
          position: 'right',
          grid: { drawOnChartArea: false },
          ticks: { color: '#ffcc00', font: { family: 'Inter' } },
          title: {
            display: true,
            text: '盘中引力偏移',
            color: '#ffcc00',
            font: { family: 'Inter', size: 10, weight: 'bold' }
          }
        }
      },
      plugins: {
        legend: {
          display: true,
          labels: { color: '#9ca3af', font: { family: 'Inter', size: 10 }, boxWidth: 18 }
        }
      }
    }
  });
}

function updateCharts() {
  if (isReplaying) return;

  const ticker = tickerSelect.value;
  const range = document.getElementById('rangeFilter').value;

  fetchJson(`/api/gravity-map?ticker=${ticker}&range=${range}`)
    .then(data => {
      if (!gravityChart) return;

      const displayMap = getDisplayGravityMap(data, gravityChart);
      const smoothData = smoothGravityData(
        displayMap.strikes,
        displayMap.liveGravityCurve,
        displayMap.openingGravityCurve
      );
      gravityChart.$rawGravityData = {
        strikes: displayMap.strikes,
        liveGravityCurve: displayMap.liveGravityCurve,
        openingGravityCurve: displayMap.openingGravityCurve
      };
      gravityChart.data.labels = [];

      // Dataset 0: 实时引力
      gravityChart.data.datasets[0].data = smoothData.liveGravityCurve;
      gravityChart.data.datasets[0].pointBackgroundColor = smoothData.liveGravityCurve.map(() => 'rgba(255, 42, 95, 1)');
      gravityChart.data.datasets[0].pointBorderColor = smoothData.liveGravityCurve.map(() => 'rgba(255, 42, 95, 0.3)');

      // Dataset 1: 开盘引力
      gravityChart.data.datasets[1].data = smoothData.openingGravityCurve;
      gravityChart.data.datasets[1].pointBackgroundColor = smoothData.openingGravityCurve.map(() => 'rgba(156, 163, 175, 0.85)');
      gravityChart.data.datasets[1].pointBorderColor = smoothData.openingGravityCurve.map(() => 'rgba(156, 163, 175, 0.25)');

      const currentSpot = parseFloat(spotVal.textContent.replace('$', ''));
      gravityChart.options.plugins.verticalLines = [
        { value: currentSpot, color: 'rgba(255, 204, 0, 0.5)', lineWidth: 1, dash: [4, 4], label: 'Spot', offset: 12 },
        { value: data.upperGravity, color: 'rgba(156, 163, 175, 0.45)', lineWidth: 1, label: `上方引力位 (${data.upperGravity || '无'})`, offset: 35 },
        { value: data.lowerGravity, color: 'rgba(255, 42, 95, 0.45)', lineWidth: 1, label: `下方引力位 (${data.lowerGravity || '无'})`, offset: 55 },
        { value: data.gravityAxis, color: 'rgba(255, 255, 255, 0.35)', lineWidth: 1, dash: [2, 2], label: `引力中轴 (${data.gravityAxis || '无'})`, offset: 75 }
      ];

      gravityChart.update('none');
    })
    .catch(err => {
      console.error('Failed to fetch gravity data:', err);
      showErrorToast('加载引力数据失败');
    });

  fetchJson(`/api/gravity-history?ticker=${ticker}&range=${range}`)
    .then(history => {
      if (!historyChart || history.length === 0) return;
      const latestPoint = history[history.length - 1];
      updateGravityChartTitle(ticker, range, latestPoint.date, latestPoint.time);

      const labels = history.map(h => h.time);
      const openingGravitySeries = history.map(h => getPointGravityMetrics(h).openingGravity / 1e6);
      const liveGravitySeries = history.map(h => getPointGravityMetrics(h).liveGravity / 1e6);
      const gravityShift = history.map(h => getPointGravityMetrics(h).gravityShift / 1e6);

      historyChart.data.labels = labels;
      historyChart.data.datasets[0].data = openingGravitySeries;
      historyChart.data.datasets[1].data = liveGravitySeries;
      historyChart.data.datasets[2].data = gravityShift;

      historyChart.update('none');
    })
    .catch(err => {
      console.error('Failed to fetch history data:', err);
      showErrorToast('加载历史数据失败');
    });
}

function resetCharts() {
  if (gravityChart) {
    gravityChart.$rawGravityData = null;
    gravityChart.data.labels = [];
    gravityChart.data.datasets[0].data = [];
    gravityChart.data.datasets[1].data = [];
    gravityChart.options.plugins.verticalLines = [];
    gravityChart.update();
  }
  if (historyChart) {
    historyChart.data.labels = [];
    historyChart.data.datasets[0].data = [];
    historyChart.data.datasets[1].data = [];
    historyChart.data.datasets[2].data = [];
    historyChart.update();
  }
}

function showErrorToast(message) {
  let toast = document.getElementById('errorToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'errorToast';
    toast.style.position = 'fixed';
    toast.style.bottom = '20px';
    toast.style.right = '20px';
    toast.style.background = 'rgba(255, 42, 95, 0.9)';
    toast.style.color = '#fff';
    toast.style.padding = '12px 24px';
    toast.style.borderRadius = '8px';
    toast.style.zIndex = '9999';
    toast.style.boxShadow = '0 4px 12px rgba(0,0,0,0.5)';
    toast.style.fontFamily = 'Inter, sans-serif';
    toast.style.fontSize = '14px';
    toast.style.transition = 'opacity 0.3s ease';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.opacity = '1';

  if (window.errorToastTimeout) clearTimeout(window.errorToastTimeout);
  window.errorToastTimeout = setTimeout(() => {
    toast.style.opacity = '0';
  }, 5000);
}
