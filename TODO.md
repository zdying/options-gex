# TODO 待办事项 (由 Bug Review 衍生)

根据 `bug_review.md` 和 `bug.md` 遗留的讨论结论，以下项目被列入待办开发清单：

## 🟡 Medium (中等问题待优化)

- [ ] **性能优化：消除同步文件 I/O 阻塞事件循环 (Bug #9)**
  - **当前状态**：在 API 路由处理和定时器回调中使用了 `fs.readFileSync()` / `fs.writeFileSync()` 等同步方法（如大单数据读写、每20秒的 `history.json` 读写）。
  - **解决方案**：在非关键路径使用 `fs.promises` 异步读写，或使用流式传输 (Stream) 处理大型 JSON 文件。

- [ ] **做市商主导评级系统实际数据接入 (Bug #12)**
  - **当前状态**：`regimeManager` 目前所有标志位均为 mock (默认 false)，总是返回做市商定价权为 100。
  - **解决方案**：
    * **FOMC 日程**：直接在代码中静态硬编码（如 2026 年这 8 个会议日期），省去 API 对接的噪音干扰。
    * **CPI/非农(NFP)/PPI 日程**：对接 FRED API 的 `fred/release/dates` 接口，传入对应的 `release_id` (CPI 为 `10`, 非农为 `50`, PPI 为 `46`) 并启用 `include_release_dates_with_no_data=true` 动态拉取未来日程。
      - 完整请求 URL 范例：`https://api.stlouisfed.org/fred/release/dates?release_id=46&api_key=xxxx&file_type=json&include_release_dates_with_no_data=true&realtime_start=2026-06-01`（此处以 PPI 为例）
    * **波动率与成交量**：对接 VIX 指数及正股 K 线接口，对 `VolumeSpike`、`VixGap` 等进行实盘校验。

- [ ] **压力验证阈值评估与重测 (Bug #13)**
  - **当前状态**：已把 `priceVerifier.js` 的 `pressureThreshold` 默认值从 `1e-4` 提升到了 `1e4` (1万美元名义对冲压力)。
  - **后续跟进**：需要结合后续生产环境的实盘或历史重演数据，重新评估该阈值是否过大或过小，并进行适当的参数调优。
  - **建议优化方案**：
    * **方案 A (分标的定制阈值)**：对不同体量的股票配置不同的 `pressureThreshold`。例如：活跃度极高的指数 ETF（如 SPY/QQQ）可调大至 50 万美元（`5e5`），而普通正股（如 MU）可设为 5 万美元（`5e4`）。
    * **方案 B (成交量自适应动态阈值)**：使阈值动态化，绑定为该股票过去 20 天日均交易额 (ADTV) 的某个比例（例如 $0.01\%$），解决因股票体量差异造成的识别误差。

## 🟢 Low (低级优化)

- [ ] **`server.js` 单文件模块化拆分 (Bug #22)**
  - **当前状态**：`server.js` 包含 1600+ 行代码，承担了多重职责（路由、大单采集、希腊字母重算、回放控制器等）。
  - **解决方案**：将功能点拆分为 `routes/`、`services/`、`scheduler/`、`replay/` 等独立子模块，提升可维护性和单测编写便利度。

