# LP Range Oracle

独立、无状态、multi-chain、API-first 的 LP 决策能力：`token / pool / position -> Verified LP Analysis Artifact`。

## 使用闭环

ChatGPT 只发地址 → 创建 `[LP_ORACLE] <EVM 地址>` Issue → GitHub Actions 云端执行 → Issue 评论 `[LP_ORACLE_RESULT]` typed artifact → ChatGPT 读取 → 输出极简 Core / Buffer / Action。

默认分支包含 Issue Queue workflow。它只接受仓库 owner 创建的、严格匹配标题的 Issue；权限仅 `contents: read`、`issues: write`。处理完成后自动评论并关闭 Issue。

## Artifact contract

当前版本 `lp-oracle-v3.1`。Artifact 固定包含 `schemaVersion`、`request`、`timestamp`、`validation`、`failureState`、`evidence`、`sources`、`candidates`、`decision`。所有未知值为 `null`。

失败态严格区分：`BLOCKED_DATA`（数据缺失）、`BLOCKED_EVIDENCE`（证据不足）、`BLOCKED_AUTH`（未配置授权）、`BLOCKED_EXECUTION`（适配器/执行配置未完成）。

数据层按可信度分层：OKX OnchainOS；Uniswap RPC + Indexer；GeckoTerminal / DexScreener fallback；Revert / VFAT enhancement adapters。Candidate Search、recent-weighted replay、Core/Buffer、action/confidence 都由核心引擎输出；没有证据时不会伪造 ENTER。

## 本地验证

```text
npm install
npm run typecheck
npm test
npm run lint
```

本仓库不包含 Raydium RWA 前后端、SQLite、钱包密钥或生产凭据。
