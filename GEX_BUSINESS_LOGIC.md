# GEX Structure Engine 业务逻辑说明

## 目标

系统保留原有的数据采集生命周期，但只计算和展示一条核心主线：

```txt
Opening OI Global GEX + Flow-adjusted Realtime GEX
```

也就是：

- 开盘前用官方期权链 `openInterest` 建立当天的 OI 底座。
- 盘中不改官方 OI，只用大单流维护模型修正量 `flowPositionDelta`。
- Global GEX 使用 `openingOI`，但会随着盘中 spot 和 IV 更新重新投影。
- Realtime GEX 使用 `openingOI + flowPositionDelta`，并用分钟级剩余时间重新计算。
- 输出 GEX 总量、GEX 变化、Call Wall、Put Wall、Zero Gamma 和按 strike 的 GEX 曲线。

旧版的 VWAP、DPI、Dealer Pressure、Regime、Decision Report 已从主流程移除。

## 核心持仓模型

每个合约在内存中维护：

```js
{
  symbol,
  strike,
  type,
  expiration,
  openingOI,
  flowPositionDelta,
  bid,
  ask,
  midpoint,
  ivRealtime,
  ivGlobal
}
```

字段含义：

- `openingOI`：开盘期权链里的官方 OI，当天固定不变。
- `flowPositionDelta`：盘中大单流带来的模型持仓净修正，初始为 0。
- `realtimePosition = openingOI + flowPositionDelta`。

方向规则：

```txt
客户买入 Call: flowPositionDelta += size
客户卖出 Call: flowPositionDelta -= size
客户买入 Put:  flowPositionDelta += size
客户卖出 Put:  flowPositionDelta -= size
```

GEX 符号在计算阶段处理：

```js
signedPosition = type === 'PUT' ? -position : position
```

因此 Call GEX 通常为正向，Put GEX 通常为负向。

## GEX 计算公式

单合约 GEX：

```js
contractGex = signedPosition * gamma * 100 * spot * spot * 0.01
```

其中：

- `signedPosition` 是带 Call/Put 符号的合约张数。
- `gamma` 来自 Black-Scholes。
- `100` 是美股期权乘数。
- `spot * spot * 0.01` 表示标的移动 1% 时的 Delta dollar exposure。

Global GEX：

```js
globalPosition = openingOI
globalT = calculateDayT(today, expiration)
globalGex = signed(globalPosition) * gammaGlobal * 100 * spot * spot * 0.01
```

Realtime GEX：

```js
realtimePosition = openingOI + flowPositionDelta
realtimeT = calculateT(today, currentTime, expiration)
realtimeGex = signed(realtimePosition) * gammaRealtime * 100 * spot * spot * 0.01
```

Realtime T 有最小分钟下限，默认 5 分钟，避免 0DTE 收盘前数值失控。

## 服务启动

服务启动时执行：

1. 初始化 Express 静态服务和 API。
2. 初始化 `PositionStore` 与 `GexAggregator`。
3. 初始化内置 ticker 状态，目前为 `SPY`、`QQQ`、`MU`。
4. 根据美东日期恢复当天大单游标：
   - 如果已有 `trades.json`，读取其中最大 `updated` 作为 Benzinga 大单游标。
   - 如果没有交易文件，游标从美东 09:20 开始。
5. 启动市场状态调度器。

服务启动不会主动创建旧版报告，也不会计算 DPI/VWAP。

## 市场状态调度

系统按美东时间分为三个状态：

```txt
IDLE       非交易准备/交易时间，或周末
PREPARING 09:20:00 - 09:30:00
TRADING   09:30:00 - 16:00:00
```

调度器每 10 秒检查一次状态变化：

- 进入 `PREPARING`：重新初始化 cursor 和去重集合，拉取 opening chain。
- 进入 `TRADING`：确保每个 ticker 已初始化，并启动期权链轮询和大单轮询。
- 进入 `IDLE`：停止所有轮询定时器。

## 盘前流程

盘前准备阶段调用 `startLiveTracker(ticker)`：

1. 创建当天目录：

```txt
data/live_data/YYYY-MM-DD/TICKER/
```

2. 获取或复用开盘期权链：

```txt
optionchains_open.json
```

3. 用开盘期权链初始化合约矩阵：

```js
openingOI = openInterest
flowPositionDelta = 0
```

4. 获取初始 spot：
   - 优先 TipRanks quote。
   - 其次从期权链 Put-Call parity 反推。
   - 再其次从当天最后一笔大单的 underlying price 取值。

5. 预计算 IV：
   - `ivRealtime` 使用分钟级 T。
   - `ivGlobal` 使用天级 T。

6. 计算初始 GEX summary。

## 盘中大单流程

盘中每 15 秒执行一次 `pollLiveTrades()`：

