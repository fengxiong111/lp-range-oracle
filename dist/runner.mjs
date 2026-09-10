// src/adapters/public.ts
var now = () => (/* @__PURE__ */ new Date()).toISOString();
var blocked = (source, tier, address2, failureState, error) => ({ source, tier, status: "BLOCKED", fetchedAt: now(), chainId: null, tokenAddress: address2, poolAddress: null, payload: null, failureState, error });
async function json(url) {
  try {
    const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(6e3) });
    if (!r.ok) return { data: null, error: `HTTP_${r.status}` };
    return { data: await r.json(), error: null };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : "FETCH_FAILED" };
  }
}
async function fetchDexScreener(address2) {
  const r = await json(`https://api.dexscreener.com/latest/dex/tokens/${address2}`);
  const pairs = Array.isArray(r.data?.pairs) ? r.data.pairs : [];
  const p = pairs.find((x) => x.priceUsd && x.liquidity?.usd) ?? pairs[0];
  if (!p) return blocked("dexscreener", 3, address2, r.error ? "BLOCKED_EXECUTION" : "BLOCKED_DATA", r.error ?? "NO_POOL");
  return { source: "dexscreener", tier: 3, status: "READY", fetchedAt: now(), chainId: p.chainId ?? null, tokenAddress: address2, poolAddress: p.pairAddress ?? null, payload: { pair: p }, failureState: null, error: null };
}
async function fetchGecko(address2) {
  const networks = ["base", "eth", "arbitrum", "polygon", "optimism", "bsc"];
  for (const n of networks) {
    const r = await json(`https://api.geckoterminal.com/api/v2/networks/${n}/tokens/${address2}/pools?page=1`);
    if (Array.isArray(r.data?.data) && r.data.data.length) return { source: "geckoterminal", tier: 3, status: "READY", fetchedAt: now(), chainId: n, tokenAddress: address2, poolAddress: null, payload: { pools: r.data.data }, failureState: null, error: null };
  }
  return blocked("geckoterminal", 3, address2, "BLOCKED_DATA", "NO_PUBLIC_POOL_MATCH");
}
async function fetchConfigured(address2) {
  const e = process.env;
  return [e.OKX_API_KEY ? blocked("okx", 1, address2, "BLOCKED_EXECUTION", "ENDPOINT_NOT_CONFIGURED") : blocked("okx", 1, address2, "BLOCKED_AUTH", "API_KEY_NOT_CONFIGURED"), e.UNISWAP_API_KEY ? blocked("uniswap", 2, address2, "BLOCKED_EXECUTION", "INDEXER_ENDPOINT_NOT_CONFIGURED") : blocked("uniswap", 2, address2, "BLOCKED_AUTH", "API_KEY_NOT_CONFIGURED"), e.EVM_RPC_URL ? blocked("rpc", 2, address2, "BLOCKED_EXECUTION", "CHAIN_ROUTING_NOT_CONFIGURED") : blocked("rpc", 2, address2, "BLOCKED_AUTH", "RPC_NOT_CONFIGURED")];
}
var enhancementAdapters = (address2) => [blocked("revert", 4, address2, "BLOCKED_AUTH", "OPTIONAL_ADAPTER_NOT_CONFIGURED"), blocked("vfat", 4, address2, "BLOCKED_AUTH", "OPTIONAL_ADAPTER_NOT_CONFIGURED")];

