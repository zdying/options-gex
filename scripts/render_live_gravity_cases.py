#!/usr/bin/env python3

"""Render teaching charts directly from data/live_data history snapshots.

Unlike gravity_chart.py, this renderer does not require an external OHLC feed.
The upper panel is the one-minute Spot path recorded in history.json, with the
strongest nearby gravity peak overlaid. The lower panels are exact historical
Gravity Map snapshots.
"""

import html
import json
import math
import os
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
LIVE_ROOT = ROOT / "data" / "live_data"
OUTPUT_ROOT = ROOT / "docs" / "best_practices" / "images"
LOGO_PATH = ROOT / "scripts" / "Logo.svg"

WIDTH = 1000
HEIGHT = 680
PRICE_LEFT = 42
PRICE_RIGHT = 960
PRICE_TOP = 105
PRICE_BOTTOM = 390
SNAP_TOP = 480
SNAP_BOTTOM = 635
SNAP_WIDTH = 280
SNAP_GAP = 39
SNAP_LEFTS = [
    PRICE_LEFT,
    PRICE_LEFT + SNAP_WIDTH + SNAP_GAP,
    PRICE_LEFT + (SNAP_WIDTH + SNAP_GAP) * 2,
]

CASES = [
    {
        "date": "2026-07-20",
        "ticker": "META",
        "title": "单核心持续存在，也要等价格重新配合",
        "snapshots": ["09:30", "10:30", "13:30"],
        "events": [
            ("10:00", "短线低点，原上方参考先降级"),
            ("10:30", "价格止跌后重新评估650"),
            ("12:40", "价格验证650区域"),
        ],
        "filename": "case_meta_0720_live.svg",
    },
    {
        "date": "2026-07-20",
        "ticker": "MSFT",
        "title": "核心引力位上移时，不要守着开盘旧点位",
        "snapshots": ["09:45", "11:30", "12:30"],
        "events": [
            ("09:45", "价格贴近392.5"),
            ("11:30", "进入397.5/400过渡区"),
            ("12:30", "402.5形成新定锚"),
        ],
        "filename": "case_msft_0720_live.svg",
    },
    {
        "date": "2026-07-22",
        "ticker": "IWM",
        "title": "先等结构从拉扯变清晰，再使用294定锚",
        "snapshots": ["09:45", "11:00", "15:00"],
        "events": [
            ("09:45", "多峰拉扯，不急着给方向"),
            ("11:00", "价格进入294吸附带"),
            ("15:00", "294成为日内定锚"),
        ],
        "filename": "case_iwm_0722_live.svg",
    },
    {
        "date": "2026-07-16",
        "ticker": "QQQ",
        "title": "710从定锚变成上方参考后，旧结构需要降级",
        "snapshots": ["10:00", "14:30", "15:30"],
        "events": [
            ("10:00", "价格贴近710定锚"),
            ("14:30", "下破尝试，优先观察705"),
            ("15:30", "价格进入705附近"),
        ],
        "filename": "case_qqq_0716_live.svg",
    },
    {
        "date": "2026-07-22",
        "ticker": "GLD",
        "title": "结构清晰度会变化，目标到达后不能沿用旧判断",
        "snapshots": ["11:30", "13:30", "15:30"],
        "events": [
            ("11:30", "382是清晰的上方观察区"),
            ("11:52", "价格验证382"),
            ("13:30", "峰值优势消失，转为拉扯"),
        ],
        "filename": "case_gld_0722_live.svg",
    },
    {
        "date": "2026-07-22",
        "ticker": "INTC",
        "title": "同一个105，会随价格位置切换目标、支撑和压力角色",
        "snapshots": ["09:30", "12:30", "15:30"],
        "events": [
            ("09:30", "105位于现价上方"),
            ("12:30", "价格回到105定锚"),
            ("15:30", "下破后105转为上方参考"),
        ],
        "filename": "case_intc_0722_live.svg",
    },
    {
        "date": "2026-07-20",
        "ticker": "MSFT",
        "title": "$402.5 核心持续存在，价格尾盘重新收敛",
        "snapshots": ["13:00", "15:00", "15:59"],
        "events": [
            ("13:00", "402.5保持最强核心"),
            ("15:00", "价格短暂偏离，核心没有迁移"),
            ("15:59", "尾盘重新靠近402.5"),
        ],
        "filename": "case_msft_0720_tail_pin.svg",
    },
]


