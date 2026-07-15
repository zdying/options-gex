#!/usr/bin/env python3
"""
Render weekly gravity summary charts from report.json.

The charts are SVG files so the script does not require third-party packages.
"""

import json
import math
import os
import re
import sys
from html import escape


WIDTH = 960
HEIGHT = 540
MARGIN = 48
CONTENT_LEFT = 48
CONTENT_RIGHT = 912
PLOT_LEFT = CONTENT_LEFT
PLOT_RIGHT = CONTENT_RIGHT
PLOT_TOP = 228
PLOT_BOTTOM = 360
ZERO_Y = 322
BAR_LEFT = CONTENT_LEFT
BAR_TOP = 122
BAR_WIDTH = CONTENT_RIGHT - CONTENT_LEFT
BAR_HEIGHT = 34
ZONE_LIMIT = 10
LABEL_LIMIT = 6
SPOT_COLOR = "#ea580c"
UP_MARK_COLOR = "#3b82f6"
DOWN_MARK_COLOR = "#ef4444"
SCORE_COLORS = [
    "#16a34a",
    "#20b653",
    "#2fc45f",
    "#57cf64",
    "#8ccf5b",
    "#c9c84a",
    "#f0b63f",
    "#f28b32",
    "#ef5a3c",
    "#dc2626",
]
SCORE_INACTIVE_COLOR = "#e5e7eb"
LOGO_PATH = os.path.join(os.path.dirname(__file__), "Logo.svg")
LOGO_WIDTH = 78
LOGO_HEIGHT = 38
LOGO_OPACITY = 0.34
LOGO_INNER_SVG = None


def fmt(value, digits=2):
    if value is None:
        return "N/A"
    try:
        num = float(value)
    except (TypeError, ValueError):
        return "N/A"
    if not math.isfinite(num):
        return "N/A"
    text = f"{num:.{digits}f}"
    return text.rstrip("0").rstrip(".")


def slug(value):
    return re.sub(r"[^A-Za-z0-9._-]+", "_", str(value).strip()) or "ticker"


def format_structure_label(value):
    words = re.split(r"[-_\s]+", str(value or "").strip())
    return " ".join(word.capitalize() for word in words if word)


def format_gravity_value(value):
    if value is None:
        return "N/A"
    try:
        num = abs(float(value))
    except (TypeError, ValueError):
        return "N/A"
    if not math.isfinite(num):
        return "N/A"
    return fmt(num / 1_000_000, 1)


def weighted_color(distance_pct):
    if distance_pct is None:
        return "#64748b"
    return UP_MARK_COLOR if distance_pct >= 0 else DOWN_MARK_COLOR


def clamp(value, low, high):
    return max(low, min(high, value))


def score_level(score):
    try:
        value = float(score)
    except (TypeError, ValueError):
        value = 0
    if not math.isfinite(value):
        value = 0
    return int(clamp(math.ceil(((value + 1) / 2) * 10), 1, 10))


def score_label(score):
    try:
        value = float(score)
    except (TypeError, ValueError):
        value = 0
    if value <= -0.35:
        return "Very Weak"
    if value <= -0.12:
        return "Weak"
    if value < 0.12:
        return "Balanced"
    if value < 0.35:
        return "Strong"
    return "Very Strong"


def polar_point(cx, cy, radius, angle_deg):
    angle = math.radians(angle_deg)
    return cx + radius * math.cos(angle), cy + radius * math.sin(angle)


