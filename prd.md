# Dealer Pressure Engine v2.0

基于做市商被迫对冲流的 0DTE/1DTE 市场结构分析系统

---

## 一、项目背景

目前市面上绝大多数期权分析工具，本质上都停留在三个层级：

**第一类：看 OI（Open Interest）**

例如：Call Wall、Put Wall、Max Pain、Gamma Exposure。

这些工具本质上是在研究：**历史沉淀筹码**。

**第二类：看订单流**

例如：Unusual Whales、Cheddar Flow、Blackbox。

这些工具研究：**谁在买 Call / 谁在买 Put**。

**第三类：看 Greeks**

例如：GEX、DEX、Vanna、Charm。

这些工具研究：**Dealer 当前的风险状态**。

但这些系统都有一个共同缺陷，它们无法回答最重要的问题：**接下来 30 分钟，做市商会不会被迫进入股票市场买卖股票？**

而价格真正的短期驱动力，往往来自：

- 主动资金（Active Flow）
- 做市商被迫对冲（Dealer Hedging）

因此本系统的目标不是预测价格。而是建立一个完整框架，实时估算：Dealer 未来会被迫买多少股票？Dealer 未来会被迫卖多少股票？Dealer 的力量是否足以影响市场？

---

## 二、系统总体架构

系统采用六层架构：

```
状态层 (Regime Layer)
        ↓
结构层 (Structure Layer)
        ↓
流量层 (Dealer Flow Layer)
        ↓
全场做市商层 (Dealer Aggregate Layer)
        ↓
价格验证层 (Price Layer)
        ↓
决策层 (Decision Layer)
```

其中：前五层全部属于原始数据层。最后一层属于解释层。**决策层永远不参与计算。**

---

## 三、第一层：状态层（Regime Layer）

### 目标

回答今天是谁在主导市场？是 Dealer Dominated，还是 Flow Dominated。

### 核心思想

Dealer 模型并非每天有效。例如 `CPI` / `FOMC` / `非农` / `NVDA财报` 等重大事件发生时，主动资金流量远大于 Dealer 对冲流。此时，Call Wall 可能失效，Gamma 模型可能失效，Dealer 会被市场拖着走。

### 输出指标

`Dealer Influence`，范围：0 ~ 100。例如：`85` 表示：今天 Dealer 拥有较强定价权。

### 输入数据

**宏观事件：** CPI、FOMC、NFP、GDP、PPI

**财报事件：** NVDA、AAPL、MSFT、META、TSLA

**市场实时数据：** VIX、VVIX、ATR、Volume

### 计算逻辑

初始化：

```
Score = 100
```

扣分规则：

| 条件                                    | 扣分 |
| --------------------------------------- | ---- |
| 重大事件发生                            | -40  |
| 开盘 15 分钟成交量超过 20 日均值 1.5 倍 | -20  |
| VIX 跳空                                | -20  |
| ATR 异常扩张                            | -20  |

最终输出：

```
Dealer Influence = Clamp(Score, 0, 100)
```

---

## 四、第二层：结构层（Structure Layer）

### 目标

回答：市场地形长什么样？

### 输入数据

全市场期权链：`Strike`、`OI`、`IV`、`Gamma`、`Delta`

### Step 1：构建 Dealer 持仓矩阵

由于无法直接获得 Dealer 仓位，需要根据 OI 进行估算：

```
Dealer_Call_Position = -Call_OI × OI_FACTOR
Dealer_Put_Position  = -Put_OI × OI_FACTOR

OI_FACTOR = 0.5（建议值）
```

### Step 2：盘中订单流修正

- 客户 Ask 扫单 Buy 1000 Call，Dealer 卖出：`Dealer_Position -= 1000`
- 客户 Ask 扫单 Buy 500 Put，Dealer 卖出：`Dealer_Position -= 500`

最终得到：`Dealer_Position(K)`

### Step 3：实时 Greek 计算

每次 Spot 变化，采用 Black-Scholes 实时重新计算：