1. 从 Benzinga option activity 接口拉取增量大单。
2. 只保留内置 ticker 且日期为当天的记录。
3. 使用 `knownSignalIds` 去重。
4. 保存到：

```txt
trades.json
```

5. 对每笔新大单调用：

```js
store.applyTrade(ticker, trade, todayStr)
```

6. `applyTrade` 根据交易方向修正 `flowPositionDelta`。
7. 如果大单携带有效 midpoint，则用交易价反推该合约 `ivRealtime`。

大单流程只修正模型持仓，不直接生成 history 点。最终 GEX 会在期权链轮询时统一重算。

## 盘中期权链流程

盘中每 20 秒执行一次 `pollLiveChainAndCalculate(ticker)`：

1. 拉取最新期权链。
2. 按当前 spot 附近 strike 裁剪快照。
3. 保存到：

```txt
optionchains/snap_HHMM.json
```

4. 更新合约报价：

```js
bid
ask
midpoint
```

5. 清空该合约的 `ivRealtime` 和 `ivGlobal`，下一次计算时重新反推。
6. 更新最新 spot：
   - 优先 TipRanks quote。
   - 其次期权链 parity 反推。
7. 调用 `calculateMatrixGEX()`：
   - 每个合约计算实时 Greeks 和 global Greeks。
   - 每个合约输出 `realtimeGex` 和 `globalGex`。
8. 调用 `GexAggregator` 聚合：
   - 总 Global GEX。
   - 总 Realtime GEX。
   - GEX Change。
   - Call Wall / Put Wall / Zero Gamma。
   - 按 strike 的 Global / Realtime GEX。
9. 写入当分钟 history 点。

## History 数据

每分钟 history 点结构：

```js
{
  time,
  sec,
  spot,
  globalTotalGex,
  realtimeTotalGex,
  gexChange,
  globalCallWall,
  globalPutWall,
  globalZeroGamma,
  realtimeCallWall,
  realtimePutWall,
  realtimeZeroGamma,
  gexData
}
```

`gexData` 按 expiry view 保存：

```js
{
  all,
  '0dte',
  weekly
}
```

每个 view 包含：

```js
{
  strikes,
  realtimeStrikeGexMillions,
  globalStrikeGexMillions,
  strikeGexRealtime,
  strikeGexGlobal,
  realtimeTotalGex,
  globalTotalGex,
  gexChange,
  realtimeCallWall,
  realtimePutWall,
  realtimeZeroGamma,
  globalCallWall,
  globalPutWall,
  globalZeroGamma
}
```

## GEX 聚合与墙位

`GexAggregator` 负责所有结构聚合。

按 strike 聚合：

```js
strike.globalGex += contract.globalGex
strike.realtimeGex += contract.realtimeGex
```

Call Wall：

- 在当前 spot 上方。
- 限制在 spot 上下 10% 区间。
- 选择正 GEX 最大的 strike。

Put Wall：

- 在当前 spot 下方。
- 限制在 spot 上下 10% 区间。
- 选择负 GEX 绝对值最大的 strike。

Zero Gamma：

- 不从 strike GEX 符号变化直接寻找。
- 在当前 spot 上下 10% 进行 spot 扫描。
- 每个假设 spot 都重新计算所有合约 Gamma 与总 GEX。
- 若出现正负切换，用线性插值估算。
- 若没有切换，返回总 GEX 绝对值最小的 spot。

## API

### `GET /api/tickers`

返回内置 ticker 列表和当天大单数量。

### `GET /api/state?ticker=SPY`

返回当前前端状态：

```js
{
  selectedTicker,
  isRunning,
  currentTime,
  currentTimePct,
  speedMultiplier,
  spot,
  latestGex
}
```

### `GET /api/gex?ticker=SPY&expiry=all`

返回指定 expiry view 的 GEX 曲线和结构位。

`expiry` 支持：

```txt
all
0dte
weekly
```

### `GET /api/history?ticker=SPY&expiry=all`

返回当天或最近可用日期的 history 时间序列。

## 前端展示

前端保留原有轮询和回放框架，但展示内容只保留 GEX 主线：

- Spot / GEX Change。
- Global GEX。
- Realtime GEX。
- Live Walls。
- GEX Exposure Map。
- GEX & Spot Intraday Trend。

说明文本：

```txt
实时 GEX 为基于大单流修正后的模型估算值，并非官方 OI。
```

## 盘后逻辑

盘后系统停止轮询，但保留当天数据：

```txt
optionchains_open.json
optionchains/snap_*.json
trades.json
history.json
```

`flowPositionDelta` 只用于当天模型，不会带到第二天。

第二天必须重新拉取新的 opening option chain，并用新的官方 `openInterest` 初始化：

```js
openingOI = newOfficialOpenInterest
flowPositionDelta = 0
```
