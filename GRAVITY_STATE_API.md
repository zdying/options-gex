# Gravity State API

本文档说明 web-app-new 前端引力图如何请求 Cloudflare Pages Function 的 state 接口，以及该接口返回的数据结构。

## 前端请求逻辑

引力图组件现在只请求一个接口：

```txt
GET /api/gravity-state?ticker=<TICKER>&range=<RANGE>
```

前端入口是 `fetchGravityState(symbol, { range })`。当前 `range` 支持：

```txt
today | near | all
```

组件初始默认选择 `today`，所以首次会请求：

```txt
GET /api/gravity-state?ticker=QQQ&range=today
```

接口返回后，前端按返回结果更新 UI：

1. 读取 `has0Dte`。
2. 如果 `has0Dte !== false`，显示 `today` 选项；否则隐藏 `today`。
3. 读取 `selectedRange`。
4. 如果 `selectedRange` 和当前前端选中的 range 不同，前端会切到接口返回的 `selectedRange`。
5. 使用同一个响应里的 `gravityMap` 渲染图表。

因此，前端会先尝试请求 `today`，然后由后端根据真实 state 决定是否切到 `near`。

## Cloudflare Function

文件位置：

```txt
functions/api/gravity-state/index.js
```

处理函数：

```txt
onRequestGet(context)
```

鉴权和限制：

- 先走 `optionsReadLimiter(context)`。
- 再走 `requireUser(context)`，要求用户已登录。
- 使用 `canAccessEventKind(currentUser, 'options_flow')` 判断订阅权限。

请求参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `ticker` | 是 | 股票代码，后端会 trim 并转成大写。 |
| `range` | 否 | `today`、`near`、`all`。非法或缺省时按 `today` 处理。 |

## Range 决策

后端会先读取：

```sql
SELECT * FROM gravity_states WHERE ticker = ?
```

然后根据请求 range 和 state 决定最终返回的 `selectedRange`：

```js
const state = mapStateRow(stateRow) || { selectedTicker: ticker, has0Dte: false };
const selectedRange = state.has0Dte === false && requestedRange === 'today'
  ? 'near'
  : requestedRange;
```

含义：

- 如果 state 表示没有 0DTE，并且前端请求 `today`，接口会返回 `selectedRange: "near"`。
- 其他情况返回前端请求的 range。
- 前端会以 `selectedRange` 为准更新选中的周期。

随后接口读取该 range 的最新 snapshot：

```sql
SELECT *
FROM gravity_snapshots
WHERE ticker = ? AND range_key = ?
ORDER BY trade_date DESC, sec DESC
LIMIT 1
```

## 成功返回结构

正常有权限时返回：

```json
{
  "status": "ok",
  "selectedTicker": "QQQ",
  "isRunning": true,
  "currentTime": "15:59:00",
  "currentTimePct": 99.5,
  "speedMultiplier": 1,
  "spot": 719.69,
  "has0Dte": true,
  "latestGravity": {
    "openingGravity": 2307049727.453168,
    "liveGravity": -752335577.562842,
    "gravityShift": -3059385305.01601,
    "openingUpperGravity": 720,
    "openingLowerGravity": 700,
    "openingGravityAxis": 718.48,
    "upperGravity": 721,
    "lowerGravity": 700,
    "gravityAxis": 720.06
  },
  "gravityReference": {
    "score": 40,
    "level": "低",
    "message": "重大事件前后，引力位可能快速失效。",
    "reasons": ["CPI Block"]
  },
  "updatedAt": "2026-07-14T20:00:00.000Z",
  "selectedRange": "today",
  "gravityMap": {
    "date": "2026-07-14",
    "time": "15:59",
    "sec": 57540,
    "spot": 719.69,
    "strikes": [700, 701, 702],
    "liveGravityCurve": [-297.68, -53.34, -37.51],
    "openingGravityCurve": [-308.06, -54.01, -37.81],
    "openingGravity": 2307049727.453168,
    "liveGravity": -752335577.562842,
    "gravityShift": -3059385305.01601,
    "openingUpperGravity": 720,
    "openingLowerGravity": 700,
    "openingGravityAxis": 718.48,
    "upperGravity": 721,
    "lowerGravity": 700,
    "gravityAxis": 720.06
  },
  "subscription_expired": false
}
```

说明：

- 顶层 state 字段来自 `gravity_states`。
- `gravityMap` 来自 `gravity_snapshots` 中当前 `selectedRange` 的最新一条记录。
- 如果没有对应 snapshot，`gravityMap` 为 `null`。
- `selectedTicker` 在最终响应中会强制使用请求参数里的 ticker。

## 订阅过期返回结构

用户已登录但无 `options_flow` 访问权限时，接口不会返回图表数据：

```json
{
  "status": "ok",
  "selectedTicker": "QQQ",
  "selectedRange": "today",
  "gravityMap": null,
  "subscription_expired": true
}
```

## 错误返回

缺少 ticker：

```json
{
  "error": "ticker is required"
}
```

HTTP 状态码为 `400`。

未登录或 token 无效时，由 `requireUser` 返回 `401`。

## 前端使用字段

引力图组件主要使用这些字段：

| 字段 | 用途 |
| --- | --- |
| `has0Dte` | 决定是否显示 `today` 周期按钮。 |
| `selectedRange` | 决定当前选中的周期；如果后端切到 `near`，前端同步切换。 |
| `spot` | 绘制 Spot 竖向虚线。 |
| `gravityMap.strikes` | 横轴价格点。 |
| `gravityMap.liveGravityCurve` | 实时引力曲线。 |
| `gravityMap.openingGravityCurve` | 开盘/全局引力曲线。 |
| `gravityMap.date`、`gravityMap.time` | 标题时间。 |
| `subscription_expired` | 表示订阅不可访问。 |

