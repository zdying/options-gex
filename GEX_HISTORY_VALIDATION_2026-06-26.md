# GEX 历史验证报告

生成日期：2026-06-28

验证目标：检查当前 `options-indicator` 项目里的 GEX 系统，是否对股价方向、目标位、支撑/阻力、波动状态有历史解释力和实用价值。

本次验证没有修改任何业务代码。

## 数据拉取情况

远程服务器：`amd1`

远程项目路径：`/home/ubuntu/options-indicator`

本地临时数据路径：`/tmp/options-indicator-gex-verify`

本次只拉取了以下文件：

- `/home/ubuntu/options-indicator/data/live_data/2026-06-26/MU/history.json`
- `/home/ubuntu/options-indicator/data/live_data/2026-06-26/QQQ/history.json`
- `/home/ubuntu/options-indicator/data/live_data/2026-06-26/SPY/history.json`

没有同步 `optionchains` 快照目录。

## 数据覆盖情况

| 日期 | Ticker | 分钟点数量 | 时间范围 | gexData | report.structureWalls | spot/vwap/dpi/dealerNotional |
|---|---:|---:|---|---:|---:|---:|
| 2026-06-26 | MU | 391 | 09:30-16:00 | 391/391 | 391/391 | 391/391 |
| 2026-06-26 | QQQ | 391 | 09:30-16:00 | 391/391 | 391/391 | 391/391 |
| 2026-06-26 | SPY | 391 | 09:30-16:00 | 391/391 | 391/391 | 391/391 |

这三只标的在 2026-06-26 的 `history.json` 数据完整，可以进入历史验证。

## 代码逻辑确认

### GEX

实时 GEX 在 `src/store/positionStore.js` 中计算：

```text
gex = structurePosition * gamma * 100 * spot^2 * 0.01
```

Global GEX 使用静态 open interest：

```text
CALL initialPosition = +openInterest * oiFactor
PUT initialPosition  = -openInterest * oiFactor
gexGlobal = initialPosition * gammaGlobal * 100 * spot^2 * 0.01
```

默认 `oiFactor` 是 `0.5`。

### Call Wall / Put Wall / Zero Gamma

`findStructureWalls()` 会按 strike 聚合 GEX，然后：

- `Call Wall`：GEX 最大正值所在 strike
- `Put Wall`：GEX 最大负值所在 strike
- `Zero Gamma`：第一个相邻 strike 的 GEX 符号翻转点

重要问题：当前 Zero Gamma 实现不是“累计 GEX 穿零”，而是“单个 strike 的局部 GEX 符号翻转”。这和 PRD 里的定义不一致。

### DPI

`DPI` 在 `src/engine/flowProcessor.js` 中计算。

每笔大单先计算：

```text
Pressure_Shock = -contracts * 100 *
  (dealerGamma * dS + dealerCharm * dt + dealerVanna * dIV)
```

然后系统：

- 保留最近 100 笔 pressure shock；
- 使用线性衰减权重；
- 得到 `Raw_DPI`；
- 用历史 Raw DPI 的 95% 分位数做归一化；
- 最终把 `DPI` 限制在 `[-100, 100]`。

### dealerNotional

`dealerNotional` 在 `src/engine/aggregator.js` 中计算。

系统先聚合 dealerPosition 下的 gamma/charm/vanna，然后套用固定压力场景：

- `dS = spot * 0.5%`
- `dt = 30 分钟`
- `dIV = -1%`

最后：

```text
dealerPressure = gammaPressure + charmPressure + vannaPressure
dealerNotional = dealerPressure * spot
```

这个值更适合解释为“固定压力场景下的对冲敏感度”，不能直接等同于方向预测信号。

## 关键统计结果

### GEX 正负/强弱与未来波动

本次样本里，最有解释力的是 `|netGEX|` 对未来绝对波动的解释，而不是方向。

SPY：

- `|netGEX|` 与未来 30 分钟绝对收益相关性约 `0.49`
- `|netGEX|` 与未来 60 分钟绝对收益相关性约 `0.57`

QQQ：

- 60 分钟相关性较弱，约 `0.19`

MU：

- 结果不稳定；60 分钟为正相关，但短周期表现弱或为负。

结论：GEX 强弱对波动状态有一定解释力，尤其在 SPY 上更明显。但它不是干净的方向信号。

### DPI / dealerNotional 对方向的预测力

DPI 在 5/15/30/60 分钟方向预测上没有稳定优势。

样本结果：

- SPY 的 15 分钟 DPI 表现最好，命中率约 `58.3%`。
- QQQ 和 MU 没有验证出同样优势。
- MU 中，正 DPI 反而经常对应后续下跌。

