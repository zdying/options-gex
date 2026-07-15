# Gravity Internal API

本文档说明上游服务如何调用 web-app-new 的内部接口推送引力图数据。

## 接口

```txt
POST /api/internal/gravity
```

生产环境示例：

```txt
https://<your-domain>/api/internal/gravity
```

本地 Cloudflare Pages Functions 示例：

```txt
http://localhost:8788/api/internal/gravity
```

## 鉴权

请求必须带内部 token：

```txt
Authorization: Bearer <INTERNAL_API_TOKEN>
Content-Type: application/json
```

`INTERNAL_API_TOKEN` 由 Cloudflare 环境变量或本地 `.dev.vars` 提供。

## 请求体

接口一次接收一个股票的当前状态和当前快照：

```json
{
  "ticker": "QQQ",
  "range": "today",
  "date": "2026-07-14",
  "state": {
    "selectedTicker": "QQQ",
    "isRunning": true,
    "currentTime": "16:00:00",
    "currentTimePct": 100,
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
      "reasons": ["CPI Block", "ADP Employment Change", "Fed Speech"]
    }
  },
  "snapshot": {
    "strikes": [700, 701, 702],
    "liveGravityCurve": [-297.68, -53.34, -37.51],
    "openingGravityCurve": [-308.06, -54.01, -37.81],
    "liveGravityRaw": [-297686491.45, -53342029.2, -37519947.92],
    "openingGravityRaw": [-308063925.05, -54019441.32, -37812655.91],
    "openingGravity": 2307049727.453168,
    "liveGravity": -752335577.562842,
    "gravityShift": -3059385305.01601,
    "openingUpperGravity": 720,
    "openingLowerGravity": 700,
    "openingGravityAxis": 718.48,
    "upperGravity": 721,
    "lowerGravity": 700,
    "gravityAxis": 720.06
  }
}
```

也可以把 `snapshot` 字段命名为 `gravityMap`，接口会按同样方式处理。

## 字段说明

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `ticker` | 是 | 股票代码，会转成大写。也可以从 `state.selectedTicker` 兜底读取。 |
| `range` | 否 | 引力图范围：`today`、`near`、`all`。默认 `today`。 |
| `date` | 否 | 交易日，格式建议 `YYYY-MM-DD`。缺省时使用服务端当天 UTC 日期。 |
| `state` | 是 | 当前状态。每个 ticker 在 `gravity_states` 始终只保留一条最新记录。 |
| `state.currentTime` | 建议 | 当前市场时间，如 `16:00:00`。用于计算 snapshot 所属分钟。 |
| `state.spot` | 建议 | 当前股价，同时会写入 snapshot 的 `spot`。 |
| `state.has0Dte` | 否 | 是否有 0DTE 数据。缺省按 `true` 处理。 |
| `state.latestGravity` | 否 | 当前引力摘要，会拆列写入 `gravity_states`。 |
| `state.gravityReference` | 否 | 风险参考信息，`reasons` 会作为 JSON 数组保存。 |
| `snapshot` | 是 | 当前这一帧引力图快照，会写入 `gravity_snapshots`。 |
| `snapshot.strikes` | 是 | 行权价数组。 |
| `snapshot.liveGravityCurve` | 是 | 实时引力曲线数组。 |
| `snapshot.openingGravityCurve` | 是 | 开盘/全局引力曲线数组。 |
| `snapshot.liveGravityRaw` | 否 | 未缩放实时引力原始值数组。 |
| `snapshot.openingGravityRaw` | 否 | 未缩放开盘/全局引力原始值数组。 |

## 分钟归档规则

接口会把当前快照归档到“这一分钟”：

1. 优先使用 `state.currentTime`
2. 其次使用顶层 `time` 或 `currentTime`
3. 再其次使用顶层 `sec`
4. 都没有时使用服务端当前时间

例如：

```txt
16:00:01 -> time_text = 16:00, sec = 57600
16:00:45 -> time_text = 16:00, sec = 57600
16:01:00 -> time_text = 16:01, sec = 57660
```

`gravity_snapshots` 的唯一键是：

```txt
ticker + range + date + sec
```

所以同一个股票、同一个 range、同一个交易日、同一分钟内重复推送，会更新同一条 snapshot；下一分钟才新增一条记录。

## 写入结果

成功响应：

```json
{
  "status": "ok",
  "ticker": "QQQ",
  "range": "today",
  "date": "2026-07-14",
  "time": "16:00",
  "sec": 57600,
  "state": {
    "updated": true
  },
  "snapshot": {
    "upserted": true,
    "id": "QQQ:today:2026-07-14:57600"
  }
}
```

常见错误：

```json
{ "error": "Unauthorized: invalid internal token" }
```

```json
{ "error": "ticker is required" }
```

```json
{ "error": "state is required" }
```

```json
{ "error": "snapshot must include strikes, liveGravityCurve and openingGravityCurve arrays" }
```

## curl 示例

```bash
curl -X POST "https://<your-domain>/api/internal/gravity" \
  -H "Authorization: Bearer $INTERNAL_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "ticker": "QQQ",
    "range": "today",
    "date": "2026-07-14",
    "state": {
      "selectedTicker": "QQQ",
      "isRunning": true,
      "currentTime": "16:00:00",
      "currentTimePct": 100,
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
      }
    },
    "snapshot": {
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
    }
  }'
```

## 数据库写入行为

`gravity_states`：

- 以 `ticker` 为主键。
- 每次推送都会覆盖该 ticker 的当前状态。
- 适合前端读取当前 spot、has0Dte、风险参考和 latestGravity。

`gravity_snapshots`：

- 以 `ticker + range + trade_date + sec` 做唯一约束。
- 每分钟每个 ticker/range 最多一条。
- 曲线数组以 JSON 文本保存，摘要字段单独拆列，方便后续查询和排序。

## 前端读取关系

当前前端主要读取：

```txt
GET /api/gravity-state?ticker=QQQ&range=today
```

该接口会聚合返回当前 state 和最新 snapshot：

```json
{
  "status": "ok",
  "selectedTicker": "QQQ",
  "selectedRange": "today",
  "spot": 719.69,
  "has0Dte": true,
  "latestGravity": {},
  "gravityReference": {},
  "gravityMap": {}
}
```
