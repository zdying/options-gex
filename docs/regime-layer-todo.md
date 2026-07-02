# Regime Layer TODO

当前第一版只接回 `hasMacroEvent`，并暂时将以下实时状态固定为 `false`：

- `hasVolumeSpike`
- `hasVixGap`
- `hasAtrExpansion`

后续建议：

- `hasVolumeSpike`：开盘 15 分钟成交量与过去 20 日同窗口均值比较，超过 1.5 倍标记为 true。
- `hasVixGap`：读取 VIX 当前价与前收盘价，跳空幅度超过阈值标记为 true。
- `hasAtrExpansion`：计算当日 intraday range / ATR，超过阈值标记为 true。

这些状态只用于降低“引力参考度”，不直接修改引力曲线。
