# Gravity Roles API

本文档说明 `gravityMap.gravityRoles` 的返回结构，供其他 APP 对接引力图角色和结构清晰度字段。

## 数据位置

凡是返回 `gravityMap` 的接口，都可以从下面路径读取角色数据：

```txt
gravityMap.gravityRoles
```

典型接口：

```txt
GET /api/gravity-state?ticker=<TICKER>&range=<RANGE>
```

其中 `range` 支持：

```txt
today | near | all
```

如果当前没有可用引力图，`gravityMap` 可能为 `null`。对接方需要做空值保护。

## 顶层结构

```json
{
  "gravityMap": {
    "date": "2026-07-16",
    "time": "09:33",
    "sec": 34380,
    "spot": 327.71,
    "strikes": [320, 322.5, 325, 327.5, 330],
    "liveGravityCurve": [56.8, 69.0, 230.06, 60.55, 160.56],
    "openingGravityCurve": [54.1, 65.2, 210.83, 48.39, 128.72],
    "gravityRoles": {
      "trend": {},
      "structure": {},
      "magnetTarget": {},
      "supportPole": {},
      "pin": {},
      "upperMagnetTarget": {},
      "lowerMagnetTarget": {}
    }
  }
}
```

## 核心概念

`gravityRoles` 不是交易信号本身，而是对当前引力图价位的角色解释。

| 字段 | 中文名 | 含义 |
| --- | --- | --- |
| `magnetTarget` | 牵引目标 | 当前结构下最值得观察的目标引力位。它不是保证到达的价格。接近目标区也可以视为有指引效果。 |
| `supportPole` | 支撑磁极 | 当前价格下方的主要承接/回踩观察位。价格跌破后，角色可能变化。 |
| `pin` | 定锚吸附区 | 现价附近的吸附/横盘/反复拉扯区域。可能为空。 |
| `upperMagnetTarget` | 上方候选引力 | 不考虑最终角色选择时，现价上方的候选强引力位。 |
| `lowerMagnetTarget` | 下方候选引力 | 不考虑最终角色选择时，现价下方的候选强引力位。 |
| `trend` | 价格短线方向 | 用已有历史价格估算的 5/15 分钟方向。 |
| `structure` | 结构清晰度 | 独立的图形清晰度评分。不参与 Target/Support/Pin 的计算。 |

重要语义：

- `Target` 表示“目标观察位”，不是“100% 必到价”。
- `Support` 表示“下方承接观察位”，不是“必然守住”。
- `Pin` 表示“当前附近容易吸附或拉扯”，不是永久固定。
- `structure.score` 只用于辅助判断这张图是否清晰，不会改变角色点位。

## trend 字段

示例：

```json
{
  "direction": "up",
  "label": "偏上",
  "pct5m": 0.4,
  "pct15m": 0.31,
  "recentRangePct": 1.16,
  "strikeSpacingPct": 0.48
}
```

字段说明：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `direction` | string | 方向枚举：`up`、`down`、`flat`。 |
| `label` | string | 中文展示：`偏上`、`偏下`、`横盘`、`方向不足`。 |
| `pct5m` | number/null | 当前价格相对 5 分钟前的涨跌幅百分比。单位是 `%`。 |
| `pct15m` | number/null | 当前价格相对 15 分钟前的涨跌幅百分比。单位是 `%`。 |
| `recentRangePct` | number | 最近约 15 分钟价格高低波动范围。单位是 `%`。 |
| `strikeSpacingPct` | number | 当前行权价中位间距相对现价的比例。单位是 `%`。 |

注意：

- 刚开盘前几分钟历史不足，`pct5m`、`pct15m` 会使用已有最早价格兜底，参考价值较弱。
- `trend` 是短线方向，不等于全天趋势。

## structure 字段

`structure` 是独立的结构清晰度评分，用来判断当前引力图形态是否适合重点观察。

示例：