def ring_segment_path(cx, cy, outer_r, inner_r, start_angle, end_angle, corner_radius=2.4):
    outer_inset = math.degrees(corner_radius / outer_r)
    inner_inset = math.degrees(corner_radius / inner_r)
    outer_start_angle = start_angle + outer_inset
    outer_end_angle = end_angle - outer_inset
    inner_start_angle = start_angle + inner_inset
    inner_end_angle = end_angle - inner_inset

    if outer_end_angle <= outer_start_angle or inner_end_angle <= inner_start_angle:
        outer_start_angle = inner_start_angle = start_angle
        outer_end_angle = inner_end_angle = end_angle

    outer_start = polar_point(cx, cy, outer_r, outer_start_angle)
    outer_end = polar_point(cx, cy, outer_r, outer_end_angle)
    inner_end = polar_point(cx, cy, inner_r, inner_end_angle)
    inner_start = polar_point(cx, cy, inner_r, inner_start_angle)

    end_outer_corner = polar_point(cx, cy, outer_r, end_angle)
    end_inner_corner = polar_point(cx, cy, inner_r, end_angle)
    start_inner_corner = polar_point(cx, cy, inner_r, start_angle)
    start_outer_corner = polar_point(cx, cy, outer_r, start_angle)

    end_radial_outer = polar_point(cx, cy, outer_r - corner_radius, end_angle)
    end_radial_inner = polar_point(cx, cy, inner_r + corner_radius, end_angle)
    start_radial_inner = polar_point(cx, cy, inner_r + corner_radius, start_angle)
    start_radial_outer = polar_point(cx, cy, outer_r - corner_radius, start_angle)

    large_arc = 1 if outer_end_angle - outer_start_angle > 180 else 0

    return (
        f"M {outer_start[0]:.2f} {outer_start[1]:.2f} "
        f"A {outer_r:.2f} {outer_r:.2f} 0 {large_arc} 1 {outer_end[0]:.2f} {outer_end[1]:.2f} "
        f"Q {end_outer_corner[0]:.2f} {end_outer_corner[1]:.2f} {end_radial_outer[0]:.2f} {end_radial_outer[1]:.2f} "
        f"L {end_radial_inner[0]:.2f} {end_radial_inner[1]:.2f} "
        f"Q {end_inner_corner[0]:.2f} {end_inner_corner[1]:.2f} {inner_end[0]:.2f} {inner_end[1]:.2f} "
        f"A {inner_r:.2f} {inner_r:.2f} 0 {large_arc} 0 {inner_start[0]:.2f} {inner_start[1]:.2f} "
        f"Q {start_inner_corner[0]:.2f} {start_inner_corner[1]:.2f} {start_radial_inner[0]:.2f} {start_radial_inner[1]:.2f} "
        f"L {start_radial_outer[0]:.2f} {start_radial_outer[1]:.2f} "
        f"Q {start_outer_corner[0]:.2f} {start_outer_corner[1]:.2f} {outer_start[0]:.2f} {outer_start[1]:.2f} Z"
    )


def render_score_badge(score):
    level = score_level(score)
    parts = []
    cx = 872
    cy = 69
    outer_r = 34
    inner_r = 24
    gap = 1.1
    segment = (360 - gap * 10) / 10
    start = -90

    for idx in range(10):
        segment_start = start + idx * (segment + gap) + gap / 2
        segment_end = segment_start + segment
        color = SCORE_COLORS[idx] if idx < level else SCORE_INACTIVE_COLOR
        parts.append(
            f'<path d="{ring_segment_path(cx, cy, outer_r, inner_r, segment_start, segment_end)}" fill="{color}"/>'
        )

    active_color = SCORE_COLORS[level - 1]
    parts.extend([
        svg_text(cx, cy + 8, str(level), 22, 850, active_color, "middle"),
        svg_text(820, 60, f"{level}/10", 22, 850, "#334155", "end"),
        svg_text(820, 88, score_label(score), 20, 850, "#0f172a", "end"),
    ])
    return parts


def collect_zones(window):
    zones = []
    seen = set()
    for key in ("strongestWeightedGravityZones", "nearGravityZones", "upperGravityZones", "lowerGravityZones"):
        for zone in window.get(key, []) or []:
            strike = zone.get("strike")
            if strike is None or strike in seen:
                continue
            seen.add(strike)
            zones.append(zone)
    return zones


def scale_for_zones(spot, zones):
    strikes = [float(z["strike"]) for z in zones if z.get("strike") is not None]
    if not strikes:
      strikes = [spot * 0.95, spot, spot * 1.05]
    strikes.append(spot)
    low = min(strikes)
    high = max(strikes)
    pad = max((high - low) * 0.12, spot * 0.015)
    return low - pad, high + pad


def scale_for_curve(spot, curve, zones):
    strikes = [float(z["strike"]) for z in curve if z.get("strike") is not None]
    if not strikes:
        strikes = [float(z["strike"]) for z in zones if z.get("strike") is not None]
    if not strikes:
        strikes = [spot * 0.95, spot, spot * 1.05]
    strikes.append(spot)
    low = min(strikes)
    high = max(strikes)
    pad = max((high - low) * 0.04, spot * 0.01)
    return low - pad, high + pad


def x_for_price(price, low, high):
    if high <= low:
        return (PLOT_LEFT + PLOT_RIGHT) / 2
    return PLOT_LEFT + (float(price) - low) / (high - low) * (PLOT_RIGHT - PLOT_LEFT)


