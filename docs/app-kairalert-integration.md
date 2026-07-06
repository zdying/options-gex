# KairAlert 引力流接口文档

## 基础信息

Base URL：

```text
http://158.101.116.153:3000/
```

所有接口都在 `/api` 下。

跨域已经允许app.kairalert.pro请求：

```http
Access-Control-Allow-Origin: https://app.kairalert.pro
```

## Auth

所有接口请求都带这个 Header：

```http
Authorization: Bearer <access_token>
```

无权限返回：

```http
403
```

```json
{ "error": "Forbidden" }
```

## 接口

### GET /api/tickers

获取可选标的。

请求：

```http
GET /api/tickers
Authorization: Bearer <access_token>
```

返回：

```json
[{ "name": "QQQ", "count": 123 }]
```

字段：

| 字段    | 类型   | 说明         |
| ------- | ------ | ------------ |
| `name`  | string | 标的代码     |
| `count` | number | 大单信号数量 |

---

### GET /api/gravity-state

获取当前状态和顶部指标。

请求：

```http
GET /api/gravity-state?ticker=QQQ
Authorization: Bearer <access_token>
```

参数：

| 参数     | 必填 | 说明     |
| -------- | ---- | -------- |
| `ticker` | 否   | 标的代码 |

返回：

```json
{
  "selectedTicker": "QQQ",
  "isRunning": true,
  "currentTime": "10:35:20",
  "currentTimePct": 16.75,
  "speedMultiplier": 1,
  "spot": 553.42,
  "latestGravity": {
    "openingGravity": 1200000000,
    "liveGravity": 950000000,
    "gravityShift": -250000000,
    "openingUpperGravity": 560,
    "openingLowerGravity": 545,
    "openingGravityAxis": 552,
    "upperGravity": 558,
    "lowerGravity": 548,
    "gravityAxis": 551
  },
  "gravityReference": {
    "score": 70,
    "level": "中",
    "message": "引力位不是预测目标，而是需要重点观察的关键价格。",
    "reasons": []
  }
}
```

字段：

| 字段                                | 类型           | 说明                       |
| ----------------------------------- | -------------- | -------------------------- |
| `selectedTicker`                    | string         | 当前标的                   |
| `isRunning`                         | boolean        | 是否处于盘中运行状态       |
| `currentTime`                       | string         | 当前盘中时间               |
| `currentTimePct`                    | number         | 交易日进度百分比           |
| `spot`                              | number         | 当前价格                   |
| `latestGravity.openingGravity`      | number         | 开盘/全局引力              |
| `latestGravity.liveGravity`         | number         | 实时引力                   |
| `latestGravity.gravityShift`        | number         | 实时引力相对开盘引力的偏移 |
| `latestGravity.upperGravity`        | number \| null | 实时上方引力位             |
| `latestGravity.lowerGravity`        | number \| null | 实时下方引力位             |
| `latestGravity.gravityAxis`         | number \| null | 实时引力中轴               |
| `latestGravity.openingUpperGravity` | number \| null | 开盘上方引力位             |
| `latestGravity.openingLowerGravity` | number \| null | 开盘下方引力位             |
| `latestGravity.openingGravityAxis`  | number \| null | 开盘引力中轴               |
| `gravityReference.score`            | number         | 参考分数                   |
| `gravityReference.message`          | string         | 参考说明                   |

---

### GET /api/gravity-map

获取当前引力分布。

请求：

```http
GET /api/gravity-map?ticker=QQQ&range=all
Authorization: Bearer <access_token>
```

参数：

| 参数     | 必填 | 可选值                   | 说明                                          |
| -------- | ---- | ------------------------ | --------------------------------------------- |
| `ticker` | 否   | 标的代码                 | 标的                                          |
| `range`  | 否   | `all` / `today` / `near` | `all` 全部，`today` 当日到期，`near` 近期到期 |

返回：

```json
{
  "strikes": [540, 545, 550, 555, 560],
  "liveGravityCurve": [-120, -50, 30, 80, 100],
  "openingGravityCurve": [-90, -40, 20, 70, 95],
  "liveGravityRaw": [-120000000, -50000000, 30000000, 80000000, 100000000],
  "openingGravityRaw": [-90000000, -40000000, 20000000, 70000000, 95000000],
  "openingGravity": 1200000000,
  "liveGravity": 950000000,
  "gravityShift": -250000000,
  "openingUpperGravity": 560,
  "openingLowerGravity": 545,
  "openingGravityAxis": 552,
  "upperGravity": 558,
  "lowerGravity": 548,
  "gravityAxis": 551
}
```

字段：