// src/analytics/engine.ts
var num = (x) => {
  const n = typeof x === "number" ? x : typeof x === "string" && x.trim() ? Number(x) : NaN;
  return Number.isFinite(n) ? n : null;
};
var pairOf = (s) => s.source === "dexscreener" ? s.payload?.pair ?? null : null;
function candidate(kind, price, pair) {
  const width = kind === "CORE" ? 0.12 : 0.3;
  const v = num(pair?.volume?.h24) ?? num(pair?.volume?.h6) ?? num(pair?.volume?.h1);
  const hours = num(pair?.volume?.h24) !== null ? 24 : num(pair?.volume?.h6) !== null ? 6 : num(pair?.volume?.h1) !== null ? 1 : null;
  return { kind, strategy: "LEGACY_SOURCE_PROXY_STATIC", lowerPriceUsd: price === null ? null : price * (1 - width), upperPriceUsd: price === null ? null : price * (1 + width), widthPct: width * 200, score: price !== null && v !== null ? Math.min(100, Math.round(50 + Math.log10(Math.max(1, v)) * 8 - width * 30)) : null, selected: kind === "CORE", replay: { sampleHours: hours, observedVolumeUsd: v, feeProxyUsd: null, weightedVolumeCapturePct: null, activeTimePct: null, crossingDensity: null, boundarySafetyPct: null, structureFitPct: null }, failureState: price === null ? "BLOCKED_DATA" : "BLOCKED_EVIDENCE" };
}
function buildAnalysis(address2, sources, timestamp = (/* @__PURE__ */ new Date()).toISOString()) {
  const ready = sources.filter((s) => s.status === "READY");
  const primary = ready.find((s) => s.source === "okx") ?? ready.find((s) => s.source === "uniswap" || s.source === "rpc") ?? ready.find((s) => s.source === "geckoterminal") ?? ready.find((s) => s.source === "dexscreener") ?? null;
  const pair = ready.map(pairOf).find(Boolean);
  const price = num(pair?.priceUsd);
  const candidates = [candidate("CORE", price, pair), candidate("BUFFER", price, pair)];
  const selected = price === null ? null : candidates[0];
  const hardData = price === null ? "BLOCKED_DATA" : "BLOCKED_EVIDENCE";
  return { schemaVersion: "lp-oracle-v3.3", request: { tokenAddress: address2, chain: primary?.chainId ?? null, pool: primary?.poolAddress ?? null }, timestamp, validation: { input: "VALID_EVM_ADDRESS", sourcesReady: ready.length, evidenceGrade: ready.length ? "C" : "D" }, failureState: hardData, evidence: { primarySource: primary?.source ?? null, sourceCount: ready.length, notes: ["Direct-source path is compatibility fallback only; preferred path consumes lp-truth-v1.", "Static ranges are explicitly BLOCKED_EVIDENCE; structure-aware replay requires typed historical truth."] }, token: { name: pair?.baseToken?.name ?? null, symbol: pair?.baseToken?.symbol ?? null, priceUsd: price, marketCapUsd: num(pair?.marketCap) }, sources, search: { engine: "STRUCTURE_AWARE_REPLAY_V2", candidatesEvaluated: 0, coreStrategy: null, bufferStrategy: null }, candidates, decision: { action: "WAIT", selected: selected?.kind ?? null, score: selected?.score ?? null, confidence: selected?.score !== null ? 0.45 : null, allocation: { corePct: 70, bufferPct: 30, rationale: "DEFAULT_70_30_UNLESS_VERIFIED_EVIDENCE_JUSTIFIES_OVERRIDE" }, failureState: hardData } };
}

// src/index.ts
async function analyzeToken(address2) {
  const sources = [...await fetchConfigured(address2), await fetchGecko(address2), await fetchDexScreener(address2), ...enhancementAdapters(address2)];
  return buildAnalysis(address2, sources);
}