def esc(value):
    return html.escape(str(value), quote=True)


def text(x, y, value, size=12, weight=400, color="#334155", anchor="start"):
    return (
        f'<text x="{x:.1f}" y="{y:.1f}" font-family="MiSans, Noto Sans CJK SC, '
        f'PingFang SC, Microsoft YaHei, Inter, Arial, sans-serif" font-size="{size}" '
        f'font-weight="{weight}" fill="{color}" text-anchor="{anchor}">'
        f"{esc(value)}</text>"
    )


def line_path(points):
    if not points:
        return ""
    return "M " + " L ".join(f"{x:.2f} {y:.2f}" for x, y in points)


def smooth_path(points):
    if not points:
        return ""
    if len(points) == 1:
        return f"M {points[0][0]:.2f} {points[0][1]:.2f}"
    parts = [f"M {points[0][0]:.2f} {points[0][1]:.2f}"]
    for index in range(1, len(points)):
        x0, y0 = points[index - 1]
        x1, y1 = points[index]
        control_x = (x0 + x1) / 2
        parts.append(
            f"C {control_x:.2f} {y0:.2f}, "
            f"{control_x:.2f} {y1:.2f}, {x1:.2f} {y1:.2f}"
        )
    return " ".join(parts)


def load_logo():
    if not LOGO_PATH.exists():
        return ""
    content = LOGO_PATH.read_text(encoding="utf-8").strip()
    return content.replace('<?xml version="1.0" encoding="UTF-8"?>', "").strip()


def time_minutes(value):
    hour, minute = value.split(":")[:2]
    return int(hour) * 60 + int(minute)


def realtime_values(summary):
    values = summary.get("realtimeStrikeGexMillions")
    if values:
        return [float(value) for value in values]
    values = summary.get("strikeGexRealtime", [])
    return [float(value) / 1_000_000 for value in values]


def horizon_for(history):
    for horizon, label in (("0dte", "Today"), ("weekly", "Near"), ("all", "All")):
        if any(point.get("gexData", {}).get(horizon, {}).get("strikes") for point in history):
            return horizon, label
    return "all", "All"


def nearby_rows(point, horizon, range_pct=0.03):
    summary = point.get("gexData", {}).get(horizon, {})
    spot = float(point["spot"])
    values = realtime_values(summary)
    rows = []
    for index, strike in enumerate(summary.get("strikes", [])):
        if index >= len(values):
            continue
        strike = float(strike)
        value = float(values[index])
        distance = (strike - spot) / spot
        if math.isfinite(value) and abs(distance) <= range_pct:
            rows.append({
                "strike": strike,
                "value": value,
                "abs": abs(value),
                "distance": distance,
            })
    return sorted(rows, key=lambda row: row["strike"])


def strongest_nearby(point, horizon):
    rows = nearby_rows(point, horizon)
    return max(rows, key=lambda row: row["abs"]) if rows else None


def find_snapshot(history, time_value):
    exact = next((point for point in history if point.get("time") == time_value), None)
    if exact:
        return exact
    target = time_minutes(time_value)
    return min(history, key=lambda point: abs(time_minutes(point["time"]) - target))


def price_scale(history, core_rows):
    values = [float(point["spot"]) for point in history]
    values.extend(row["strike"] for row in core_rows if row)
    low = min(values)
    high = max(values)
    padding = max((high - low) * 0.08, abs(high) * 0.001)
    return low - padding, high + padding


