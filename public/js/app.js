// 全局图表实例
let gexChart = null;
let historyChart = null;
let updateInterval = null;

// 本地回放专用的全局状态
let isReplaying = false;
let replayHistory = [];
let replayIndex = 0;
let replayTimer = null;
let replaySpeed = 60; // 默认 60 倍速

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

function formatGex(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '$0';
  return `${num < 0 ? '-' : ''}$${formatCompactNumber(Math.abs(num))}`;
}

function formatWall(value) {
  const num = Number(value);
  return Number.isFinite(num) ? `$${num.toFixed(num >= 100 ? 0 : 2)}` : '--';
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

const mobileYAxisLabelsPlugin = {
  id: 'mobileYAxisLabelsPlugin',
  beforeUpdate: (chart) => {
    if (!chart.canvas || !['gexChart', 'historyChart'].includes(chart.canvas.id)) return;

    const mobile = isMobileChartLayout(chart);
    const leftAxisId = chart.canvas.id === 'gexChart' ? 'y' : 'yPrice';
    const rightAxisId = chart.canvas.id === 'gexChart' ? 'yGlobal' : 'yNotional';
    const y = chart.options.scales[leftAxisId];
    const yGlobal = chart.options.scales[rightAxisId];
    if (!y || !yGlobal) return;

    y.ticks.display = true;
    y.ticks.mirror = mobile;
    y.ticks.padding = mobile ? 6 : 3;
    y.title.display = !mobile;
    y.afterFit = scale => {
      if (isMobileChartLayout(chart)) scale.width = 8;
    };

    yGlobal.ticks.display = true;
    yGlobal.ticks.mirror = mobile;
    yGlobal.ticks.padding = mobile ? 6 : 3;
    yGlobal.title.display = !mobile;
    yGlobal.afterFit = scale => {
      if (isMobileChartLayout(chart)) scale.width = 8;
    };
  }
};

const topAxisGridPlugin = {
  id: 'topAxisGridPlugin',
  afterDatasetsDraw: (chart) => {
    if (!chart.canvas || chart.canvas.id !== 'gexChart') return;

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

// 注册插件
Chart.register(verticalLinePlugin, mobileYAxisLabelsPlugin, topAxisGridPlugin);

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
const gexChangeVal = document.getElementById('gexChangeVal');

const globalGexVal = document.getElementById('globalGexVal');
const influenceCard = document.getElementById('influenceCard');

const realtimeGexVal = document.getElementById('realtimeGexVal');

const wallsVal = document.getElementById('wallsVal');
const zeroGammaVal = document.getElementById('zeroGammaVal');
const wallsCard = document.getElementById('wallsCard');

const statusBadge = document.getElementById('statusBadge');
const modelNoteContent = document.getElementById('modelNoteContent');

// ==========================================
// 3. 页面载入初始化
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  // 3.1 加载 Ticker 列表
  fetch('/api/tickers')
    .then(res => res.json())
    .then(tickers => {
      tickerSelect.innerHTML = '';
      tickers.forEach(t => {
        const option = document.createElement('option');
        option.value = t.name;
        option.textContent = `${t.name} (${t.count} alerts)`;
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
    updateGexChartTitle(tickerSelect.value, document.getElementById('expiryFilter').value, '', '');
    pollState();
  });

  const expiryFilter = document.getElementById('expiryFilter');
  expiryFilter.addEventListener('change', () => {
    updateGexChartTitle(tickerSelect.value, expiryFilter.value, '', '');
    if (isReplaying) {
      renderReplayFrame();
    } else {
      updateCharts();
    }
  });

  // 开启轮询 (每 30 秒刷新)
  updateInterval = setInterval(pollState, 30000);
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

  return fetch(`/api/history?ticker=${tickerSelect.value}&expiry=all`)
    .then(res => res.json())
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

  // 1. 更新模拟时钟与进度条
  simClock.textContent = point.time + ":00";
  const pct = ((point.sec - 9.5 * 3600) / (6.5 * 3600)) * 100;
  timeProgressBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;

  // 2. 更新核心 GEX 指标
  spotVal.textContent = `$${point.spot.toFixed(2)}`;
  gexChangeVal.textContent = formatGex(point.gexChange);
  globalGexVal.textContent = formatGex(point.globalTotalGex);
  realtimeGexVal.textContent = formatGex(point.realtimeTotalGex);
  wallsVal.textContent = `${formatWall(point.realtimePutWall)} / ${formatWall(point.realtimeCallWall)}`;
  zeroGammaVal.textContent = `Zero Gamma: ${formatWall(point.realtimeZeroGamma)}`;
  influenceCard.className = point.globalTotalGex >= 0 ? 'glass-panel metric-card green' : 'glass-panel metric-card rose';
  wallsCard.className = point.realtimeTotalGex >= 0 ? 'glass-panel metric-card cyan' : 'glass-panel metric-card rose';

  // 4. 更新 GEX 柱状图
  const expiry = document.getElementById('expiryFilter').value;
  const gexData = point.gexData ? point.gexData[expiry] : null;
  updateGexChartTitle(tickerSelect.value, expiry, point.date, point.time);

  if (gexData && gexChart) {
    const smoothData = smoothGexData(
      gexData.strikes,
      gexData.realtimeStrikeGexMillions,
      gexData.globalStrikeGexMillions
    );
    gexChart.$rawGexData = {
      strikes: gexData.strikes || [],
      realtimeStrikeGexMillions: gexData.realtimeStrikeGexMillions || [],
      globalStrikeGexMillions: gexData.globalStrikeGexMillions || []
    };
    gexChart.data.labels = [];
    
    // Dataset 0: 实时状态
    gexChart.data.datasets[0].data = smoothData.realtimeStrikeGex;
    gexChart.data.datasets[0].pointBackgroundColor = smoothData.realtimeStrikeGex.map(() => 'rgba(255, 42, 95, 1)');
    gexChart.data.datasets[0].pointBorderColor = smoothData.realtimeStrikeGex.map(() => 'rgba(255, 42, 95, 0.3)');

    // Dataset 1: 全局地图
    gexChart.data.datasets[1].data = smoothData.globalStrikeGex;
    gexChart.data.datasets[1].pointBackgroundColor = smoothData.globalStrikeGex.map(() => 'rgba(156, 163, 175, 0.85)');
    gexChart.data.datasets[1].pointBorderColor = smoothData.globalStrikeGex.map(() => 'rgba(156, 163, 175, 0.25)');

    gexChart.options.plugins.verticalLines = [
      { value: point.spot, color: 'rgba(255, 204, 0, 0.5)', lineWidth: 1, dash: [4, 4], label: 'Spot', offset: 12 },
      { value: gexData.realtimeCallWall, color: 'rgba(156, 163, 175, 0.45)', lineWidth: 1, label: `Call Wall (${gexData.realtimeCallWall || '无'})`, offset: 35 },
      { value: gexData.realtimePutWall, color: 'rgba(255, 42, 95, 0.45)', lineWidth: 1, label: `Put Wall (${gexData.realtimePutWall || '无'})`, offset: 55 },
      { value: gexData.realtimeZeroGamma, color: 'rgba(255, 255, 255, 0.35)', lineWidth: 1, dash: [2, 2], label: `ZeroGamma (${gexData.realtimeZeroGamma || '无'})`, offset: 75 }
    ];
    gexChart.update('none');
  }

  // 5. 更新时序图（只绘制到当前播放进度，实现折线向右流动的效果）
  if (historyChart) {
    const historySub = replayHistory.slice(0, replayIndex + 1);

    const labels = historySub.map(h => h.time);
    const spots = historySub.map(h => h.spot);
    const globalGex = historySub.map(h => (h.globalTotalGex || 0) / 1e6);
    const realtimeGex = historySub.map(h => (h.realtimeTotalGex || 0) / 1e6);

    historyChart.data.labels = labels;
    historyChart.data.datasets[0].data = spots;
    historyChart.data.datasets[1].data = globalGex;
    historyChart.data.datasets[2].data = realtimeGex;

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

function smoothGexData(strikes, realtimeStrikeGex, globalStrikeGex) {
  const xs = (strikes || []).map(Number);
  return {
    realtimeStrikeGex: catmullRomInterpolate(xs, realtimeStrikeGex || []),
    globalStrikeGex: catmullRomInterpolate(xs, globalStrikeGex || [])
  };
}

function getExpiryLabel(expiry) {
  if (expiry === '0dte') return '0DTE';
  if (expiry === 'weekly') return '1DTE-5DTE';
  return 'All Expirations';
}

function updateGexChartTitle(ticker, expiry, date, time) {
  const titleEl = document.getElementById('gexChartTitle');
  if (!titleEl) return;

  const parts = [
    ticker ? ticker.toUpperCase() : '',
    // 'GEX Exposure Map',
    getExpiryLabel(expiry),
    [date, time].filter(Boolean).join(' ')
  ].filter(Boolean);

  titleEl.textContent = parts.join(' · ');
}

function findNearestRawGexIndex(xValue) {
  const raw = gexChart && gexChart.$rawGexData;
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

// ==========================================
// 5. 网页实时拉取刷新函数
// ==========================================

function pollState() {
  if (isReplaying) return; // 回放模式下挂起轮询请求，防止污染

  const ticker = tickerSelect.value;
  fetch(`/api/state?ticker=${ticker}`)
    .then(res => res.json())
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
  const gex = state.latestGex || {};
  gexChangeVal.textContent = formatGex(gex.gexChange);
  globalGexVal.textContent = formatGex(gex.globalTotalGex);
  realtimeGexVal.textContent = formatGex(gex.realtimeTotalGex);
  wallsVal.textContent = `${formatWall(gex.realtimePutWall)} / ${formatWall(gex.realtimeCallWall)}`;
  zeroGammaVal.textContent = `Zero Gamma: ${formatWall(gex.realtimeZeroGamma)}`;
  influenceCard.className = (gex.globalTotalGex || 0) >= 0 ? 'glass-panel metric-card green' : 'glass-panel metric-card rose';
  wallsCard.className = (gex.realtimeTotalGex || 0) >= 0 ? 'glass-panel metric-card cyan' : 'glass-panel metric-card rose';
  statusBadge.textContent = 'MODEL';
  statusBadge.className = 'status-badge badge-neutral';
  modelNoteContent.textContent = '实时 GEX 为基于大单流修正后的模型估算值，并非官方 OI。';
}

// ==========================================
// 6. 图表绘制与更新 (Chart.js)
// ==========================================

function initCharts() {
  const gexCtx = document.getElementById('gexChart').getContext('2d');
  const historyCtx = document.getElementById('historyChart').getContext('2d');

  gexChart = new Chart(gexCtx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: '今日 Profile',
          data: [],
          yAxisID: 'y',
          borderColor: 'rgba(255, 42, 95, 1)',
          borderWidth: 3,
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
          label: '基准 Baseline',
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
            text: '实时状态 GEX (左轴)',
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
            text: '全局地图 GEX (右轴)',
            color: 'rgba(156, 163, 175, 0.75)',
            font: { family: 'Inter', size: 10, weight: 'bold' }
          }
        }
      },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: {
            color: '#9ca3af',
            font: { family: 'Inter', size: 11 }
          }
        },
        tooltip: {
          enabled: true,
          callbacks: {
            title: function(context) {
              const nearestIdx = findNearestRawGexIndex(context[0].parsed.x);
              const raw = gexChart && gexChart.$rawGexData;
              if (nearestIdx >= 0 && raw) {
                return `Strike: $${Number(raw.strikes[nearestIdx]).toFixed(0)}`;
              }
              return `Strike: $${context[0].parsed.x.toFixed(2)}`;
            },
            label: function(context) {
              const datasetLabel = context.dataset.label || '';
              const nearestIdx = findNearestRawGexIndex(context.parsed.x);
              const raw = gexChart && gexChart.$rawGexData;
              if (nearestIdx >= 0 && raw) {
                const values = context.datasetIndex === 0 ? raw.realtimeStrikeGexMillions : raw.globalStrikeGexMillions;
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
          label: 'Spot',
          data: [],
          borderColor: '#ffcc00',
          borderWidth: 2,
          yAxisID: 'yPrice',
          tension: 0.1,
          pointRadius: 0
        },
        {
          label: 'Global GEX',
          data: [],
          borderColor: 'rgba(156, 163, 175, 0.85)',
          borderWidth: 1.5,
          borderDash: [5, 5],
          yAxisID: 'yNotional',
          tension: 0.1,
          pointRadius: 0
        },
        {
          label: 'Realtime GEX',
          data: [],
          borderColor: '#00f2fe',
          borderWidth: 2,
          yAxisID: 'yNotional',
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
        yPrice: {
          position: 'left',
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: { color: '#ffcc00', font: { family: 'Inter' } }
        },
        yNotional: {
          position: 'right',
          grid: { drawOnChartArea: false },
          ticks: { color: '#00f2fe', font: { family: 'Inter' } },
          title: {
            display: true,
            text: 'GEX ($M)',
            color: '#00f2fe',
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
  const expiry = document.getElementById('expiryFilter').value;
  
  fetch(`/api/gex?ticker=${ticker}&expiry=${expiry}`)
    .then(res => res.json())
    .then(data => {
      if (!gexChart) return;

      const smoothData = smoothGexData(
        data.strikes,
        data.realtimeStrikeGexMillions,
        data.globalStrikeGexMillions
      );
      gexChart.$rawGexData = {
        strikes: data.strikes || [],
        realtimeStrikeGexMillions: data.realtimeStrikeGexMillions || [],
        globalStrikeGexMillions: data.globalStrikeGexMillions || []
      };
      gexChart.data.labels = [];
      
      // Dataset 0: 实时状态
      gexChart.data.datasets[0].data = smoothData.realtimeStrikeGex;
      gexChart.data.datasets[0].pointBackgroundColor = smoothData.realtimeStrikeGex.map(() => 'rgba(255, 42, 95, 1)');
      gexChart.data.datasets[0].pointBorderColor = smoothData.realtimeStrikeGex.map(() => 'rgba(255, 42, 95, 0.3)');

      // Dataset 1: 全局地图
      gexChart.data.datasets[1].data = smoothData.globalStrikeGex;
      gexChart.data.datasets[1].pointBackgroundColor = smoothData.globalStrikeGex.map(() => 'rgba(156, 163, 175, 0.85)');
      gexChart.data.datasets[1].pointBorderColor = smoothData.globalStrikeGex.map(() => 'rgba(156, 163, 175, 0.25)');

      const currentSpot = parseFloat(spotVal.textContent.replace('$', ''));
      gexChart.options.plugins.verticalLines = [
        { value: currentSpot, color: 'rgba(255, 204, 0, 0.5)', lineWidth: 1, dash: [4, 4], label: 'Spot', offset: 12 },
        { value: data.realtimeCallWall, color: 'rgba(156, 163, 175, 0.45)', lineWidth: 1, label: `Call Wall (${data.realtimeCallWall || '无'})`, offset: 35 },
        { value: data.realtimePutWall, color: 'rgba(255, 42, 95, 0.45)', lineWidth: 1, label: `Put Wall (${data.realtimePutWall || '无'})`, offset: 55 },
        { value: data.realtimeZeroGamma, color: 'rgba(255, 255, 255, 0.35)', lineWidth: 1, dash: [2, 2], label: `ZeroGamma (${data.realtimeZeroGamma || '无'})`, offset: 75 }
      ];

      gexChart.update('none');
    })
    .catch(err => {
      console.error('Failed to fetch GEX data:', err);
      showErrorToast('加载 GEX 数据失败');
    });

  fetch(`/api/history?ticker=${ticker}&expiry=${expiry}`)
    .then(res => res.json())
    .then(history => {
      if (!historyChart || history.length === 0) return;
      const latestPoint = history[history.length - 1];
      updateGexChartTitle(ticker, expiry, latestPoint.date, latestPoint.time);

      const labels = history.map(h => h.time);
      const spots = history.map(h => h.spot);
      const globalGex = history.map(h => (h.globalTotalGex || 0) / 1e6);
      const realtimeGex = history.map(h => (h.realtimeTotalGex || 0) / 1e6);

      historyChart.data.labels = labels;
      historyChart.data.datasets[0].data = spots;
      historyChart.data.datasets[1].data = globalGex;
      historyChart.data.datasets[2].data = realtimeGex;

      historyChart.update('none');
    })
    .catch(err => {
      console.error('Failed to fetch history data:', err);
      showErrorToast('加载历史数据失败');
    });
}

function resetCharts() {
  if (gexChart) {
    gexChart.$rawGexData = null;
    gexChart.data.labels = [];
    gexChart.data.datasets[0].data = [];
    gexChart.data.datasets[1].data = [];
    gexChart.options.plugins.verticalLines = [];
    gexChart.update();
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
