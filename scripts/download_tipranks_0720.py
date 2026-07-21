import urllib.request
import json
import os
import time

tickers = [
    "AAPL", "AMD", "AMZN", "GLD", "GOOG", "INTC", "IWM", "META", "MSFT", "MU",
    "NFLX", "NVDA", "ORCL", "QQQ", "SLV", "SNDK", "SPCX", "SPY", "TSLA", "TSM"
]

out_dir = "/home/zdying/work/options-indicator/data/tipranks_1min/2026-07-20"
os.makedirs(out_dir, exist_ok=True)

headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}

for ticker in tickers:
    url = f"https://market.tipranks.com/api/details/GetHistoricalStockPricesAsync/?ticker={ticker}&minutes=1&startTime=20260720&endTime=20260720&marketExtendedHrs=true"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req) as response:
            data = json.loads(response.read().decode('utf-8'))
            count = len(data) if isinstance(data, list) else 0
            print(f"Downloaded {ticker}: {count} bars")
            if isinstance(data, list) and len(data) > 0:
                with open(os.path.join(out_dir, f"{ticker}.json"), "w") as f:
                    json.dump(data, f)
    except Exception as e:
        print(f"Failed to fetch {ticker}: {e}")
    time.sleep(0.2)

print("Done fetching 1min data.")
