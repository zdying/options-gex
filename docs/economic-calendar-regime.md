# Economic Calendar Regime Source

## 目标

用 Finviz economic calendar 判断当天是否存在会降低“引力参考度”的事件。

接口示例：

```text
https://finviz.com/api/calendar/economic?dateFrom=2026-06-29&dateTo=2026-07-03
```

参数建议固定按一周请求：

- `dateFrom`: 当周周一
- `dateTo`: 当周周五

这样一次请求即可覆盖本周交易日事件，避免每天重复请求。

## 返回字段

当前接口返回数组，每个事件包含：

- `event`: 事件名称，例如 `Non Farm Payrolls`
- `category`: 事件类别，例如 `Non Farm Payrolls`
- `date`: 事件时间，例如 `2026-07-02T08:30:00`
- `reference`: 对应周期，例如 `Jun`
- `actual`: 实际值
- `forecast`: 市场预期
- `previous`: 前值
- `teforecast`: Trading Economics 预期
- `importance`: 影响等级，`1` 低，`2` 中，`3` 高
- `allDay`: 是否全天事件

## 事件分组

不要按每一行事件重复扣分。应该先把同类事件合并成事件组。

### 硬事件

命中任意一个硬事件组，当天直接扣 `40`。

#### NFP / Employment Block

关键词：

- `Non Farm Payrolls`
- `Unemployment Rate`
- `Average Hourly Earnings`
- `Nonfarm Payrolls Private`
- `Participation Rate`
- `U-6 Unemployment Rate`
- `Manufacturing Payrolls`

说明：这些通常同一时间发布，本质上属于同一个非农就业事件包，只扣一次。

#### CPI Block

关键词：

- `CPI`
- `Core CPI`
- `Consumer Price Index`

#### PPI Block

关键词：

- `PPI`
- `Core PPI`
- `Producer Price Index`

#### FOMC Block

关键词：

- `FOMC`
- `Fed Interest Rate Decision`
- `Fed Rate Decision`
- `FOMC Statement`
- `Fed Press Conference`

注意：`Fed Chair Speech` 不等于 FOMC。

## 软事件

软事件用于降低参考度，但不要无限叠加。建议软事件总扣分封顶 `25`。

### ADP

关键词：

- `ADP Employment Change`

建议扣分：`10`

### ISM

关键词：

- `ISM Manufacturing PMI`
- `ISM Services PMI`
- `ISM Manufacturing Employment`
- `ISM Manufacturing New Orders`
- `ISM Manufacturing Prices`
- `ISM Services Employment`
- `ISM Services Prices`

建议扣分：

- 主 PMI：`15`
- 分项：`5`
- 同一天 ISM 总扣分封顶 `15`

### Fed Speech

关键词：

- `Fed Chair`
- `Fed Powell`
- `Fed Warsh`
- `Fed Waller`
- `Fed Jefferson`
- `Fed Bowman`
- `Fed Barr`
- `Fed Barkin`
- `Fed Williams`
- `Fed Goolsbee`
- `Fed Logan`
- `Fed Kashkari`
- `Fed Daly`

建议扣分：

- `Fed Chair ... Speech`: `15`
- 其他 Fed 官员讲话：`5` 到 `10`

### JOLTS / Jobless Claims

关键词：

- `JOLTs Job Openings`
- `Initial Jobless Claims`
- `Continuing Jobless Claims`

建议扣分：

- `JOLTs Job Openings` 且 `importance >= 3`: `10`
- 周度 jobless claims：通常不扣，除非没有其他就业事件且 `importance >= 2`，可扣 `5`

## 默认忽略

以下事件第一版不用于降低 QQQ/SPY 的引力参考度：

- `MBA Mortgage`
- `Mortgage Rate`
- `EIA Crude Oil`
- `EIA Gasoline`
- `EIA Natural Gas`
- `Bill Auction`
- `Baker Hughes`
- `Vehicle Sales`
- `Fed Balance Sheet`
- `Construction Spending`
- 地方联储制造业/服务业指数，例如 `Dallas Fed ...`

这些事件可能影响局部资产或特定行业，但对 QQQ/SPY 的引力参考度不应默认扣分。

## 评分建议

基础分：

```text
Score = 100
```

规则：

```text
硬事件命中：-40
软事件累计：最多 -25
最终分数：Clamp(Score, 0, 100)
```

示例：

```text
2026-07-02:
Non Farm Payrolls + Unemployment Rate + Average Hourly Earnings
=> NFP Block
=> 100 - 40 = 60
```

```text
2026-07-01:
ADP Employment Change
Fed Chair Warsh Speech
ISM Manufacturing PMI
=> 软事件日
=> 100 - 25 = 75
```

## 推荐实现

1. 每天启动时计算当前周一和周五。
2. 请求 Finviz 一周经济日历。
3. 按美东日期聚合事件。
4. 对当天事件做关键词匹配。
5. 先判断硬事件组，再计算软事件扣分。
6. 日志打印：

```text
[MacroEvents] Loaded Finviz economic calendar: 2026-06-29 to 2026-07-03, events=...
[Regime] Matched hard blocks: NFP
[Regime] Matched soft events: ADP Employment Change, Fed Chair Warsh Speech, ISM Manufacturing PMI
[Regime] Gravity reference score: 75
```

## FRED 的位置

FRED 可以保留为兜底源，但不再适合作为主源。

FRED 适合兜底：

- CPI
- NFP / Employment Situation
- PPI
- 部分 ISM release

FRED 不适合覆盖：

- ADP
- Fed Chair Speech
- 完整经济日历 impact
- expected / prior / actual
- 精确事件时间

因此第一优先级应改为 Finviz economic calendar，FRED 只作为失败兜底。

## 总结

硬事件：直接改变宏观定价，容易让引力位失效
NFP / CPI / FOMC / PPI

软事件：增加不确定性，降低引力位可靠性
ADP / ISM / Fed Chair Speech