def render_price_panel(parts, case, history, horizon):
    core_rows = [strongest_nearby(point, horizon) for point in history]
    low, high = price_scale(history, core_rows)
    start_minute = time_minutes(history[0]["time"])
    end_minute = time_minutes(history[-1]["time"])

    def x_for_time(value):
        minute = time_minutes(value)
        return PRICE_LEFT + (minute - start_minute) / (end_minute - start_minute) * (
            PRICE_RIGHT - PRICE_LEFT
        )

    def y_for_price(value):
        return PRICE_BOTTOM - (float(value) - low) / (high - low) * (
            PRICE_BOTTOM - PRICE_TOP
        )

    parts.extend([
        text(
            PRICE_LEFT,
            91,
            f'{case["ticker"]} · {case["date"]} · 全天价格走势与附近最强引力核心',
            12,
            700,
        ),
        f'<rect x="{PRICE_LEFT}" y="{PRICE_TOP}" width="{PRICE_RIGHT-PRICE_LEFT}" '
        f'height="{PRICE_BOTTOM-PRICE_TOP}" rx="8" fill="#f8fafc" stroke="#e2e8f0"/>',
    ])

    for index in range(6):
        price = low + (high - low) * index / 5
        y = y_for_price(price)
        parts.append(
            f'<line x1="{PRICE_LEFT}" y1="{y:.2f}" x2="{PRICE_RIGHT}" y2="{y:.2f}" '
            'stroke="#e2e8f0" stroke-width="0.8"/>'
        )
        parts.append(text(PRICE_RIGHT - 5, y - 4, f"{price:.2f}", 9, 400, "#64748b", "end"))

    for value in ("09:30", "10:30", "11:30", "12:30", "13:30", "14:30", "15:30"):
        x = x_for_time(value)
        parts.append(
            f'<line x1="{x:.2f}" y1="{PRICE_TOP}" x2="{x:.2f}" y2="{PRICE_BOTTOM}" '
            'stroke="#e2e8f0" stroke-width="0.7"/>'
        )
        parts.append(text(x, PRICE_BOTTOM + 18, value, 9, 400, "#64748b", "middle"))

    price_points = [
        (x_for_time(point["time"]), y_for_price(point["spot"]))
        for point in history
    ]
    core_points = [
        (x_for_time(point["time"]), y_for_price(core["strike"]))
        for point, core in zip(history, core_rows)
        if core
    ]
    parts.extend([
        f'<path d="{line_path(core_points)}" fill="none" stroke="#38bdf8" '
        'stroke-width="1.6" stroke-dasharray="5 4" opacity="0.82"/>',
        f'<path d="{line_path(price_points)}" fill="none" stroke="#0f172a" '
        'stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>',
    ])

    label_rows = [("Spot", "#0f172a", None), ("附近最强引力峰", "#38bdf8", "5 4")]
    legend_x = PRICE_LEFT + 12
    for index, (label, color, dash) in enumerate(label_rows):
        y = PRICE_TOP + 18 + index * 18
        dash_attr = f' stroke-dasharray="{dash}"' if dash else ""
        parts.append(
            f'<line x1="{legend_x}" y1="{y-4}" x2="{legend_x+24}" y2="{y-4}" '
            f'stroke="{color}" stroke-width="2"{dash_attr}/>'
        )
        parts.append(text(legend_x + 31, y, label, 10, 500, "#475569"))

    event_colors = ["#dc2626", "#7c3aed", "#16a34a"]
    for index, (event_time, label) in enumerate(case["events"]):
        point = find_snapshot(history, event_time)
        x = x_for_time(point["time"])
        y = y_for_price(point["spot"])
        color = event_colors[index % len(event_colors)]
        label_text = f"{event_time}  {label}"
        box_width = max(154, min(218, len(label_text) * 10 + 22))
        box_center = max(
            PRICE_LEFT + box_width / 2 + 8,
            min(PRICE_RIGHT - box_width / 2 - 8, x),
        )
        boundary_offset = 16 if abs(box_center - x) > 40 else 0
        label_y = min(PRICE_BOTTOM - 28, y + 38 + boundary_offset)
        parts.extend([
            f'<line x1="{x:.2f}" y1="{PRICE_TOP}" x2="{x:.2f}" y2="{PRICE_BOTTOM}" '
            f'stroke="{color}" stroke-width="1" stroke-dasharray="3 4" opacity="0.65"/>',
            f'<circle cx="{x:.2f}" cy="{y:.2f}" r="4" fill="#ffffff" '
            f'stroke="{color}" stroke-width="2"/>',
            text(box_center, label_y, label_text, 10, 700, color, "middle"),
        ])