def y_for_weighted(value, max_value):
    if max_value <= 0:
        return PLOT_BOTTOM
    ratio = max(0, float(value)) / max_value
    return PLOT_BOTTOM - ratio * (PLOT_BOTTOM - PLOT_TOP)


def y_for_net(value, max_abs):
    if max_abs <= 0:
        return ZERO_Y
    ratio = max(-1, min(1, float(value) / max_abs))
    return ZERO_Y - ratio * 42


def svg_text(x, y, text, size=16, weight=400, fill="#0f172a", anchor="start"):
    return (
        f'<text x="{x}" y="{y}" font-family="Inter, Arial, sans-serif" '
        f'font-size="{size}" font-weight="{weight}" fill="{fill}" '
        f'text-anchor="{anchor}">{escape(str(text))}</text>'
    )


def load_logo_inner_svg():
    global LOGO_INNER_SVG
    if LOGO_INNER_SVG is not None:
        return LOGO_INNER_SVG
    if not os.path.exists(LOGO_PATH):
        LOGO_INNER_SVG = ""
        return LOGO_INNER_SVG
    with open(LOGO_PATH, "r", encoding="utf-8") as f:
        svg = f.read().strip()
    svg = re.sub(r"^<svg\b[^>]*>", "", svg, count=1).strip()
    svg = re.sub(r"</svg>\s*$", "", svg, count=1).strip()
    LOGO_INNER_SVG = svg
    return LOGO_INNER_SVG


def render_logo_watermark():
    logo = load_logo_inner_svg()
    if not logo:
        return ""
    x = PLOT_RIGHT - LOGO_WIDTH - 8
    y = PLOT_TOP + 6
    return (
        f'<svg x="{x}" y="{y}" width="{LOGO_WIDTH}" height="{LOGO_HEIGHT}" '
        f'viewBox="0 0 819 401" opacity="{LOGO_OPACITY}">{logo}</svg>'
    )


