# 周度引力图生成逻辑

这份文档说明周度引力 SVG 图片是如何生成的。

当前这张图是**结构摘要图**，不是完整的逐 strike 原始分布图。

## 数据来源

图表渲染器读取：

```text
data/weekly-gravity/<baseDate>/report.json
```

每个标的使用：

```js
report.tickers[ticker].windows.nextWeek
```

周度分析脚本会把完整计算结果写入 `report.json`。渲染器只负责决定如何把这些结果画出来。

## 结构摘要图 vs 完整分布图

当前图表**不会**绘制 `gravityCurve` 里的每一个 strike。

主图里的蓝色曲线来自一组摘要后的关键引力区：

```js
strongestWeightedGravityZones
nearGravityZones
upperGravityZones
lowerGravityZones
```

这些数组会按 strike 合并并去重。

例如，如果选出的关键引力区是：

```text
400, 410, 420, 430, 440
```

那么图表就绘制这些点。

如果 `near / upper / lower` 又补充了：

```text
405, 425, 450, 460
```

那么曲线绘制的点会变成：

```text
400, 405, 410, 420, 425, 430, 440, 450, 460
```

它**不会**因为最小值是 400、最大值是 460，就自动补齐中间所有 strike。

所以，即使真实期权链里每 5 美元有一个 strike，图表也不会自动绘制：

```text
400, 405, 410, 415, 420, 425, 430, ...
```

除非这些 strike 本身被选进上面的关键引力区数组。

## 图表展示了什么

这张图可以分成三层理解：

1. **分析层**
   周度分数、上下引力比例、关键引力区等，是基于完整期权链聚合结果计算出来的。

2. **摘要曲线层**
   主图用选出的关键引力区绘制平滑曲线。它的目标是展示市场结构，而不是展示每一个原始 strike。

3. **标注层**
   曲线上只标注最强的 weighted gravity zones。这样可以保持图面干净，不让所有点都挤在一起。

## 蓝色主曲线

蓝色曲线表示选中关键引力区的：

```js
weightedGravity
```

`weightedGravity` 是基于绝对引力，并按距离现价远近做过权重调整后的值。对于一周视角，越接近现价的引力通常越重要，所以它用于展示和评分。

蓝色填充区域使用的点和蓝色线相同。

在图表左右边界处，蓝色曲线会延伸到当前显示点中的最低 weighted-gravity 水平。这样可以避免在边缘画出误导性的高位平台，同时保持图形完整。

## 灰色细线

灰色细线表示同一批关键引力区的：

```js
netGravity
```

和蓝色曲线不同，灰色线保留引力的正负号：

- 正值在零轴上方。
- 负值在零轴下方。

灰色线是 signed structure 的参考线，不是主评分依据。

在图表左右边界处，灰色线会回到零轴。

## Spot 线

橙色虚线表示：

```js
tickerData.spot
```

如果空间允许，spot 文本会显示在虚线右侧。

## Upper / Lower / Near 表格

底部三个表格分别展示：

```js
upperGravityZones
lowerGravityZones
nearGravityZones
```

每个表格展示前三个区域。

每一行格式是：

```text
strike (distancePct%, weightedGravity, w distanceWeight)
```

这些表格是对应类别里最重要引力区的摘要。

`weightedGravity` 默认按百万为单位展示，但不显示 `M`，避免图上暴露过多底层量纲。

## Pull structure 文案

红蓝分布条下方不会展示内部的 `Weighted skew / Raw skew` 数值，而是展示用户更容易理解的结构说明：

```text
Pull structure: downside-heavy
Pull structure: upside-heavy
Pull structure: balanced
```

该文案由 `window.pullSkew` 自动映射：

```text
pullSkew <= -0.12  -> downside-heavy
pullSkew >=  0.12  -> upside-heavy
otherwise          -> balanced
```

这只是展示文案的转换，不改变底层评分和分析逻辑。

## 右上角评分环

右上角的评分环表示：

```js
window.score
```

原始 score 会映射成 1-10 档：

```js
level = ceil(((score + 1) / 2) * 10)
```

然后限制在：

```text
1 ... 10
```

大致含义是：

```text
1-3   偏弱 / 下行结构
4-6   均衡到轻微方向性
7-10  偏强 / 上行结构
```

项目采用“红涨绿跌”的视觉习惯：

- 低分使用绿色。
- 高分从黄/橙逐渐过渡到红色。

评分环由 10 个独立 SVG 分段组成。当前 level 以内的分段点亮，其余分段显示为灰色。

评分环旁边显示：

```text
<level>/10
Weak / Balanced / Strong / Very Strong
```

## 重要口径

当前这张图应该描述为：

```text
关键引力结构摘要图
```

而不是：

```text
完整逐 strike 引力分布图
```

完整 strike 数据仍然保存在 `report.json` 的 `gravityCurve` 中。  
如果未来需要展示某个价格窗口内的完整逐 strike 分布图，应该直接从 `gravityCurve` 渲染，而不是使用当前的关键 zones 合并结果。