// src/analytics/range-search.ts
var clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
var valid = (x) => Number.isFinite(x) && x > 0;
function weightedQuantile(rows, q) {
  const sorted = rows.filter((x) => valid(x.value) && x.weight > 0).sort((a, b) => a.value - b.value);
  if (!sorted.length) return null;
  const total = sorted.reduce((sum, x) => sum + x.weight, 0);
  let seen = 0;
  for (const row of sorted) {
    seen += row.weight;
    if (seen >= total * q) return row.value;
  }
  return sorted.at(-1).value;
}
function stdev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (values.length - 1));
}
function makeRange(kind, strategy, lo, hi, price) {
  if (lo === null || hi === null || !valid(lo) || !valid(hi)) return null;
  let lower = Math.min(lo, hi);
  let upper = Math.max(lo, hi);
  lower = Math.min(lower, price * 0.995);
  upper = Math.max(upper, price * 1.005);
  return lower > 0 && upper > lower ? { kind, strategy, lower, upper } : null;
}
function unique(rows) {
  const seen = /* @__PURE__ */ new Set();
  return rows.filter((row) => Boolean(row)).filter((row) => {
    const key = `${row.kind}:${row.lower.toPrecision(6)}:${row.upper.toPrecision(6)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function detectRegime(ordered, price) {
  const last24 = ordered.slice(-24);
  const trend = last24.length > 1 && last24[0].close > 0 ? last24.at(-1).close / last24[0].close - 1 : 0;
  const returns = ordered.slice(-73).flatMap((c, i, all) => i > 0 && all[i - 1].close > 0 ? [Math.log(c.close / all[i - 1].close)] : []);
  const daySigma = stdev(returns) * Math.sqrt(24);
  const volWidth = clamp(daySigma * 1.25, 0.06, 0.3);
  const down = trend < -0.03;
  const up = trend > 0.03;
  const tauHours = down || up ? 36 : 72;
  return { trend, down, up, volWidth: valid(price) ? volWidth : 0.12, tauHours };
}
function replayCandidate(raw, candles, price, feeRate, regime) {
  const ordered = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  const latest = ordered.at(-1).timestamp;
  let weightedVolume = 0;
  let weightedInRange = 0;
  let timeWeight = 0;
  let activeWeight = 0;
  let observedInRange = 0;
  let transitions = 0;
  let previousInside = null;
  for (const candle of ordered) {
    const ageHours = Math.max(0, (latest - candle.timestamp) / 3600);
    const decay = Math.exp(-ageHours / regime.tauHours);
    const low = Math.min(candle.low, candle.high);
    const high = Math.max(candle.low, candle.high);
    const span = Math.max(high - low, candle.close * 1e-6);
    const overlap = Math.max(0, Math.min(high, raw.upper) - Math.max(low, raw.lower));
    const fraction = clamp(overlap / span, 0, 1);
    const inside = candle.close >= raw.lower && candle.close <= raw.upper;
    const volume = Math.max(0, candle.volumeUsd || 0);
    weightedVolume += volume * decay;
    weightedInRange += volume * decay * fraction;
    observedInRange += volume * fraction;
    timeWeight += decay;
    if (fraction > 0) activeWeight += decay;
    if (previousInside !== null && inside !== previousInside) transitions += 1;
    previousInside = inside;
  }
  const widthPct = (raw.upper - raw.lower) / price * 100;
  const capture = weightedVolume > 0 ? weightedInRange / weightedVolume : 0;
  const active = timeWeight > 0 ? activeWeight / timeWeight : 0;
  const crossing = ordered.length > 1 ? transitions / (ordered.length - 1) : 0;
  const density = widthPct > 0 ? weightedInRange / widthPct : 0;
  const normalizer = Math.max(price * regime.volWidth, price * 0.03);
  const downside = clamp((price - raw.lower) / normalizer, 0, 1);
  const upside = clamp((raw.upper - price) / normalizer, 0, 1);
  const boundarySafety = clamp(Math.min(price - raw.lower, raw.upper - price) / normalizer, 0, 1);
  const structureFit = regime.down ? downside : regime.up ? upside : Math.min(downside, upside);
  return {
    sampleHours: ordered.length > 1 ? Math.round((latest - ordered[0].timestamp) / 3600) + 1 : 1,
    observedVolumeUsd: observedInRange,
    feeProxyUsd: feeRate === null ? null : observedInRange * feeRate,
    weightedVolumeCapturePct: capture * 100,
    activeTimePct: active * 100,
    crossingDensity: crossing * 100,
    boundarySafetyPct: boundarySafety * 100,
    structureFitPct: structureFit * 100,
    density,
    capture,
    active,
    crossing,
    boundarySafety,
    structureFit
  };
}
function rank(rows, candles, price, feeRate, regime) {
  const evaluated = rows.map((raw) => ({ raw, replay: replayCandidate(raw, candles, price, feeRate, regime) }));
  const maxDensity = Math.max(1, ...evaluated.map((x) => x.replay.density));
  return evaluated.map((item) => {
    const density = clamp(item.replay.density / maxDensity, 0, 1);
    const r = item.replay;
    const rawScore = item.raw.kind === "CORE" ? 0.3 * density + 0.2 * r.capture + 0.15 * r.active + 0.1 * r.crossing + 0.1 * r.boundarySafety + 0.15 * r.structureFit : 0.1 * density + 0.25 * r.capture + 0.25 * r.active + 0.05 * r.crossing + 0.15 * r.boundarySafety + 0.2 * r.structureFit;
    return { ...item, score: Math.round(rawScore * 1e3) / 10 };
  }).sort((a, b) => b.score - a.score || a.raw.upper - a.raw.lower - (b.raw.upper - b.raw.lower));
}
function searchRanges(t) {
  const price = t.market.priceUsd;
  const candles = (t.history.ohlcv1h ?? []).filter((c) => valid(c.close) && valid(c.high) && valid(c.low) && c.timestamp > 0);
  if (price === null || !valid(price) || candles.length < 12) {
    const fallback = (kind, halfWidth) => ({
      kind,
      strategy: "FALLBACK_STATIC_BLOCKED",
      lowerPriceUsd: price === null ? null : price * (1 - halfWidth),
      upperPriceUsd: price === null ? null : price * (1 + halfWidth),
      widthPct: halfWidth * 200,
      score: null,
      selected: false,
      replay: { sampleHours: candles.length || null, observedVolumeUsd: null, feeProxyUsd: null, weightedVolumeCapturePct: null, activeTimePct: null, crossingDensity: null, boundarySafetyPct: null, structureFitPct: null },
      failureState: "BLOCKED_EVIDENCE"
    });
    return { candidates: [fallback("CORE", 0.12), fallback("BUFFER", 0.3)], core: null, buffer: null };
  }
  const ordered = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  const regime = detectRegime(ordered, price);
  const latest = ordered.at(-1).timestamp;
  const positiveVolumes = ordered.map((x) => Math.max(0, x.volumeUsd || 0)).filter((x) => x > 0).sort((a, b) => a - b);
  const medianVolume = positiveVolumes.length ? positiveVolumes[Math.floor(positiveVolumes.length / 2)] : 1;
  const samples = ordered.map((c) => ({
    value: (c.high + c.low + c.close) / 3,
    weight: Math.exp(-Math.max(0, (latest - c.timestamp) / 3600) / regime.tauHours) * (0.15 + Math.max(0, c.volumeUsd || 0) / Math.max(1, medianVolume))
  }));
  const q = (value) => weightedQuantile(samples, value);
  const last24 = ordered.slice(-24);
  const last48 = ordered.slice(-48);
  const low24 = Math.min(...last24.map((x) => x.low));
  const high24 = Math.max(...last24.map((x) => x.high));
  const low48 = Math.min(...last48.map((x) => x.low));
  const high48 = Math.max(...last48.map((x) => x.high));
  const lowerSkewFactor = regime.down ? 1.35 : regime.up ? 0.75 : 1;
  const upperSkewFactor = regime.up ? 1.35 : regime.down ? 0.75 : 1;
  const coreRaw = unique([
    makeRange("CORE", "VOLUME_Q25_Q75", q(0.25), q(0.75), price),
    makeRange("CORE", "VOLUME_Q20_Q80", q(0.2), q(0.8), price),
    makeRange("CORE", "VOLUME_Q15_Q85", q(0.15), q(0.85), price),
    makeRange("CORE", "RECENT_24H_ENVELOPE", low24, high24, price),
    makeRange("CORE", "RECENT_48H_ENVELOPE", low48, high48, price),
    makeRange("CORE", `VOLATILITY_SKEW_${regime.down ? "DOWN" : regime.up ? "UP" : "NEUTRAL"}`, price * (1 - regime.volWidth * lowerSkewFactor), price * (1 + regime.volWidth * upperSkewFactor), price)
  ]);
  const feeRate = t.market.feeTier === null ? null : t.market.feeTier / 1e6;
  const coreRanked = rank(coreRaw, ordered, price, feeRate, regime);
  const winningCore = coreRanked[0] ?? null;
  const expand = winningCore ? Math.max((winningCore.raw.upper - winningCore.raw.lower) * 0.25, price * 0.04) : price * 0.1;
  const directionalLow = price * (1 - regime.volWidth * (regime.down ? 1.75 : 1.1));
  const directionalHigh = price * (1 + regime.volWidth * (regime.up ? 1.75 : 1.1));
  const bufferRaw = unique([
    makeRange("BUFFER", "VOLUME_Q05_Q95", q(0.05), q(0.95), price),
    makeRange("BUFFER", "VOLUME_Q02_Q98", q(0.02), q(0.98), price),
    makeRange("BUFFER", "RECENT_24H_SAFETY", low24 * 0.94, high24 * 1.06, price),
    makeRange("BUFFER", "RECENT_48H_SAFETY", low48 * 0.94, high48 * 1.06, price),
    winningCore ? makeRange("BUFFER", "CORE_PLUS_REVISIT_MARGIN", winningCore.raw.lower - expand, winningCore.raw.upper + expand, price) : null,
    winningCore ? makeRange("BUFFER", `VOLATILITY_BUFFER_${regime.down ? "DOWN" : regime.up ? "UP" : "NEUTRAL"}`, Math.min(directionalLow, winningCore.raw.lower - expand), Math.max(directionalHigh, winningCore.raw.upper + expand), price) : null
  ]).filter((candidate2) => !winningCore || candidate2.lower <= winningCore.raw.lower && candidate2.upper >= winningCore.raw.upper);
  const bufferRanked = rank(bufferRaw, ordered, price, feeRate, regime);
  const convert = (item, selected) => ({
    kind: item.raw.kind,
    strategy: item.raw.strategy,
    lowerPriceUsd: item.raw.lower,
    upperPriceUsd: item.raw.upper,
    widthPct: (item.raw.upper - item.raw.lower) / price * 100,
    score: item.score,
    selected,
    replay: {
      sampleHours: item.replay.sampleHours,
      observedVolumeUsd: item.replay.observedVolumeUsd,
      feeProxyUsd: item.replay.feeProxyUsd,
      weightedVolumeCapturePct: item.replay.weightedVolumeCapturePct,
      activeTimePct: item.replay.activeTimePct,
      crossingDensity: item.replay.crossingDensity,
      boundarySafetyPct: item.replay.boundarySafetyPct,
      structureFitPct: item.replay.structureFitPct
    },
    failureState: null
  });
  const core = coreRanked.map((item, i) => convert(item, i === 0));
  const buffer = bufferRanked.map((item, i) => convert(item, i === 0));
  return { candidates: [...core, ...buffer], core: core[0] ?? null, buffer: buffer[0] ?? null };
}

// src/truth.ts
import { createHash } from "node:crypto";
var SOURCE_NAMES = /* @__PURE__ */ new Set(["okx", "uniswap", "rpc", "dexpaprika", "geckoterminal", "dexscreener", "revert", "vfat"]);
var primarySource = (t) => {
  const s = t.selectedPool?.source;
  return typeof s === "string" && SOURCE_NAMES.has(s) ? s : null;
};
function confidence(t, score) {
  if (score === null) return null;
  const base = { A: 0.9, B: 0.82, C: 0.65, D: 0.35 }[t.evidence.grade];
  const freshness = t.evidence.freshnessSeconds;
  const freshnessPenalty = freshness === null ? 0.05 : freshness > 43200 ? 0.12 : freshness > 14400 ? 0.07 : freshness > 7200 ? 0.03 : 0;
  const conflictPenalty = Math.min(0.15, t.evidence.conflicts.length * 0.04);
  const wickPenalty = t.evidence.wickPenalty ? 0.05 : 0;
  const scorePenalty = score < 60 ? 0.08 : score < 75 ? 0.04 : 0;
  return Math.max(0.2, Math.min(0.95, Math.round((base - freshnessPenalty - conflictPenalty - wickPenalty - scorePenalty) * 100) / 100));
}
function buildAnalysisFromTruth(t) {
  const search = searchRanges(t);
  const ready = t.evidence.sources.filter((s) => s.status === "READY").length;
  const selected = t.failureState ? null : search.core;
  const blocked2 = t.failureState ?? (!search.core || !search.buffer ? "BLOCKED_EVIDENCE" : null);
  const conf = confidence(t, selected?.score ?? null);
  const gradeNote = t.evidence.grade === "A" ? "A-grade Truth achieved from canonical pool state + tick-density + verified fee-growth delta; execution authority remains separate, so this Oracle stays WAIT until an explicit ENTER gate exists." : "WAIT remains fail-closed below A-grade: tick-density/fee-growth or other required evidence is incomplete.";
  return {
    schemaVersion: "lp-oracle-v3.3",
    request: { tokenAddress: t.request.tokenAddress, chain: t.selectedPool?.chainId ?? null, pool: t.selectedPool?.poolAddress ?? null },
    timestamp: t.timestamp,
    validation: { input: "VALID_EVM_ADDRESS", sourcesReady: ready, evidenceGrade: t.evidence.grade },
    failureState: blocked2,
    evidence: {
      primarySource: primarySource(t),
      sourceCount: ready,
      notes: [
        "Consumed versioned lp-truth-v1 handoff; Oracle performs no market fetch in this path.",
        `Range engine=STRUCTURE_AWARE_REPLAY_V2; truth freshness=${t.evidence.freshnessSeconds ?? "unknown"}; conflicts=${t.evidence.conflicts.length}; wickPenalty=${t.evidence.wickPenalty}.`,
        "Replay penalizes current-price boundary risk and rewards regime-direction coverage; stale 7d volume cannot dominate a confirmed 24h structure shift.",
        gradeNote
      ]
    },
    token: { name: null, symbol: null, priceUsd: t.market.priceUsd, marketCapUsd: null },
    sources: [],
    search: { engine: "STRUCTURE_AWARE_REPLAY_V2", candidatesEvaluated: search.candidates.length, coreStrategy: selected?.strategy ?? null, bufferStrategy: t.failureState ? null : search.buffer?.strategy ?? null },
    candidates: search.candidates,
    decision: {
      action: "WAIT",
      selected: selected ? "CORE" : null,
      score: selected?.score ?? null,
      confidence: conf,
      allocation: { corePct: 70, bufferPct: 30, rationale: "DEFAULT_70_30_UNLESS_VERIFIED_EVIDENCE_JUSTIFIES_OVERRIDE" },
      failureState: blocked2
    },
    receipts: {
      decision: {
        inputSchemaVersion: "lp-truth-v1",
        inputHash: createHash("sha256").update(JSON.stringify(t)).digest("hex"),
        createdAt: t.timestamp,
        action: "WAIT",
        selected: selected ? "CORE" : null,
        failureState: blocked2
      }
    },
    truth: t
  };
}

// runner.ts
import { readFile } from "node:fs/promises";
var address = process.argv[2];
if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error("INVALID_EVM_ADDRESS");
var artifact = process.argv[3] ? buildAnalysisFromTruth(JSON.parse(await readFile(process.argv[3], "utf8"))) : await analyzeToken(address);
console.log(JSON.stringify(artifact, null, 2));
