"""
gravity_chart.py
================
KairAlert Gravity Map SVG 渲染模块。

公开接口
--------
build_scenario_svg(
    ticker,             # 股票代码，如 "AMD"
    scenario_title,     # 场景标题，如 "Magnet Traversal to $500"
    anchor_time_str,    # K 线锚定时间 (HH:MM EDT)，用于选取 120 根 K 线窗口
    key_events,         # 事件标注列表，每项: {"time":"HH:MM","label":"...","color":"#hex"}
    date_str,           # 数据日期，如 "2026-07-20"
    base_live_dir,      # live_data 根目录，下含 {ticker}/history.json
    base_1min_dir,      # tipranks_1min 根目录，下含 {ticker}.json
    logo_svg_path=None, # KairAlert Logo.svg 路径（可选）
    target_bars=120,    # K 线数量（默认 120）
) -> str               # 返回完整 SVG 字符串

render_and_save(
    ticker, scenario_title, anchor_time_str, key_events,
    date_str, base_live_dir, base_1min_dir,
    output_paths,       # List[str]，SVG 保存路径列表
    logo_svg_path=None,
    target_bars=120,
) -> str               # 保存并返回 SVG 字符串

用法示例（在其他脚本中调用）
-----------------------------
from gravity_chart import build_scenario_svg, render_and_save

svg_str = build_scenario_svg(
    ticker="AAPL",
    scenario_title="Break VWAP & Touch $325 Support Rebound",
    anchor_time_str="09:50",
    key_events=[
        {"time": "09:50", "label": "09:50 Break VWAP Down", "color": "#dc2626"},
        {"time": "10:24", "label": "10:24 Touch $325 Support", "color": "#16a34a"},
    ],
    date_str="2026-07-20",
    base_live_dir="/path/to/data/live_data/2026-07-20",
    base_1min_dir="/path/to/data/tipranks_1min/2026-07-20",
    logo_svg_path="/path/to/scripts/Logo.svg",
)

with open("my_chart.svg", "w") as f:
    f.write(svg_str)
"""

import os
import json
import math
import numpy as np
import pandas as pd
from html import escape

# ─────────────────────────────────────────────
# Layout constants (SVG canvas & panel bounds)
# ─────────────────────────────────────────────
WIDTH  = 960
HEIGHT = 570

K_TOP    = 100
K_BOTTOM = 360
K_LEFT   = 40
K_RIGHT  = 920

G_TOP    = 410
G_BOTTOM = 530
G_ZERO_Y = 505
G_LEFT   = 40
G_RIGHT  = 920


# ─────────────────────────────────────────────
# Helper utilities
# ─────────────────────────────────────────────
def fmt_strike(val, digits=1):
    """格式化行权价数字，整数不显示小数点，保留必要的小数位。
    例如: 330.0 → '330'，327.5 → '327.5'
    """
    if val is None:
        return "N/A"
    v = float(val)
    if abs(v - round(v)) < 1e-5:
        return str(int(round(v)))
    return f"{v:.{digits}f}"


def _svg_text(x, y, text, size=14, weight=400, fill="#0f172a", anchor="start"):
    return (
        f'<text x="{x:.2f}" y="{y:.2f}" '
        f'font-family="Inter, Arial, sans-serif" '
        f'font-size="{size}" font-weight="{weight}" '
        f'fill="{fill}" text-anchor="{anchor}">'
        f'{escape(str(text))}</text>'
    )


def _line_path(coords):
    if not coords:
        return ""
    return "M " + " L ".join(f"{x:.2f} {y:.2f}" for x, y in coords)


def _smooth_path(coords):
    if not coords:
        return ""
    if len(coords) == 1:
        return f"M {coords[0][0]:.2f} {coords[0][1]:.2f}"
    parts = [f"M {coords[0][0]:.2f} {coords[0][1]:.2f}"]
    for i in range(1, len(coords)):
        x0, y0 = coords[i - 1]
        x1, y1 = coords[i]
        cx = (x0 + x1) / 2
        parts.append(f"C {cx:.2f} {y0:.2f}, {cx:.2f} {y1:.2f}, {x1:.2f} {y1:.2f}")
    return " ".join(parts)


def _load_logo(logo_svg_path):
    """加载 Logo SVG 内容，去除 XML 头，返回内部 SVG 字符串。"""
    if not logo_svg_path or not os.path.exists(logo_svg_path):
        return ""
    with open(logo_svg_path, "r", encoding="utf-8") as f:
        content = f.read().strip()
    return content.replace('<?xml version="1.0" encoding="UTF-8"?>', "").strip()


