#!/usr/bin/env python3

import argparse
import json
import time
import urllib.request
from datetime import datetime
from pathlib import Path
from urllib.parse import urlencode
from zoneinfo import ZoneInfo


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT_ROOT = PROJECT_ROOT / "data" / "tipranks_1min"
LIVE_DATA_ROOT = PROJECT_ROOT / "data" / "live_data"
DEFAULT_TICKERS = [
    "AAPL", "AMD", "AMZN", "GLD", "GOOG", "INTC", "IWM", "META", "MSFT", "MU",
    "NFLX", "NVDA", "ORCL", "QQQ", "SLV", "SNDK", "SPCX", "SPY", "TSLA", "TSM",
]
NEW_YORK = ZoneInfo("America/New_York")
UTC = ZoneInfo("UTC")
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    )
}


def parse_args():
    parser = argparse.ArgumentParser(
        description="Download TipRanks 1-minute bars for one trading date."
    )
    parser.add_argument(
        "date",
        metavar="YYYY-MM-DD",
        help="Required trading date in America/New_York time.",
    )
    parser.add_argument(
        "--tickers",
        nargs="+",
        help=(
            "Ticker symbols to download. When omitted, use ticker directories from "
            "data/live_data/<date>, falling back to the built-in ticker list."
        ),
    )
    parser.add_argument(
        "--out-root",
        type=Path,
        default=DEFAULT_OUT_ROOT,
        help=f"Output root directory. Defaults to {DEFAULT_OUT_ROOT}.",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=0.2,
        help="Delay between requests in seconds. Defaults to 0.2.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite an existing non-empty ticker file.",
    )
    return parser.parse_args()


def validate_date(date_str):
    try:
        datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError as exc:
        raise ValueError(f"Invalid date {date_str!r}; expected YYYY-MM-DD.") from exc
    return date_str


def tickers_for_date(date_str, requested_tickers):
    if requested_tickers:
        return sorted({ticker.upper() for ticker in requested_tickers})

    live_date_dir = LIVE_DATA_ROOT / date_str
    if live_date_dir.is_dir():
        discovered = sorted(
            entry.name.upper()
            for entry in live_date_dir.iterdir()
            if entry.is_dir() and (entry / "history.json").is_file()
        )
        if discovered:
            return discovered

    return DEFAULT_TICKERS


def bar_new_york_date(bar):
    date_value = bar.get("date")
    if not date_value:
        return None

    try:
        parsed = datetime.fromisoformat(date_value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=UTC)
        return parsed.astimezone(NEW_YORK).strftime("%Y-%m-%d")
    except (TypeError, ValueError):
        return None


def download_ticker(date_str, ticker):
    query = urlencode(
        {
            "ticker": ticker,
            "minutes": 1,
            "startTime": date_str,
            "endTime": date_str,
            "marketExtendedHrs": "true",
        }
    )
    url = (
        "https://market.tipranks.com/api/details/"
        f"GetHistoricalStockPricesAsync/?{query}"
    )
    request = urllib.request.Request(url, headers=HEADERS)

    with urllib.request.urlopen(request, timeout=30) as response:
        raw_data = json.loads(response.read().decode("utf-8"))

    if not isinstance(raw_data, list):
        raise ValueError("TipRanks response is not a list.")

    filtered_data = [
        bar for bar in raw_data if bar_new_york_date(bar) == date_str
    ]
    return raw_data, filtered_data


def main():
    args = parse_args()
    date_str = validate_date(args.date)
    failures = []
    downloaded = 0
    skipped = 0

    out_dir = args.out_root / date_str
    out_dir.mkdir(parents=True, exist_ok=True)
    tickers = tickers_for_date(date_str, args.tickers)

    print(f"[{date_str}] downloading {len(tickers)} tickers to {out_dir}")

    for ticker in tickers:
        output_path = out_dir / f"{ticker}.json"
        if output_path.is_file() and output_path.stat().st_size > 0 and not args.force:
            print(f"[{date_str}] {ticker}: skipped existing file")
            skipped += 1
            continue

        try:
            raw_data, filtered_data = download_ticker(date_str, ticker)
            if not filtered_data:
                raise ValueError(
                    f"response contained {len(raw_data)} bars but none matched {date_str}"
                )

            output_path.write_text(
                json.dumps(filtered_data),
                encoding="utf-8",
            )
            print(
                f"[{date_str}] {ticker}: raw={len(raw_data)}, "
                f"saved={len(filtered_data)}"
            )
            downloaded += 1
        except Exception as exc:
            failures.append((date_str, ticker, str(exc)))
            print(f"[{date_str}] {ticker}: failed: {exc}")

        if args.delay > 0:
            time.sleep(args.delay)

    print(
        f"Done: downloaded={downloaded}, skipped={skipped}, failures={len(failures)}"
    )
    if failures:
        for date_str, ticker, error in failures:
            print(f"  - {date_str} {ticker}: {error}")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