def render_chart(ticker, ticker_data, report):
    window = ticker_data["windows"]["nextWeek"]
    spot = float(ticker_data["spot"])
    zones = collect_zones(window)
    curve = zones
    low, high = scale_for_zones(spot, zones)
    curve_points = [z for z in curve if z.get("strike") is not None]
    display_curve_points = filter_points_to_domain(curve_points, low, high)
    max_weighted = max([float(z.get("weightedGravity") or 0) for z in display_curve_points] or [0])
    max_net_abs = max([abs(float(z.get("netGravity") or 0)) for z in display_curve_points] or [0])

    upper_pct = float(window.get("upperWeightedGravityPct") or 0)
    lower_pct = float(window.get("lowerWeightedGravityPct") or 0)
    upper_width = BAR_WIDTH * upper_pct / 100.0
    lower_width = BAR_WIDTH - upper_width
    pull_skew = float(window.get("pullSkew") or 0)
    raw_skew = float(window.get("rawPullSkew") or 0)

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH}" height="{HEIGHT}" viewBox="0 0 {WIDTH} {HEIGHT}">',
        '<rect width="100%" height="100%" fill="#f8fafc"/>',
        f'<rect x="24" y="24" width="{WIDTH - 48}" height="{HEIGHT - 48}" rx="12" fill="#ffffff" stroke="#e2e8f0"/>',
        svg_text(48, 62, f"{ticker} Weekly Gravity Structure", 24, 700),
        svg_text(48, 80, f"Base date {report.get('baseDate')} · Spot {fmt(spot)} · {format_structure_label(window.get('structure'))}", 14, 500, "#475569"),
    ]
    parts.extend(render_score_badge(window.get("score")))

    # Weighted pull bar.
    parts.extend([
        svg_text(CONTENT_LEFT, BAR_TOP - 8, "Weighted pull distribution", 14, 700, "#334155"),
        f'<rect x="{BAR_LEFT}" y="{BAR_TOP}" width="{BAR_WIDTH}" height="{BAR_HEIGHT}" rx="8" fill="#e2e8f0"/>',
        f'<rect x="{BAR_LEFT}" y="{BAR_TOP}" width="{lower_width}" height="{BAR_HEIGHT}" rx="8" fill="#dc2626" opacity="0.82"/>',
        f'<rect x="{BAR_LEFT + lower_width}" y="{BAR_TOP}" width="{upper_width}" height="{BAR_HEIGHT}" rx="8" fill="#2563eb" opacity="0.82"/>',
        svg_text(BAR_LEFT + 12, BAR_TOP + 23, f"Down {fmt(lower_pct)}%", 14, 700, "#ffffff"),
        svg_text(BAR_LEFT + BAR_WIDTH - 12, BAR_TOP + 23, f"Up {fmt(upper_pct)}%", 14, 700, "#ffffff", "end"),
        svg_text(CONTENT_LEFT, BAR_TOP + 50, f"Weighted skew {fmt(pull_skew)} · Raw skew {fmt(raw_skew)}", 13, 500, "#64748b"),
    ])

    # Price axis and smooth gravity curves.
    weighted_path = build_weighted_area_path(curve_points, low, high, max_weighted)
    weighted_line = build_weighted_line_path(curve_points, low, high, max_weighted)
    net_line = build_net_line_path(curve_points, low, high, max_net_abs)
    spot_x = x_for_price(spot, low, high)
    spot_label_x = min(spot_x + 8, PLOT_RIGHT - 8)
    spot_label_anchor = "end" if spot_label_x >= PLOT_RIGHT - 8 else "start"

    parts.extend([
        svg_text(CONTENT_LEFT, 204, "Weighted gravity curve", 14, 700, "#334155"),
        svg_text(CONTENT_RIGHT, 204, "Filled Curve = Effective Pull · Thin Line = Signed Structure", 12, 500, "#64748b", "end"),
        f'<rect x="{PLOT_LEFT}" y="{PLOT_TOP}" width="{PLOT_RIGHT - PLOT_LEFT}" height="{PLOT_BOTTOM - PLOT_TOP}" rx="8" fill="#f8fafc" stroke="#e2e8f0"/>',
        f'<line x1="{PLOT_LEFT}" y1="{ZERO_Y}" x2="{PLOT_RIGHT}" y2="{ZERO_Y}" stroke="#cbd5e1" stroke-width="1.5"/>',
        f'<path d="{weighted_path}" fill="#60a5fa" opacity="0.24"/>',
        f'<path d="{weighted_line}" fill="none" stroke="#2563eb" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>',
        f'<path d="{net_line}" fill="none" stroke="#475569" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" opacity="0.72"/>',
        render_logo_watermark(),
        f'<line x1="{spot_x}" y1="{PLOT_TOP - 4}" x2="{spot_x}" y2="{PLOT_BOTTOM + 24}" stroke="{SPOT_COLOR}" stroke-width="2.2" stroke-dasharray="5 5"/>',
        svg_text(spot_label_x, PLOT_TOP + 16, f"Spot {fmt(spot)}", 13, 800, SPOT_COLOR, spot_label_anchor),
        svg_text(PLOT_LEFT, PLOT_BOTTOM + 22, fmt(low), 12, 500, "#64748b", "start"),
        svg_text(PLOT_RIGHT, PLOT_BOTTOM + 22, fmt(high), 12, 500, "#64748b", "end"),
    ])

    for idx, zone in enumerate((window.get("strongestWeightedGravityZones") or [])[:LABEL_LIMIT]):
        strike = float(zone["strike"])
        distance = float(zone.get("distancePct") or 0)
        x = x_for_price(strike, low, high)
        y = y_for_weighted(float(zone.get("weightedGravity") or 0), max_weighted)
        color = weighted_color(distance)
        label_y = PLOT_TOP - 8 if idx % 2 == 0 else PLOT_BOTTOM + 18
        parts.extend([
            f'<line x1="{x}" y1="{y}" x2="{x}" y2="{label_y + (4 if idx % 2 == 0 else -14)}" stroke="{color}" stroke-width="0.9" opacity="0.5"/>',
            f'<circle cx="{x}" cy="{y}" r="3.9" fill="{color}" opacity="0.9" stroke="#ffffff" stroke-width="1.2"/>',
            svg_text(x, label_y, fmt(strike), 11, 600, color, "middle"),
        ])

    # Zone tables.
    parts.extend([
        svg_text(CONTENT_LEFT, 420, "Upper zones", 14, 700, "#2563eb"),
        svg_text(352, 420, "Lower zones", 14, 700, "#dc2626"),
        svg_text(656, 420, "Near spot", 14, 700, "#334155"),
    ])

    draw_zone_list(parts, CONTENT_LEFT, 444, window.get("upperGravityZones", [])[:3], "#2563eb")
    draw_zone_list(parts, 352, 444, window.get("lowerGravityZones", [])[:3], "#dc2626")
    draw_zone_list(parts, 656, 444, window.get("nearGravityZones", [])[:3], "#334155")

    parts.append("</svg>")
    return "\n".join(parts)


