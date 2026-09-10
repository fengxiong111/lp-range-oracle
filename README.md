# LP Range Oracle

独立、无状态的 LP 决策能力：`lp-truth-v1 -> Candidate Search / Replay -> Core / Buffer / Action`。

## 使用闭环

ChatGPT 只发 Token 地址 → 创建 `[LP_ORACLE] <EVM 地址>` Issue → GitHub Actions 云端执行 → checkout `lp-truth-gateway` 生成版本化 Truth Handoff → Oracle 搜索候选区间 → Issue 评论 `[LP_ORACLE_RESULT]` → 自动关闭 → ChatGPT 读取并输出极简结果。

默认分支 Issue Queue 只接受仓库 owner 创建的严格格式 Issue；权限仅 `contents: read`、`issues: write`。每次真实运行前强制通过 typecheck、unit tests、lint；Truth 与 Decision 职责分离。

## Artifact contract

当前版本 `lp-oracle-v3.3`。

核心算法：`STRUCTURE_AWARE_REPLAY_V2`。

- 从真实 1h OHLCV 生成多个 Core / Buffer 候选，而不是机械 ±5/±10/±20。
- 趋势结构明显时缩短历史衰减时间，近期数据权重更高。
- Replay 同时比较 recent-weighted volume capture、active time、crossing density、fee proxy、boundary safety、structure fit。
- 下跌结构对下侧生存空间加权；上涨结构对上侧空间加权；旧 7d 高成交区不能压过已确认的近期结构迁移。
- 默认资本分配 `70% Core / 30% Buffer`；只有验证证据足够时才允许其他比例。
- Evidence B 仍保持 `WAIT`：未取得 tick-density、真实 fee-growth、position-share 等 A-grade 证据前，不伪造 `ENTER`。

所有未知值为 `null`。失败态严格区分：`BLOCKED_DATA`、`BLOCKED_EVIDENCE`、`BLOCKED_AUTH`、`BLOCKED_EXECUTION`。

## Authority boundary

- `lp-truth-gateway`：世界现在是什么；负责 pool discovery、链上验证、OHLCV、source conflict、fee-tier、tick 等 Truth。
- `lp-range-oracle`：在已验证 Truth 上比较候选池/区间并输出决策，不直接抓市场数据。
- `lp-decision-os`：原 Raydium RWA 系统，保持独立，不作为本 Oracle 的运行依赖。

## 本地验证

```text
npm install
npm run typecheck
npm test
npm run lint
```

生产使用不要求本地电脑常驻。