| 字段                  | 类型           | 说明                            |
| --------------------- | -------------- | ------------------------------- |
| `strikes`             | number[]       | 价格轴                          |
| `liveGravityCurve`    | number[]       | 实时引力曲线，单位百万美元      |
| `openingGravityCurve` | number[]       | 开盘/全局引力曲线，单位百万美元 |
| `liveGravityRaw`      | number[]       | 实时引力原始值                  |
| `openingGravityRaw`   | number[]       | 开盘/全局引力原始值             |
| `openingGravity`      | number         | 总开盘/全局引力                 |
| `liveGravity`         | number         | 总实时引力                      |
| `gravityShift`        | number         | 总引力偏移                      |
| `upperGravity`        | number \| null | 实时上方引力位                  |
| `lowerGravity`        | number \| null | 实时下方引力位                  |
| `gravityAxis`         | number \| null | 实时引力中轴                    |
| `openingUpperGravity` | number \| null | 开盘上方引力位                  |
| `openingLowerGravity` | number \| null | 开盘下方引力位                  |
| `openingGravityAxis`  | number \| null | 开盘引力中轴                    |

---

### GET /api/gravity-history

获取盘中历史序列。

请求：

```http
GET /api/gravity-history?ticker=QQQ&range=all
Authorization: Bearer <access_token>
```

参数同 `/api/gravity-map`。

返回：

```json
[
  {
    "time": "10:35:20",
    "date": "2026-07-06",
    "sec": 38120,
    "spot": 553.42,
    "openingGravity": 1200000000,
    "liveGravity": 950000000,
    "gravityShift": -250000000,
    "openingUpperGravity": 560,
    "openingLowerGravity": 545,
    "openingGravityAxis": 552,
    "upperGravity": 558,
    "lowerGravity": 548,
    "gravityAxis": 551,
    "gravityMap": {
      "strikes": [540, 545, 550, 555, 560],
      "liveGravityCurve": [-120, -50, 30, 80, 100],
      "openingGravityCurve": [-90, -40, 20, 70, 95]
    }
  }
]
```

字段：

| 字段             | 类型           | 说明                                    |
| ---------------- | -------------- | --------------------------------------- |
| `time`           | string         | 时间                                    |
| `date`           | string         | 日期                                    |
| `sec`            | number         | 当日秒数                                |
| `spot`           | number         | 当时价格                                |
| `openingGravity` | number         | 当时开盘/全局引力                       |
| `liveGravity`    | number         | 当时实时引力                            |
| `gravityShift`   | number         | 当时引力偏移                            |
| `upperGravity`   | number \| null | 当时实时上方引力位                      |
| `lowerGravity`   | number \| null | 当时实时下方引力位                      |
| `gravityAxis`    | number \| null | 当时实时引力中轴                        |
| `gravityMap`     | object \| null | 当时引力分布，结构同 `/api/gravity-map` |

## 前端引力图构建

### 顶部指标

使用 `/api/gravity-state`：

| UI         | 字段                           |
| ---------- | ------------------------------ |
| 当前价格   | `spot`                         |
| 开盘引力   | `latestGravity.openingGravity` |
| 实时引力   | `latestGravity.liveGravity`    |
| 引力偏移   | `latestGravity.gravityShift`   |
| 上方引力位 | `latestGravity.upperGravity`   |
| 下方引力位 | `latestGravity.lowerGravity`   |
| 引力中轴   | `latestGravity.gravityAxis`    |

### 引力分布图

使用 `/api/gravity-map`：

| 图表元素       | 字段                      |
| -------------- | ------------------------- |
| X 轴           | `strikes`                 |
| 实时引力曲线   | `liveGravityCurve`        |
| 开盘引力曲线   | `openingGravityCurve`     |
| 当前价格竖线   | `/api/gravity-state.spot` |
| 上方引力位竖线 | `upperGravity`            |
| 下方引力位竖线 | `lowerGravity`            |
| 引力中轴竖线   | `gravityAxis`             |

如果使用 Chart.js，曲线数据可转成 `{ x, y }`：

```js
const liveSeries = data.strikes.map((strike, i) => ({
  x: strike,
  y: data.liveGravityCurve[i],
}));

const openingSeries = data.strikes.map((strike, i) => ({
  x: strike,
  y: data.openingGravityCurve[i],
}));
```

### 历史走势图

使用 `/api/gravity-history`：

```js
const labels = history.map((p) => p.time);
const opening = history.map((p) => p.openingGravity / 1e6);
const live = history.map((p) => p.liveGravity / 1e6);
const shift = history.map((p) => p.gravityShift / 1e6);
```

三条线：

| 曲线     | 数据      |
| -------- | --------- |
| 开盘引力 | `opening` |
| 实时引力 | `live`    |
| 引力偏移 | `shift`   |

## 错误处理

| 状态码 | 说明                   |
| ------ | ---------------------- |
| `403`  | 当前用户无权限         |
| `5xx`  | 服务不可用或数据源异常 |