def _select_gex_horizon(gex_data_dict):
    """优先级: 0dte (Today) → weekly (Weekly) → all (All)
    返回 (gex_data, horizon_label)
    """
    for key, label in [("0dte", "Today"), ("weekly", "Weekly"), ("all", "All")]:
        data = gex_data_dict.get(key, {})
        if data and len(data.get("strikes", [])) > 0:
            return data, label
    return {}, "All"


# ─────────────────────────────────────────────
# Core SVG builder
# ─────────────────────────────────────────────
def build_scenario_svg(
    ticker,
    scenario_title,
    anchor_time_str,
    key_events,
    date_str,
    base_live_dir,
    base_1min_dir,
    logo_svg_path=None,
    target_bars=120,
):
    """
    构建一张 KairAlert 场景分析 SVG 图表。

    Parameters
    ----------
    ticker          : str   - 股票代码（大写），如 "AMD"
    scenario_title  : str   - 场景描述标题
    anchor_time_str : str   - K 线窗口锚点时间 "HH:MM"（EDT）
    key_events      : list  - 事件标注，每项 dict:
                              {"time": "HH:MM", "label": "...", "color": "#hex"}
    date_str        : str   - 日期 "YYYY-MM-DD"，用于定位数据文件
    base_live_dir   : str   - live_data/{date} 目录，下含 {ticker}/history.json
    base_1min_dir   : str   - tipranks_1min/{date} 目录，下含 {ticker}.json
    logo_svg_path   : str   - KairAlert Logo.svg 的路径（可选，None 则不显示）
    target_bars     : int   - K 线数量（默认 120）

    Returns
    -------
    str  - 完整 SVG 字符串
    """
    logo_inner_svg = _load_logo(logo_svg_path)

    # ── 1. 加载 1 分钟 K 线数据 ──────────────────────────────
    min_path  = os.path.join(base_1min_dir, f"{ticker}.json")
    live_path = os.path.join(base_live_dir, ticker, "history.json")

    with open(min_path, "r") as f:
        bars_raw = json.load(f)

    df_bars = pd.DataFrame(bars_raw)
    df_bars["dt"]           = pd.to_datetime(df_bars["date"])
    df_bars["edt_dt"]       = df_bars["dt"] - pd.Timedelta(hours=4)
    df_bars["date_str"]     = df_bars["edt_dt"].dt.strftime("%Y-%m-%d")
    df_bars["edt_time_str"] = df_bars["edt_dt"].dt.strftime("%H:%M")

    # 只取当日开盘后数据
    full_day = df_bars[
        (df_bars["date_str"] == date_str) &
        (df_bars["edt_dt"].dt.hour * 60 + df_bars["edt_dt"].dt.minute >= 9 * 60 + 30) &
        (df_bars["edt_dt"].dt.hour * 60 + df_bars["edt_dt"].dt.minute <= 16 * 60)
    ].copy().sort_values("edt_dt").reset_index(drop=True)

    # 计算 VWAP / MA5 / MA15 / MA30
    full_day["tp"]   = (full_day["high"] + full_day["low"] + full_day["price"]) / 3.0
    full_day["pv"]   = full_day["tp"] * full_day["volume"]
    full_day["vwap"] = full_day["pv"].cumsum() / np.maximum(full_day["volume"].cumsum(), 1e-5)
    full_day["ma5"]  = full_day["price"].rolling(5).mean()
    full_day["ma15"] = full_day["price"].rolling(15).mean()
    full_day["ma30"] = full_day["price"].rolling(30).mean()

    # ── 2. 切取 target_bars 根 K 线窗口 ──────────────────────
    anchor_matches = full_day[full_day["edt_time_str"] == anchor_time_str]
    anchor_idx = anchor_matches.index[0] if not anchor_matches.empty else 0

    start_idx = max(0, anchor_idx - 40)
    end_idx   = start_idx + target_bars
    if end_idx > len(full_day):
        end_idx   = len(full_day)
        start_idx = max(0, end_idx - target_bars)

    mkt = full_day.iloc[start_idx:end_idx].copy().reset_index(drop=True)

    # 时间显示字符串（MM-DD HH:MM）
    start_edt_str = mkt["edt_dt"].iloc[0].strftime("%m-%d %H:%M")
    end_edt_str   = mkt["edt_dt"].iloc[-1].strftime("%m-%d %H:%M")

    # ── 3. 确定快照时刻 ──────────────────────────────────────
    event_snap_time = key_events[0]["time"] if key_events else anchor_time_str

    snap_dt_row = full_day[full_day["edt_time_str"] == event_snap_time]
    snap_date_prefix  = snap_dt_row["edt_dt"].iloc[0].strftime("%m-%d") if not snap_dt_row.empty else mkt["edt_dt"].iloc[0].strftime("%m-%d")
    event_snap_display = f"{snap_date_prefix} {event_snap_time}"

    # ── 4. 加载期权快照数据 ──────────────────────────────────
    with open(live_path, "r") as f:
        history = json.load(f)

    target_snap = next(
        (s for s in history if s.get("time", "").startswith(event_snap_time)),
        history[0] if history else {}
    )

    # ── 5. 选择 GEX Horizon ──────────────────────────────────
    raw_gex = target_snap.get("gexData", {})
    gex_data, gex_horizon_label = _select_gex_horizon(raw_gex)

    strikes      = np.array(gex_data.get("strikes", []))
    realtime_gex = np.array(gex_data.get("realtimeStrikeGexMillions", []))
    snap_spot    = float(target_snap.get("spot", mkt["price"].iloc[0]))

    snap_vwap_row = full_day[full_day["edt_time_str"] == event_snap_time]
    snap_vwap = snap_vwap_row["vwap"].iloc[0] if not snap_vwap_row.empty else mkt["vwap"].iloc[0]

    call_wall = target_snap.get("realtimeCallWall") or target_snap.get("globalCallWall")
    put_wall  = target_snap.get("realtimePutWall")  or target_snap.get("globalPutWall")

    # ── 6. 坐标映射函数 ──────────────────────────────────────
    p_min, p_max = mkt["low"].min(), mkt["high"].max()
    p_pad = max((p_max - p_min) * 0.05, float(snap_spot) * 0.002)
    y_low, y_high = p_min - p_pad, p_max + p_pad

    def y_for_price(p):
        if y_high <= y_low:
            return (K_TOP + K_BOTTOM) / 2
        return K_BOTTOM - (float(p) - y_low) / (y_high - y_low) * (K_BOTTOM - K_TOP)

    N = len(mkt)
    candle_width = max(1.4, (K_RIGHT - K_LEFT) / max(N, 1) * 0.65)
    _pad         = candle_width / 2 + 1
    _plot_left   = K_LEFT  + _pad
    _plot_right  = K_RIGHT - _pad

    def x_for_idx(i):
        if N <= 1:
            return (_plot_left + _plot_right) / 2
        return _plot_left + i / (N - 1) * (_plot_right - _plot_left)

    # GEX 坐标映射（仅展示 Spot ±7% 范围内行权价）
    mask_s   = (strikes >= snap_spot * 0.93) & (strikes <= snap_spot * 1.07)
    c_strikes = strikes[mask_s]
    c_gex     = realtime_gex[mask_s]
    max_g     = max(np.abs(c_gex)) if len(c_gex) > 0 else 1.0

    def x_for_strike(st):
        if len(c_strikes) == 0 or c_strikes[-1] <= c_strikes[0]:
            return (G_LEFT + G_RIGHT) / 2
        return G_LEFT + (st - c_strikes[0]) / (c_strikes[-1] - c_strikes[0]) * (G_RIGHT - G_LEFT)

    def y_for_gex(g):
        return G_ZERO_Y - (g / max_g) * (G_ZERO_Y - G_TOP - 20)

    # ── 7. 引力曲线路径 ──────────────────────────────────────
    g_coords = [(x_for_strike(c_strikes[i]), y_for_gex(abs(c_gex[i]))) for i in range(len(c_strikes))]
    if len(g_coords) > 2:
        g_coords[0]  = (g_coords[0][0],  G_ZERO_Y)
        g_coords[-1] = (g_coords[-1][0], G_ZERO_Y)

    area_path  = f"M {g_coords[0][0]:.2f} {G_BOTTOM:.2f} L " + _smooth_path(g_coords)[2:] + f" L {g_coords[-1][0]:.2f} {G_BOTTOM:.2f} Z"
    curve_path = _smooth_path(g_coords)

    # ════════════════════════════════════════════════════════
    # SVG 组装
    # ════════════════════════════════════════════════════════
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH}" height="{HEIGHT}" viewBox="0 0 {WIDTH} {HEIGHT}">',
        "<defs>",
        # Gravity area: top→bottom fade
        '  <linearGradient id="gravityGradientY" x1="0" y1="0" x2="0" y2="1">',
        '    <stop offset="0%"   stop-color="#3b82f6" stop-opacity="0.18"/>',
        '    <stop offset="40%"  stop-color="#3b82f6" stop-opacity="0.08"/>',
        '    <stop offset="80%"  stop-color="#3b82f6" stop-opacity="0.02"/>',
        '    <stop offset="100%" stop-color="#3b82f6" stop-opacity="0.00"/>',
        "  </linearGradient>",
        # Horizontal fade mask
        '  <linearGradient id="maskGradientX" x1="0" y1="0" x2="1" y2="0">',
        '    <stop offset="0%"    stop-color="#000000"/>',
        '    <stop offset="1.5%"  stop-color="#222222"/>',
        '    <stop offset="5%"    stop-color="#888888"/>',
        '    <stop offset="12%"   stop-color="#ffffff"/>',
        '    <stop offset="88%"   stop-color="#ffffff"/>',
        '    <stop offset="95%"   stop-color="#888888"/>',
        '    <stop offset="98.5%" stop-color="#222222"/>',
        '    <stop offset="100%"  stop-color="#000000"/>',
        "  </linearGradient>",
        '  <mask id="areaFadeMaskX">',
        '    <rect x="0" y="0" width="100%" height="100%" fill="url(#maskGradientX)"/>',
        "  </mask>",
        # Curve stroke: horizontal fade
        '  <linearGradient id="curveGradientX" x1="0" y1="0" x2="1" y2="0">',
        '    <stop offset="0%"    stop-color="#3b82f6" stop-opacity="0.00"/>',
        '    <stop offset="1.5%"  stop-color="#3b82f6" stop-opacity="0.12"/>',
        '    <stop offset="5%"    stop-color="#3b82f6" stop-opacity="0.40"/>',
        '    <stop offset="12%"   stop-color="#3b82f6" stop-opacity="0.70"/>',
        '    <stop offset="88%"   stop-color="#3b82f6" stop-opacity="0.70"/>',
        '    <stop offset="95%"   stop-color="#3b82f6" stop-opacity="0.40"/>',
        '    <stop offset="98.5%" stop-color="#3b82f6" stop-opacity="0.12"/>',
        '    <stop offset="100%"  stop-color="#3b82f6" stop-opacity="0.00"/>',
        "  </linearGradient>",
        "</defs>",
        # Background
        '<rect width="100%" height="100%" fill="#f8fafc"/>',
        f'<rect x="20" y="15" width="{WIDTH-40}" height="{HEIGHT-30}" rx="12" fill="#ffffff" stroke="#e2e8f0" stroke-width="1.5"/>',
        # Global title
        _svg_text(40, 42, f"{ticker} Intraday Scenario: {scenario_title}", 18.5, 700, "#0f172a"),
        _svg_text(40, 62, f"Time Window: {start_edt_str} - {end_edt_str} EDT ({target_bars} Candlesticks)", 12, 500, "#475569"),
    ]

    # ── Panel 1: K 线面板 ────────────────────────────────────
    kline_panel_title = f"{ticker} · {date_str[5:]} · 1-Min K-Line, VWAP & MA"
    parts += [
        _svg_text(K_LEFT, K_TOP - 10, kline_panel_title, 12, 700, "#334155"),
        f'<rect x="{K_LEFT}" y="{K_TOP}" width="{K_RIGHT-K_LEFT}" height="{K_BOTTOM-K_TOP}" rx="8" fill="#f8fafc" stroke="#e2e8f0"/>',
    ]

    # ── Y 轴网格线（先画，在 K 线下方）────────────────────────────
    y_tick_count = 5
    y_grid_parts = []   # 收集网格线，最后插到 K 线之前
    y_tick_parts = []   # 刻度标签在 K 线之后
    for ti in range(y_tick_count + 1):
        price_val = y_low + (y_high - y_low) * ti / y_tick_count
        ty = y_for_price(price_val)
        if ty < K_TOP + 4 or ty > K_BOTTOM - 4:
            continue
        # 网格线（先画）
        y_grid_parts.append(f'<line x1="{K_LEFT}" y1="{ty:.2f}" x2="{K_RIGHT}" y2="{ty:.2f}" stroke="#e2e8f0" stroke-width="0.8"/>')
        # 刻度标签（后画，颜色调深为 #64748b）
        y_tick_parts.append(_svg_text(K_RIGHT - 4, ty - 2, f"{price_val:.2f}", 9, 400, "#64748b", "end"))

    vwap_coords, ma5_coords, ma15_coords, ma30_coords = [], [], [], []
    # ── 先插入网格线 ──
    parts += y_grid_parts
    for i in range(N):
        row = mkt.iloc[i]
        cx  = x_for_idx(i)
        o_y, c_y = y_for_price(row["open"]), y_for_price(row["price"])
        h_y, l_y = y_for_price(row["high"]), y_for_price(row["low"])

        vwap_coords.append((cx, y_for_price(row["vwap"])))
        if not math.isnan(row["ma5"]):  ma5_coords.append((cx, y_for_price(row["ma5"])))
        if not math.isnan(row["ma15"]): ma15_coords.append((cx, y_for_price(row["ma15"])))
        if not math.isnan(row["ma30"]): ma30_coords.append((cx, y_for_price(row["ma30"])))

        is_up  = row["price"] >= row["open"]
        color  = "#16a34a" if is_up else "#dc2626"
        body_top = min(o_y, c_y)
        body_h   = max(abs(o_y - c_y), 1.2)
        parts.append(f'<line x1="{cx:.2f}" y1="{h_y:.2f}" x2="{cx:.2f}" y2="{l_y:.2f}" stroke="{color}" stroke-width="1.2"/>')
        parts.append(f'<rect x="{cx - candle_width/2:.2f}" y="{body_top:.2f}" width="{candle_width:.2f}" height="{body_h:.2f}" fill="{color}" rx="0.5"/>')

    # MA30 最先画（最底层），然后 MA15、MA5，VWAP 最上
    if ma30_coords:
        parts.append(f'<path d="{_line_path(ma30_coords)}" fill="none" stroke="#f59e0b" stroke-width="1.1" opacity="0.75"/>')
    if ma15_coords:
        parts.append(f'<path d="{_line_path(ma15_coords)}" fill="none" stroke="#ec4899" stroke-width="1.1" opacity="0.85"/>')
    if ma5_coords:
        parts.append(f'<path d="{_line_path(ma5_coords)}" fill="none" stroke="#6366f1" stroke-width="1.1" opacity="0.85"/>')
    parts.append(f'<path d="{_line_path(vwap_coords)}" fill="none" stroke="#d97706" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>')

    # ── 图例（左上角，紧贴面板内边缘）──────────────────────────
    legend_items = [
        ("VWAP", "#d97706", 1.6),
        ("MA5",  "#6366f1", 1.1),
        ("MA15", "#ec4899", 1.1),
        ("MA30", "#f59e0b", 1.1),
    ]
    _lx = K_LEFT + 8
    _ly = K_TOP + 14
    for label, color, lw in legend_items:
        parts += [
            f'<line x1="{_lx}" y1="{_ly - 3:.1f}" x2="{_lx + 18}" y2="{_ly - 3:.1f}" stroke="{color}" stroke-width="{lw}" stroke-linecap="round"/>',
            _svg_text(_lx + 22, _ly, label, 9, 500, color, "start"),
        ]
        _lx += 62


    # X 轴时间刻度（第一个和最后一个只显示文字，不画刻度线，避免超出圆角边框）
    step = max(1, N // 6)
    x_tick_indices = list(range(0, N, step))
    for ii, i in enumerate(x_tick_indices):
        cx    = x_for_idx(i)
        t_str = mkt["edt_time_str"].iloc[i]
        # 首尾不画竖线，只画文字
        if ii != 0 and ii != len(x_tick_indices) - 1:
            parts.append(f'<line x1="{cx:.2f}" y1="{K_BOTTOM}" x2="{cx:.2f}" y2="{K_BOTTOM-5}" stroke="#cbd5e1" stroke-width="1"/>')
        parts.append(_svg_text(cx, K_BOTTOM + 16, t_str, 10.5, 500, "#64748b", "middle"))

    # Y 轴刻度标签（在 K 线之后画，覆盖在上方）
    parts += y_tick_parts

    # ── 最高 / 最低价标注（水平虚线从蜡烛向右延伸 30px）──────────
    high_idx = int(mkt["high"].idxmax())
    low_idx  = int(mkt["low"].idxmin())
    high_val = mkt["high"].max()
    low_val  = mkt["low"].min()
    high_y   = y_for_price(high_val)
    low_y    = y_for_price(low_val)
    high_cx  = x_for_idx(high_idx)
    low_cx   = x_for_idx(low_idx)
    _hl_len  = 30   # 水平虫线长度
    _hl_lw   = 44   # 标签文字宽度

    # 最高价：今华向右延伸 30px，如到边界则向左
    if high_cx + _hl_len + _hl_lw <= K_RIGHT:
        h_x1, h_x2, h_anchor = high_cx, high_cx + _hl_len, "start"
        h_rect_x, h_text_x   = h_x2 + 1, h_x2 + 2
    else:
        h_x1, h_x2, h_anchor = high_cx, high_cx - _hl_len, "end"
        h_rect_x, h_text_x   = h_x2 - _hl_lw, h_x2 - 2
    parts += [
        f'<line x1="{h_x1:.2f}" y1="{high_y:.2f}" x2="{h_x2:.2f}" y2="{high_y:.2f}" stroke="#16a34a" stroke-width="1" stroke-dasharray="3 2" opacity="0.7"/>',
        f'<rect x="{h_rect_x:.2f}" y="{high_y - 7:.2f}" width="{_hl_lw}" height="13" rx="2" fill="#f0fdf4" opacity="0.92"/>',
        _svg_text(h_text_x, high_y + 3, f"H {high_val:.2f}", 9, 700, "#16a34a", h_anchor),
    ]
    # 最低价：同上
    if low_cx + _hl_len + _hl_lw <= K_RIGHT:
        l_x1, l_x2, l_anchor = low_cx, low_cx + _hl_len, "start"
        l_rect_x, l_text_x   = l_x2 + 1, l_x2 + 2
    else:
        l_x1, l_x2, l_anchor = low_cx, low_cx - _hl_len, "end"
        l_rect_x, l_text_x   = l_x2 - _hl_lw, l_x2 - 2
    parts += [
        f'<line x1="{l_x1:.2f}" y1="{low_y:.2f}" x2="{l_x2:.2f}" y2="{low_y:.2f}" stroke="#dc2626" stroke-width="1" stroke-dasharray="3 2" opacity="0.7"/>',
        f'<rect x="{l_rect_x:.2f}" y="{low_y - 7:.2f}" width="{_hl_lw}" height="13" rx="2" fill="#fff5f5" opacity="0.92"/>',
        _svg_text(l_text_x, low_y + 3, f"L {low_val:.2f}", 9, 700, "#dc2626", l_anchor),
    ]

    # 事件标注：圆点 + 虚线 + 文字标签（限制在面板内）
    _ev_box_w = 120

    for ev in key_events:
        match = mkt[mkt["edt_time_str"] == ev["time"]]
        if match.empty:
            continue
        idx    = match.index[0]
        cx     = x_for_idx(idx)
        row_ev = mkt.iloc[idx]
        h_y    = y_for_price(row_ev["high"])
        l_y    = y_for_price(row_ev["low"])
        ev_color = ev.get("color", "#0284c7")

        space_above = h_y - K_TOP
        space_below = K_BOTTOM - l_y
        if space_below < 60 or space_above > space_below:
            dot_y = h_y - 10
            box_y = max(K_TOP + 20, dot_y - 28)
        else:
            dot_y = l_y + 10
            box_y = min(K_BOTTOM - 20, dot_y + 28)

        box_cx     = max(K_LEFT + _ev_box_w // 2 + 2, min(K_RIGHT - _ev_box_w // 2 - 2, cx))
        box_x      = box_cx - _ev_box_w // 2
        line_y_end = box_y + 11 if dot_y < box_y else box_y - 11
        parts += [
            f'<circle cx="{cx:.2f}" cy="{dot_y:.2f}" r="3.8" fill="{ev_color}" stroke="#ffffff" stroke-width="1.5"/>',
            f'<line x1="{cx:.2f}" y1="{dot_y:.2f}" x2="{cx:.2f}" y2="{line_y_end:.2f}" stroke="{ev_color}" stroke-width="1.2" stroke-dasharray="3 3"/>',
            f'<rect x="{box_x:.2f}" y="{box_y - 11:.2f}" width="{_ev_box_w}" height="22" rx="4" fill="#ffffff" stroke="{ev_color}" stroke-width="1.2"/>',
            _svg_text(box_cx, box_y + 4, ev["label"], 10, 700, ev_color, "middle"),
        ]


    # Logo Panel 1（右上角，低调水印）
    if logo_inner_svg:
        parts.append(f'<g transform="translate({K_RIGHT - 69:.2f}, {K_TOP + 8:.2f}) scale(0.073)" opacity="0.32">{logo_inner_svg}</g>')

    # ── Panel 2: KairAlert Gravity Map ───────────────────────
    gravity_panel_title = f"KairAlert Gravity Map [{gex_horizon_label}]  ·  {event_snap_display} EDT"

    parts += [
        _svg_text(G_LEFT, G_TOP - 10, gravity_panel_title, 12, 700, "#334155"),
        f'<rect x="{G_LEFT}" y="{G_TOP}" width="{G_RIGHT-G_LEFT}" height="{G_BOTTOM-G_TOP}" rx="8" fill="#f8fafc" stroke="#e2e8f0"/>',
        f'<line x1="{G_LEFT}" y1="{G_ZERO_Y}" x2="{G_RIGHT}" y2="{G_ZERO_Y}" stroke="#e2e8f0" stroke-width="0.8"/>',
        f'<path d="{area_path}" fill="url(#gravityGradientY)" mask="url(#areaFadeMaskX)"/>',
        f'<path d="{curve_path}" fill="none" stroke="url(#curveGradientX)" stroke-width="2.0" stroke-linecap="round"/>',
    ]

    # Logo Panel 2（右上角）
    if logo_inner_svg:
        parts.append(f'<g transform="translate({G_RIGHT - 69:.2f}, {G_TOP + 8:.2f}) scale(0.073)" opacity="0.50">{logo_inner_svg}</g>')

    # Spot 竖线（橙色）
    sp_x = x_for_strike(snap_spot)
    parts += [
        f'<line x1="{sp_x:.2f}" y1="{G_TOP-4}" x2="{sp_x:.2f}" y2="{G_BOTTOM+5}" stroke="#ea580c" stroke-width="1.1" stroke-dasharray="3 3" opacity="0.75"/>',
        _svg_text(sp_x + 3, G_TOP + 10, f"Spot {snap_spot:.2f}", 10.0, 800, "#ea580c", "start"),
    ]

    # VWAP 竖线（青绿色）
    if len(c_strikes) > 0 and c_strikes[0] <= snap_vwap <= c_strikes[-1]:
        vwap_x      = x_for_strike(snap_vwap)
        vwap_anchor = "end" if vwap_x > sp_x else "start"
        vwap_lx     = vwap_x - 3 if vwap_anchor == "end" else vwap_x + 3
        parts += [
            f'<line x1="{vwap_x:.2f}" y1="{G_TOP-4}" x2="{vwap_x:.2f}" y2="{G_BOTTOM+5}" stroke="#0d9488" stroke-width="1.1" stroke-dasharray="4 3" opacity="0.75"/>',
            _svg_text(vwap_lx, G_TOP + 22, f"VWAP {snap_vwap:.2f}", 10.0, 800, "#0d9488", vwap_anchor),
        ]

    # Pin 标注（Spot ±4.2% 范围内关键行权价）
    near_mask    = (c_strikes >= snap_spot * 0.958) & (c_strikes <= snap_spot * 1.042)
    near_strikes = c_strikes[near_mask]
    near_gex     = c_gex[near_mask]

    pin_candidates = []
    for wall, color in [(put_wall, "#dc2626"), (call_wall, "#2563eb")]:
        if wall and (snap_spot * 0.958 <= wall <= snap_spot * 1.042):
            pin_candidates.append((wall, color))

    if len(near_gex) > 0:
        for p_i in np.argsort(np.abs(near_gex))[::-1]:
            st_p = near_strikes[p_i]
            if not any(abs(st_p - c[0]) < 0.001 for c in pin_candidates):
                pin_candidates.append((st_p, "#2563eb" if near_gex[p_i] >= 0 else "#dc2626"))
            if len(pin_candidates) >= 4:
                break

    pin_candidates.sort(key=lambda item: item[0])
    pin_items = []
    for st, color in pin_candidates:
        x = x_for_strike(st)
        mi = np.where(c_strikes == st)[0]
        y  = y_for_gex(abs(c_gex[mi[0]])) if len(mi) > 0 else G_ZERO_Y
        is_down = (G_BOTTOM - y) > (y - G_TOP)
        pin_items.append({"st": st, "color": color, "x": x, "y": y, "is_down": is_down})

    for i, item in enumerate(pin_items):
        x, y      = item["x"], item["y"]
        color     = item["color"]
        is_down   = item["is_down"]
        line_end_y = G_BOTTOM - 18 if is_down else G_TOP + 22
        text_y     = G_BOTTOM - 6  if is_down else G_TOP + 16

        text_anchor = "middle"
        left_near  = i > 0 and pin_items[i-1]["is_down"] == is_down and abs(x - pin_items[i-1]["x"]) < 26
        right_near = i < len(pin_items)-1 and pin_items[i+1]["is_down"] == is_down and abs(pin_items[i+1]["x"] - x) < 26
        if left_near and not right_near:    text_anchor = "start"
        elif right_near and not left_near:  text_anchor = "end"
        elif left_near and right_near:      text_anchor = "start"
        if abs(x - sp_x) < 24 and text_y < G_TOP + 30:
            text_anchor = "end" if x < sp_x else "start"

        parts += [
            f'<line x1="{x:.2f}" y1="{y:.2f}" x2="{x:.2f}" y2="{line_end_y:.2f}" stroke="{color}" stroke-width="0.9" opacity="0.35"/>',
            f'<circle cx="{x:.2f}" cy="{y:.2f}" r="3.8" fill="{color}" stroke="#ffffff" stroke-width="1.2"/>',
            _svg_text(x, text_y, fmt_strike(item["st"]), 11.0, 800, color, text_anchor),
        ]

    # 行权价 X 轴刻度
    # 行权价 X 轴刻度（首尾只显示文字，不画刻度线，避免超出圆角边框）
    total_s     = len(c_strikes)
    strike_step = max(1, math.ceil(total_s / 8))
    tick_indices = list(range(0, total_s, strike_step))
    if total_s - 1 not in tick_indices and total_s > 0:
        tick_indices.append(total_s - 1)

    for ii, i in enumerate(tick_indices):
        st = c_strikes[i]
        cx = x_for_strike(st)
        # 首尾不画竖线，只画文字
        if ii != 0 and ii != len(tick_indices) - 1:
            parts.append(f'<line x1="{cx:.2f}" y1="{G_BOTTOM}" x2="{cx:.2f}" y2="{G_BOTTOM-5}" stroke="#94a3b8" stroke-width="1"/>')
        parts.append(_svg_text(cx, G_BOTTOM + 16, fmt_strike(st, 1), 10, 600, "#475569", "middle"))

    parts.append("</svg>")
    return "\n".join(parts)


# ─────────────────────────────────────────────
# 便捷保存函数
# ─────────────────────────────────────────────
def render_and_save(
    ticker,
    scenario_title,
    anchor_time_str,
    key_events,
    date_str,
    base_live_dir,
    base_1min_dir,
    output_paths,
    logo_svg_path=None,
    target_bars=120,
):
    """
    构建 SVG 并保存到一个或多个路径。

    Parameters
    ----------
    output_paths : List[str]  - 保存路径列表（可同时写多个目录）

    Returns
    -------
    str - SVG 字符串
    """
    svg_str = build_scenario_svg(
        ticker=ticker,
        scenario_title=scenario_title,
        anchor_time_str=anchor_time_str,
        key_events=key_events,
        date_str=date_str,
        base_live_dir=base_live_dir,
        base_1min_dir=base_1min_dir,
        logo_svg_path=logo_svg_path,
        target_bars=target_bars,
    )
    for path in output_paths:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(svg_str)
        print(f"[gravity_chart] Saved → {path}")
    return svg_str


# ─────────────────────────────────────────────
# 独立运行示例（python gravity_chart.py）
# ─────────────────────────────────────────────
if __name__ == "__main__":
    # 路径配置（仅在直接运行时生效）
    DATE         = "2026-07-20"
    BASE_LIVE    = f"/home/zdying/work/options-indicator/data/live_data/{DATE}"
    BASE_1MIN    = f"/home/zdying/work/options-indicator/data/tipranks_1min/{DATE}"
    LOGO_PATH    = "/home/zdying/work/options-indicator/scripts/Logo.svg"
    OUT_DIR_DOCS = "/home/zdying/work/options-indicator/docs/best_practices/images"
    OUT_DIR_ART  = "/home/zdying/.gemini/antigravity-cli/brain/8eece4a9-04b0-4e3c-b24d-b5d2930f7318"

    SCENARIOS = [
        {
            "ticker": "AMD",
            "title":  "Gravity Ceiling Magnet Surge & Breakout Reversal",
            "anchor": "09:35",
            "events": [
                {"time": "09:35", "label": "09:35 Cross VWAP",              "color": "#d97706"},
                {"time": "09:45", "label": "09:45 Hit Gravity Ceiling $520", "color": "#dc2626"},
            ],
            "filename": "scenario_amd_0720.svg",
        },
        {
            "ticker": "AAPL",
            "title":  "VWAP Breakdown & Gravity Floor Absorption",
            "anchor": "09:40",
            "events": [
                {"time": "09:40", "label": "09:40 Break VWAP",                "color": "#dc2626"},
                {"time": "10:30", "label": "10:30 Approach Gravity Floor $325", "color": "#16a34a"},
            ],
            "filename": "scenario_aapl_0720.svg",
        },
        {
            "ticker": "SPY",
            "title":  "Gravity Lock Zone Pinning & VWAP Breakdown",
            "anchor": "09:30",
            "events": [
                {"time": "09:30", "label": "09:30 Gravity Lock $747",  "color": "#8b5cf6"},
                {"time": "10:00", "label": "10:00 Break VWAP",        "color": "#dc2626"},
            ],
            "filename": "scenario_spy_0720.svg",
        },
        {
            "ticker": "INTC",
            "title":  "Gravity Ceiling $100 Precision Cap & Reversal",
            "anchor": "09:35",
            "events": [
                {"time": "09:35", "label": "09:35 Cross VWAP",               "color": "#d97706"},
                {"time": "09:50", "label": "09:50 Hit Gravity Ceiling $100",  "color": "#dc2626"},
            ],
            "filename": "scenario_intc_0720.svg",
        },
    ]

    for s in SCENARIOS:
        render_and_save(
            ticker          = s["ticker"],
            scenario_title  = s["title"],
            anchor_time_str = s["anchor"],
            key_events      = s["events"],
            date_str        = DATE,
            base_live_dir   = BASE_LIVE,
            base_1min_dir   = BASE_1MIN,
            logo_svg_path   = LOGO_PATH,
            output_paths    = [
                os.path.join(OUT_DIR_DOCS, s["filename"]),
                os.path.join(OUT_DIR_ART,  s["filename"]),
            ],
        )

    print("\nAll scenario SVGs rendered successfully.")