```
Delta(K)
Gamma(K)
Charm(K)
Vanna(K)
```

### Step 4：计算 GEX

对于每个 Strike：

```
GEX(K) = Dealer_Position(K) × Gamma(K) × 100 × Spot² × 0.01
```

### Step 5：识别结构位

| 结构位     | 定义               |
| ---------- | ------------------ |
| Call Wall  | 最大正 GEX 位置    |
| Put Wall   | 最大负 GEX 位置    |
| Zero Gamma | GEX 累计值穿零位置 |

### 输出结果

`Call Wall`、`Put Wall`、`Zero Gamma`、`GEX Curve`

---

## 五、第三层：Dealer Flow Layer

### 目标

回答：最近的大单正在制造多少未来对冲压力？

这是整个系统的**核心升级**。

### 传统 OMI 的问题

旧版本：`Volume × Delta`

本质只是在看：谁在买、谁在卖。它没有回答：**Dealer 会不会被迫行动？**

### 新版思想

对于每笔订单，不再衡量成交量，而是衡量：**未来 Dealer 压力**。

### 输入数据

对于每笔大单：`Strike`、`Contracts`、`Direction`、`Dealer_Gamma`、`Dealer_Charm`、`Dealer_Vanna`

> 注意：所有 Greek 采用 Dealer 视角。

### 标准压力测试参数

为了避免预测未来，固定标准场景：

```
dS  = Spot × 0.5%
dt  = 30 分钟
dIV = -1%
```

### Pressure Shock 计算

根据 Taylor 展开：

```
Pressure_Shock = Contracts × 100 × (
    Dealer_Gamma × dS
  - Dealer_Charm × dt
  - Dealer_Vanna × dIV
)
```

含义：这笔订单未来会导致 Dealer 产生多少 Delta 变化。

### DPI 计算

维护最近 100 笔订单，线性衰减加权（最新权重 1.00，最旧权重最小，步长 0.01）：

```
Raw_DPI = Σ weight_i × Pressure_Shock_i
```

归一化：

```
DPI = Raw_DPI / 过去20日最大绝对值 × 100

限制范围：[-100, +100]
```

### DPI 解释

- `DPI > 0`：Dealer 未来偏买
- `DPI < 0`：Dealer 未来偏卖

---

## 六、第四层：Dealer Aggregate Layer

### 目标

回答：全市场 Dealer 未来会产生多少被迫交易？

### 聚合全部持仓

计算全市场总 Greek：

```
Total_Gamma
Total_Charm
Total_Vanna
```

### 各分项压力

```
Gamma_Pressure = Total_Gamma × dS
Charm_Pressure = Total_Charm × dt
Vanna_Pressure = Total_Vanna × dIV
```

### 总压力

```
Dealer_Pressure = Gamma_Pressure - Charm_Pressure - Vanna_Pressure
```

### 转换为名义金额

```
Dealer_Notional = Dealer_Pressure × Spot × 100
```

**输出示例：**

- Dealer Buy Pressure：+8 亿美元
- Dealer Sell Pressure：-12 亿美元

### 解读规则

> `Dealer Pressure` 不是**方向指标**，而是**加速度指标**。

| 价格方向 | Dealer Pressure | 含义           |
| -------- | --------------- | -------------- |
| 上涨     | > 0             | 上涨容易加速   |
| 上涨     | < 0             | 上涨容易减速   |
| 下跌     | < 0             | 下跌容易雪崩   |
| 下跌     | > 0             | 下跌容易被缓冲 |

---

## 七、第五层：价格验证层（Price Layer）

### 目标

回答：前面所有推演是否已经开始兑现？

### 输入

`Spot`、`VWAP`、`Volume`、`ATR`、`Trend`

### 核心作用

验证 Dealer 模型是否生效。

**示例一（模型生效）：**

```
Dealer Pressure = +10 亿美元，且 Price > VWAP
→ Dealer 买盘压力正在兑现
```

**示例二（模型暂时失效）：**