```json
{
  "available": true,
  "isClear": true,
  "type": "CLEAR",
  "label": "结构清晰",
  "reason": "主峰较明显，强峰数量少，曲线方向较一致",
  "score": 83,
  "confirmed": false,
  "clearMinutes": 2,
  "rangePct": 3,
  "dominance": 1.43,
  "strongPeakCount": 2,
  "signFlipCount": 0,
  "topPeak": {
    "strike": 325,
    "gravityMillions": 230.06,
    "distancePct": -0.83,
    "sign": "positive"
  },
  "secondPeak": {
    "strike": 330,
    "gravityMillions": 160.56,
    "distancePct": 0.7,
    "sign": "positive"
  },
  "rules": {
    "rangePct": 3,
    "dominanceClear": 1.35,
    "strongPeakRatio": 0.6,
    "maxStrongPeaks": 3,
    "maxSignFlips": 1,
    "confirmMinutes": 5
  }
}
```

### structure 字段说明

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `available` | boolean | 是否有足够数据计算结构。现价 ±3% 内至少需要 2 个有效引力峰。 |
| `score` | number | 结构清晰度分数，范围 `0-100`。越高表示图形越集中、越清晰。 |
| `type` | string | 结构分类枚举，见下方说明。 |
| `label` | string | 中文展示文案。 |
| `reason` | string | 简短解释。 |
| `isClear` | boolean | 当前这一帧是否满足“结构清晰”的图形规则。 |
| `confirmed` | boolean | 是否连续清晰达到确认分钟数。当前规则是连续 `5` 分钟。 |
| `clearMinutes` | number | 当前连续结构清晰的分钟数。只在有历史回放/历史快照上下文时更准确。 |
| `rangePct` | number | 结构评分观察范围。当前为现价上下 `3%`。 |
| `dominance` | number/null | 主峰优势：现价 ±3% 内第一大绝对 GEX 峰 / 第二大绝对 GEX 峰。 |
| `strongPeakCount` | number | 强峰数量：绝对 GEX 不低于主峰 `60%` 的峰数量。 |
| `signFlipCount` | number | 有效峰按 strike 排序后的正负 GEX 切换次数。 |
| `topPeak` | object/null | 现价 ±3% 内绝对 GEX 最大的峰。 |
| `secondPeak` | object/null | 现价 ±3% 内绝对 GEX 第二大的峰。 |
| `rules` | object | 当前评分规则参数，方便对接方展示或调试。 |

### structure.type 枚举

| type | label | 含义 |
| --- | --- | --- |
| `CLEAR` | `结构清晰` | 主峰优势明显，强峰数量少，正负切换少。 |
| `WEAK_EDGE` | `优势不明显` | 主峰相对第二峰优势不足，容易上下拉扯。 |
| `RANGE_TUG` | `区间拉扯` | 现价附近强峰过多，价格可能在区间内反复。 |
| `FRAGMENTED` | `结构破碎` | 现价附近正负 GEX 反复切换，方向不统一。 |
| `WEAK` | `结构一般` | 有一定参考价值，但不够集中。 |
| `INSUFFICIENT` | `结构不足` | 数据不足，无法可靠评分。 |

### structure 评分规则

当前版本只看图形形态，不接入额外数据源。

观察范围：

```txt
现价上下 ±3%
```

结构清晰规则：

```txt
dominance >= 1.35
strongPeakCount <= 3
signFlipCount <= 1
```

连续确认规则：

```txt
confirmed = clearMinutes >= 5
```

评分由四部分组成：

| 维度 | 作用 |
| --- | --- |
| 主峰优势 `dominance` | 主峰越明显，分数越高。 |
| 强峰数量 `strongPeakCount` | 强峰越少，结构越集中。 |
| 正负切换 `signFlipCount` | 切换越少，曲线方向越统一。 |
| 连续分钟 `clearMinutes` | 结构清晰持续越久，稳定性越高。 |

## 角色对象字段

`magnetTarget`、`supportPole`、`pin`、`upperMagnetTarget`、`lowerMagnetTarget` 使用同一套对象结构。

示例：

```json
{
  "role": "MAGNET_TARGET",
  "strike": 330,
  "side": "above",
  "score": 0.541,
  "strength": 0.698,
  "distancePct": 0.7,
  "pinBandPct": 0.25,
  "holdBandPct": 0.31,
  "gravity": 160560000,
  "gravityMillions": 160.56,
  "sign": "positive",
  "reason": "上方强引力区，当前优先观察的牵引目标"
}
```