def build_weighted_area_path(points, low, high, max_weighted):
    if not points:
        return ""
    sorted_points = filter_points_to_domain(points, low, high)
    coords = [(x_for_price(z["strike"], low, high), y_for_weighted(z.get("weightedGravity") or 0, max_weighted)) for z in sorted_points]
    edge_baseline = max([y for _, y in coords] or [PLOT_BOTTOM])
    coords = extend_coords_to_edges(coords, baseline=edge_baseline)
    line = smooth_path(coords)
    return f"M {coords[0][0]:.2f} {PLOT_BOTTOM:.2f} L {line[2:]} L {coords[-1][0]:.2f} {PLOT_BOTTOM:.2f} Z"


def build_weighted_line_path(points, low, high, max_weighted):
    if not points:
        return ""
    sorted_points = filter_points_to_domain(points, low, high)
    coords = [(x_for_price(z["strike"], low, high), y_for_weighted(z.get("weightedGravity") or 0, max_weighted)) for z in sorted_points]
    edge_baseline = max([y for _, y in coords] or [PLOT_BOTTOM])
    coords = extend_coords_to_edges(coords, baseline=edge_baseline)
    return smooth_path(coords)


def build_net_line_path(points, low, high, max_net_abs):
    if not points:
        return ""
    sorted_points = filter_points_to_domain(points, low, high)
    coords = [(x_for_price(z["strike"], low, high), y_for_net(z.get("netGravity") or 0, max_net_abs)) for z in sorted_points]
    coords = extend_coords_to_edges(coords, baseline=ZERO_Y)
    return smooth_path(coords)


def filter_points_to_domain(points, low, high):
    filtered = [
        z for z in points
        if z.get("strike") is not None and low <= float(z["strike"]) <= high
    ]
    if len(filtered) < 2:
        filtered = [z for z in points if z.get("strike") is not None]
    return sorted(filtered, key=lambda z: float(z["strike"]))


def extend_coords_to_edges(coords, baseline=None):
    if not coords:
        return coords
    extended = list(coords)
    left_y = baseline if baseline is not None else extended[0][1]
    right_y = baseline if baseline is not None else extended[-1][1]
    if extended[0][0] > PLOT_LEFT:
        extended.insert(0, (PLOT_LEFT, left_y))
    if extended[-1][0] < PLOT_RIGHT:
        extended.append((PLOT_RIGHT, right_y))
    return extended


def smooth_path(coords):
    if not coords:
        return ""
    if len(coords) == 1:
        return f"M {coords[0][0]:.2f} {coords[0][1]:.2f}"
    parts = [f"M {coords[0][0]:.2f} {coords[0][1]:.2f}"]
    for idx in range(1, len(coords)):
        x0, y0 = coords[idx - 1]
        x1, y1 = coords[idx]
        cx = (x0 + x1) / 2
        parts.append(f"C {cx:.2f} {y0:.2f}, {cx:.2f} {y1:.2f}, {x1:.2f} {y1:.2f}")
    return " ".join(parts)


def draw_zone_list(parts, x, y, zones, color):
    if not zones:
        parts.append(svg_text(x, y, "N/A", 13, 500, "#94a3b8"))
        return
    for idx, zone in enumerate(zones):
        yy = y + idx * 24
        strike = fmt(zone.get("strike"))
        distance = fmt(zone.get("distancePct"))
        weight = fmt(zone.get("distanceWeight"), 2)
        gravity = format_gravity_value(zone.get("weightedGravity"))
        parts.append(svg_text(x, yy, f"{strike} ({distance}%, {gravity}, w {weight})", 13, 600, color))


def main():
    if len(sys.argv) != 3:
        print("Usage: render_weekly_gravity_charts.py <report.json> <output_dir>", file=sys.stderr)
        return 2

    report_path = sys.argv[1]
    output_dir = sys.argv[2]

    with open(report_path, "r", encoding="utf-8") as f:
        report = json.load(f)

    charts_dir = os.path.join(output_dir, "charts")
    os.makedirs(charts_dir, exist_ok=True)

    rendered = 0
    for ticker, ticker_data in report.get("tickers", {}).items():
        if ticker_data.get("status") != "ok":
            continue
        svg = render_chart(ticker, ticker_data, report)
        output_path = os.path.join(charts_dir, f"{slug(ticker)}.svg")
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(svg)
        rendered += 1

    print(f"Rendered {rendered} charts to {charts_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