```
Dealer Pressure = +10 亿美元，但 Price < VWAP
→ 主动卖盘压过 Dealer，模型暂时失效
```

---

## 八、第六层：决策层（Decision Layer）

### 目标

生成最终交易解释。

### 输入

`Dealer Influence`、`Call Wall`、`Put Wall`、`Zero Gamma`、`DPI`、`Dealer Pressure`、`Spot`、`VWAP`

### 输出示例

```
当前模式：Dealer Dominated
Dealer Influence : 82
Call Wall        : 450
DPI              : +88
Dealer Pressure  : +9 亿美元
Price            : Above VWAP

结论：
  - Dealer 买盘压力正在兑现
  - 450 为第一目标位
  - 上涨加速概率较高
```

---

## 九、系统最终核心

整个系统最终浓缩为**三个核心数字**：

| 指标                 | 回答的问题                           |
| -------------------- | ------------------------------------ |
| **Dealer Influence** | 今天 Dealer 有没有资格影响市场       |
| **DPI**              | 最近机构订单流制造了多少未来对冲压力 |
| **Dealer Pressure**  | 全市场 Dealer 未来会产生多少被迫买卖 |

其余指标的定位：

- `Call Wall` / `Put Wall` / `Zero Gamma`：只是**地图**
- `VWAP` / `Price` / `Volume`：只是**验证器**

整个系统的终极目标不是预测价格。而是实时估算：未来 30 分钟到 2 小时内，做市商是否会因为风险管理需求，被迫进入现货市场进行大规模买卖。

---

## 工程落地的 3 个"隐形深水弹"

在动手写底层算法时，请务必让负责开发的程序员（或者你自己）死死盯住这三个工程细节，它们是量化系统在实盘里"回测完美，实盘亏光"的核心原因：

### 1. 0DTE 尾盘的希腊字母非线性爆炸（Greeks Flare-up）

**痛点：** 对于 0DTE 合约，在美东时间下午 3:30 之后，如果现价（Spot）极度逼近某个行权价，该行权价的 Gamma 和 Charm 会发生趋于无穷大的非线性飙升（数学上的奇点）。

**防雷代码：** 在 `bs_calculator.py` 中，必须加一层安全截断（Clamping）。当时间流逝 dt 趋近于 0（比如距离收盘只有 10 分钟），且期权极度接近平值（ATM）时，强制限制 Gamma 和 Charm 的输出最大值，否则第 3 层的 DPI 和第 4 层的总压力会被一两笔尾盘的末日单瞬间打到数据溢出。

### 2. DPI 归一化的"历史巨量污染"

**痛点：** 第 3 层中提到：`DPI = Raw_DPI / 过去20日最大绝对值 × 100`。这在统计学上很完美，但如果在过去 20 天里遇到了类似于"美联储突发暴击"或者"NVDA 财报日"这种极端行情，那某一天的 Raw_DPI 会大得惊人。

**后果：** 这会导致在此之后的 20 天里，系统计算出的日内 DPI 分值都会被强行压制在很小的范围内（比如一直在 $-10 \sim +10$ 之间晃悠），系统会变得极度迟钝。

**工程微调：** 不要用绝对最大值。改用过去 20 日日内 Raw_DPI 的 **95% 分位数（95th Percentile）** 进行归一化。把那 5% 的极端黑天鹅数据切掉，能保证系统在 95% 的普通交易日里保持极高和稳定的灵敏度。

### 3. 持仓矩阵的异步更新冲突（Race Conditions）

**痛点：** 第 2 层的静态地图是一天更新一次。但第 3 层的流式大单是盘中秒级注入并对地图进行增量修正的（`Dealer_Position -= 1000`）。

**工程微调：** 一定要将 `Dealer_Position(K)` 这个矩阵锁在高效内存（如 Redis 或线程安全的全局单例对象）中。每次第 3 层清洗出重炮大单时，以队列（Queue）的形式异步去修改这个矩阵，千万不能让高频大单的写入操作把全场 GEX 的读取重算给锁死卡顿。