`dealerNotional` 的方向预测也不可靠。很多时间点它几乎只有正值，缺少双边状态，不能形成有效多空判断。QQQ 和 SPY 中，`dealerNotional` 与未来 60 分钟收益的相关性反而大约是 `-0.77`。

结论：当前 DPI 和 dealerNotional 都不应该被当成独立方向信号。

### Call Wall / Put Wall

墙位的作用取决于 ticker 和市场状态，不能机械理解成“Call Wall 一定是阻力、Put Wall 一定是支撑”。

SPY 的 Call Wall 在这一天有明显阻力特征：

- 靠近 Call Wall 的 60 分钟样本数：`90`
- 触达 Call Wall：`14.4%`
- 最终收在 Call Wall 上方：`2.2%`
- 出现回落：`88.9%`

QQQ 和 MU 的 Put Wall 更像目标位或磁吸位，而不是支撑位：

- QQQ 靠近 Put Wall 后，60 分钟内触达比例：`97.4%`
- QQQ 最终跌破或收在 Put Wall 下方：`77.9%`
- MU 靠近 Put Wall 后，60 分钟内触达比例：`100%`

结论：墙位有实用价值，但必须结合状态判断。它有时是支撑/阻力，有时是目标/磁吸。

### Zero Gamma

当前 Zero Gamma 基本不可靠。

`gexData.all` 中：

- MU 的 Zero Gamma 全日都是 `20`
- QQQ 的 Zero Gamma 全日都是 `562`
- 这两个位置都远离现价，没有实际日内分界意义
- SPY 的 Zero Gamma 在 `733/734` 附近有一点 regime 区分，但样本不足以证明通用有效

结论：当前 Zero Gamma 噪声很大，主要原因是算法找的是局部 strike GEX 翻转，而不是累计 GEX 穿零。

## 重要实现问题

`report.structureWalls` 和 `gexData.all` 里的墙位不是同一套信号。

报告路径使用实时 `gex`。历史图表路径使用静态 OI 计算出来的 `gexGlobal`。

这导致墙位几乎全量不一致：

- MU：`391/391` 个分钟点不一致
- QQQ：`379/391` 个分钟点不一致
- SPY：`391/391` 个分钟点不一致

这意味着文字报告和图表墙位可能互相矛盾。

## 最终结论

### 有价值的信号

- `|netGEX|` 对波动状态有一定解释力，尤其 SPY 更明显。
- SPY 的 Call Wall 在 2026-06-26 有明确阻力特征。
- QQQ 和 MU 的 Put Wall 有目标位/磁吸作用，但不可靠地表现为支撑。

### 不可靠的信号

- DPI 不是稳定的独立方向信号。
- dealerNotional 不是稳定的独立方向信号。
- 当前 Zero Gamma 不可靠。
- Call Wall / Put Wall 不能脱离市场状态机械解释为阻力/支撑。

### 当前算法主要问题

- Zero Gamma 实现不符合累计 GEX 穿零的定义。
- 实时墙位和静态 OI 墙位在报告和图表中混用。
- dealerNotional 本质是压力场景敏感度，但界面和报告容易把它解读成方向压力。
- DPI 经常打到 `+100` 或 `-100`，饱和后信息量下降。
- 墙位解释缺少必要过滤条件，例如趋势、VWAP 位置、距离墙位、日内时间、实际波动状态。

## 后续改进建议

- 把 Zero Gamma 改成累计 GEX 曲线穿零，并限制在现价附近合理 strike 范围。
- 明确区分两类墙位：
  - 实时 flow-adjusted walls；
  - 静态 OI/global walls。
- 报告和图表要么使用同一套墙位，要么同时展示两套并清楚标注。
- dealerNotional 在被验证前，应标注为对冲敏感度，而不是方向信号。
- DPI 需要按 ticker、时间段、波动状态重新校准。
- 墙位验证应加入过滤条件：
  - spot 到墙位距离；
  - spot 与 VWAP 的关系；
  - 当前趋势；
  - 实际波动扩张/收缩；
  - 距离收盘时间。
- 在更多日期上扩展验证后，再决定是否使用固定阈值。

## 样本限制

本次验证只使用了：

- 一个交易日：`2026-06-26`
- 三个 ticker：`MU`、`QQQ`、`SPY`
- 总计 1173 个分钟点

5/15/30/60 分钟 forward return 样本之间高度重叠，不是完全独立样本。

因此，本报告能支持的结论是：在当前可用样本中，DPI、dealerNotional、Zero Gamma 不足以作为可靠独立方向信号。它不能证明长期统计优势，也不能证明长期无效。