字段说明：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `role` | string | 角色枚举：`MAGNET_TARGET`、`SUPPORT_POLE`、`PIN`。 |
| `strike` | number | 行权价/引力价位。 |
| `side` | string | 相对现价位置：`above`、`below`、`near`。 |
| `score` | number | 角色选择内部得分。用于排序参考，不建议直接当成交易强度。 |
| `strength` | number | 当前图内归一化强度，范围约 `0-1`。1 表示当前参与计算的最大绝对 GEX 峰。 |
| `distancePct` | number | 该 strike 相对现价的距离百分比。正数在上方，负数在下方。 |
| `pinBandPct` | number | 当前动态 Pin 吸附半径。单位是 `%`。 |
| `holdBandPct` | number | 当前动态 hold anchor 半径。单位是 `%`。 |
| `gravity` | number | 该 strike 的原始实时 GEX 数值。 |
| `gravityMillions` | number | `gravity` 按百万缩放后的数值，适合 UI 展示。 |
| `sign` | string | GEX 符号：`positive`、`negative`、`neutral`。 |
| `reason` | string | 当前角色的中文解释。 |

这些角色字段可能为 `null`。例如当前没有有效 Pin 时：

```json
{
  "pin": null
}
```

## 推荐展示方式

### 简洁版

```txt
牵引目标: $330
下方支撑: $325
定锚区: $327.5
结构清晰度: 83 分，结构清晰
```

### 带风险语义版

```txt
当前牵引目标: $330
下方支撑磁极: $325
现价定锚区: $327.5
价格方向: 偏上
结构清晰度: 83 分，结构清晰
```

### 根据 structure.score 做展示层级

建议对接方只把 `score` 当作 UI 辅助，不要改变 API 原始角色。

| score | 建议展示 |
| --- | --- |
| `80-100` | 强调为“结构清晰”，Target 更值得重点观察。 |
| `60-79` | 显示为“结构一般/可观察”。 |
| `40-59` | 显示为“优势不明显/区间拉扯”。 |
| `0-39` | 显示为“结构弱/仅参考”。 |

## 示例：AAPL 结构清晰

```json
{
  "trend": {
    "direction": "flat",
    "label": "横盘",
    "pct5m": 0.02,
    "pct15m": 0.02,
    "recentRangePct": 0.4,
    "strikeSpacingPct": 0.76
  },
  "structure": {
    "score": 83,
    "label": "结构清晰",
    "type": "CLEAR",
    "isClear": true,
    "confirmed": false,
    "clearMinutes": 2,
    "dominance": 1.43,
    "strongPeakCount": 2,
    "signFlipCount": 0
  },
  "magnetTarget": {
    "strike": 330,
    "side": "above",
    "gravityMillions": 160.56
  },
  "supportPole": {
    "strike": 325,
    "side": "below",
    "gravityMillions": 230.06
  },
  "pin": {
    "strike": 327.5,
    "side": "near",
    "gravityMillions": 60.55
  }
}
```

解读：

```txt
AAPL 当时不是把最深的 325 当成下行目标，而是：
330 = 当前牵引目标
325 = 下方支撑磁极
327.5 = 现价附近弱定锚
结构分数 83，说明图形相对清晰。
```

## 示例：AMD 优势不明显

```json
{
  "structure": {
    "score": 51,
    "label": "优势不明显",
    "type": "WEAK_EDGE",
    "isClear": false,
    "confirmed": false,
    "clearMinutes": 0,
    "dominance": 1.15,
    "strongPeakCount": 3,
    "signFlipCount": 0
  },
  "magnetTarget": {
    "strike": 522.5,
    "side": "above"
  },
  "supportPole": {
    "strike": 515,
    "side": "below"
  },
  "pin": {
    "strike": 517.5,
    "side": "near"
  }
}
```

解读：

```txt
AMD 仍然会返回 Target/Support/Pin，
但 structure.score 只有 51，label 是“优势不明显”。
对接方应该把它展示成区间观察/弱指引，而不是强方向。
```

## 对接注意事项

1. `gravityRoles` 是解释层，不是交易建议。
2. `structure` 是独立评分，不影响 `magnetTarget`、`supportPole`、`pin` 的计算。
3. `Target` 不是必到价，接近目标区也可以视为目标有指引效果。
4. `Pin`、`Support`、`Target` 会随着现价移动和 GEX 曲线变化而切换。
5. 其他 APP 做 UI 时，建议优先展示 `strike`、`label`、`score`，调试页再展示 `dominance`、`strongPeakCount`、`signFlipCount`。
6. 所有角色对象都可能为 `null`，必须做空值保护。