def render_snapshot_panel(parts, left, point, horizon, horizon_label, index):
    top = SNAP_TOP
    bottom = SNAP_BOTTOM
    right = left + SNAP_WIDTH
    rows = nearby_rows(point, horizon)
    if not rows:
        parts.append(text(left, top + 20, "无可用快照", 12, 600))
        return

    spot = float(point["spot"])
    x_low = rows[0]["strike"]
    x_high = rows[-1]["strike"]
    max_value = max(row["abs"] for row in rows) or 1

    def x_for_strike(value):
        if x_high == x_low:
            return (left + right) / 2
        return left + (value - x_low) / (x_high - x_low) * SNAP_WIDTH

    def y_for_value(value):
        usable = bottom - top - 62
        return bottom - 27 - abs(value) / max_value * usable

    parts.extend([
        text(left, top - 22, f'{point["time"]} EDT · {horizon_label}', 11, 700),
        text(right, top - 22, f'Spot {spot:.2f}', 10, 500, "#f97316", "end"),
        f'<rect x="{left}" y="{top}" width="{SNAP_WIDTH}" height="{bottom-top}" '
        'rx="8" fill="#f8fafc" stroke="#e2e8f0"/>',
        f'<line x1="{left}" y1="{bottom-27}" x2="{right}" y2="{bottom-27}" '
        'stroke="#cbd5e1" stroke-width="0.8"/>',
    ])

    points = [(x_for_strike(row["strike"]), y_for_value(row["value"])) for row in rows]
    curve_points = list(points)
    if len(curve_points) > 2:
        curve_points[0] = (curve_points[0][0], bottom - 27)
        curve_points[-1] = (curve_points[-1][0], bottom - 27)
    area = (
        f"M {curve_points[0][0]:.2f} {bottom-27:.2f} L "
        + smooth_path(curve_points)[2:]
        + f" L {curve_points[-1][0]:.2f} {bottom-27:.2f} Z"
    )
    parts.extend([
        f'<path d="{area}" fill="url(#gravityGradientY)" mask="url(#areaFadeMaskX)"/>',
        f'<path d="{smooth_path(curve_points)}" fill="none" '
        'stroke="url(#curveGradientX)" stroke-width="2" stroke-linecap="round"/>',
    ])

    spot_x = x_for_strike(max(x_low, min(x_high, spot)))
    parts.extend([
        f'<line x1="{spot_x:.2f}" y1="{top+12}" x2="{spot_x:.2f}" y2="{bottom-27}" '
        'stroke="#f97316" stroke-width="1.5" stroke-dasharray="4 3"/>',
        text(spot_x - 4, top + 20, "Spot", 9, 700, "#f97316", "end"),
    ])

    strongest = sorted(rows, key=lambda row: row["abs"], reverse=True)[:3]
    for rank, row in enumerate(strongest):
        x = x_for_strike(row["strike"])
        y = y_for_value(row["value"])
        color = "#1d4ed8" if rank == 0 else "#64748b"
        radius = 3.6 if rank == 0 else 2.7
        parts.append(
            f'<circle cx="{x:.2f}" cy="{y:.2f}" r="{radius}" fill="{color}" '
            'stroke="#ffffff" stroke-width="1.2"/>'
        )
        label_y = y - 9 if rank == 0 else (y + 18 if y < top + 45 else y - 9)
        parts.append(text(x, label_y, f'{row["strike"]:g}', 9, 700, color, "middle"))

    tick_indexes = sorted(set([0, len(rows) // 2, len(rows) - 1]))
    for tick_index in tick_indexes:
        row = rows[tick_index]
        x = x_for_strike(row["strike"])
        parts.append(text(x, bottom - 4, f'{row["strike"]:g}', 9, 400, "#64748b", "middle"))

def render_case(case):
    history_path = LIVE_ROOT / case["date"] / case["ticker"] / "history.json"
    with history_path.open("r", encoding="utf-8") as file:
        history = json.load(file)
    history = [
        point for point in history
        if "09:30" <= point.get("time", "") <= "15:59"
    ]
    horizon, horizon_label = horizon_for(history)
    logo_inner_svg = load_logo()

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH}" height="{HEIGHT}" '
        f'viewBox="0 0 {WIDTH} {HEIGHT}">',
        f"<title>{esc(case['ticker'])} Gravity Map teaching case</title>",
        f"<desc>{esc(case['title'])}</desc>",
        "<defs>",
        '  <linearGradient id="gravityGradientY" x1="0" y1="0" x2="0" y2="1">',
        '    <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.18"/>',
        '    <stop offset="40%" stop-color="#3b82f6" stop-opacity="0.08"/>',
        '    <stop offset="80%" stop-color="#3b82f6" stop-opacity="0.02"/>',
        '    <stop offset="100%" stop-color="#3b82f6" stop-opacity="0.00"/>',
        "  </linearGradient>",
        '  <linearGradient id="maskGradientX" x1="0" y1="0" x2="1" y2="0">',
        '    <stop offset="0%" stop-color="#000000"/>',
        '    <stop offset="1.5%" stop-color="#222222"/>',
        '    <stop offset="5%" stop-color="#888888"/>',
        '    <stop offset="12%" stop-color="#ffffff"/>',
        '    <stop offset="88%" stop-color="#ffffff"/>',
        '    <stop offset="95%" stop-color="#888888"/>',
        '    <stop offset="98.5%" stop-color="#222222"/>',
        '    <stop offset="100%" stop-color="#000000"/>',
        "  </linearGradient>",
        '  <mask id="areaFadeMaskX">',
        '    <rect x="0" y="0" width="100%" height="100%" fill="url(#maskGradientX)"/>',
        "  </mask>",
        '  <linearGradient id="curveGradientX" x1="0" y1="0" x2="1" y2="0">',
        '    <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.00"/>',
        '    <stop offset="1.5%" stop-color="#3b82f6" stop-opacity="0.12"/>',
        '    <stop offset="5%" stop-color="#3b82f6" stop-opacity="0.40"/>',
        '    <stop offset="12%" stop-color="#3b82f6" stop-opacity="0.70"/>',
        '    <stop offset="88%" stop-color="#3b82f6" stop-opacity="0.70"/>',
        '    <stop offset="95%" stop-color="#3b82f6" stop-opacity="0.40"/>',
        '    <stop offset="98.5%" stop-color="#3b82f6" stop-opacity="0.12"/>',
        '    <stop offset="100%" stop-color="#3b82f6" stop-opacity="0.00"/>',
        "  </linearGradient>",
        "</defs>",
        '<rect width="100%" height="100%" fill="#f8fafc"/>',
        f'<rect x="20" y="15" width="{WIDTH-40}" height="{HEIGHT-30}" rx="13" '
        'fill="#ffffff" stroke="#e2e8f0" stroke-width="1.5"/>',
        text(42, 44, f'{case["ticker"]}：{case["title"]}', 18, 700, "#0f172a"),
        text(
            42,
            67,
            f'全天走势与 {"、".join(case["snapshots"])} 引力结构对照 · 美东时间（EDT）',
            11,
            500,
            "#64748b",
        ),
    ]

    render_price_panel(parts, case, history, horizon)
    if logo_inner_svg:
        parts.append(
            f'<g transform="translate({PRICE_RIGHT - 51:.2f}, '
            f'{PRICE_BOTTOM - 30:.2f}) scale(0.062)" '
            f'opacity="0.42">{logo_inner_svg}</g>'
        )
    parts.append(text(PRICE_LEFT, 440, "关键时刻的引力图快照", 12, 700, "#334155"))
    for index, (left, snapshot_time) in enumerate(zip(SNAP_LEFTS, case["snapshots"])):
        point = find_snapshot(history, snapshot_time)
        render_snapshot_panel(parts, left, point, horizon, horizon_label, index)

    if logo_inner_svg:
        third_panel_right = SNAP_LEFTS[2] + SNAP_WIDTH
        parts.append(
            f'<g transform="translate({third_panel_right - 51:.2f}, '
            f'{SNAP_TOP + 8:.2f}) scale(0.062)" '
            f'opacity="0.54">{logo_inner_svg}</g>'
        )
    parts.append("</svg>")
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    output_path = OUTPUT_ROOT / case["filename"]
    output_path.write_text("\n".join(parts), encoding="utf-8")
    return output_path


def main():
    for case in CASES:
        output = render_case(case)
        print(output.relative_to(ROOT))


if __name__ == "__main__":
    main()
