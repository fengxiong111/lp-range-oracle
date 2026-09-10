import type { Ohlcv, RangeCandidate, TruthHandoff } from "../schema/types.js";

type Raw = { kind: "CORE" | "BUFFER"; strategy: string; lower: number; upper: number };
type Replay = RangeCandidate["replay"] & {
  density: number;
  capture: number;
  active: number;
  crossing: number;
  boundarySafety: number;
  structureFit: number;
};
type Regime = { trend: number; down: boolean; up: boolean; volWidth: number; tauHours: number };

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const valid = (x: number) => Number.isFinite(x) && x > 0;

function weightedQuantile(rows: Array<{ value: number; weight: number }>, q: number): number | null {
  const sorted = rows.filter((x) => valid(x.value) && x.weight > 0).sort((a, b) => a.value - b.value);
  if (!sorted.length) return null;
  const total = sorted.reduce((sum, x) => sum + x.weight, 0);
  let seen = 0;
  for (const row of sorted) {
    seen += row.weight;
    if (seen >= total * q) return row.value;
  }
  return sorted.at(-1)!.value;
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (values.length - 1));
}

function makeRange(kind: Raw["kind"], strategy: string, lo: number | null, hi: number | null, price: number): Raw | null {
  if (lo === null || hi === null || !valid(lo) || !valid(hi)) return null;
  let lower = Math.min(lo, hi);
  let upper = Math.max(lo, hi);
  lower = Math.min(lower, price * 0.995);
  upper = Math.max(upper, price * 1.005);
  return lower > 0 && upper > lower ? { kind, strategy, lower, upper } : null;
}

function unique(rows: Array<Raw | null>): Raw[] {
  const seen = new Set<string>();
  return rows.filter((row): row is Raw => Boolean(row)).filter((row) => {
    const key = `${row.kind}:${row.lower.toPrecision(6)}:${row.upper.toPrecision(6)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function detectRegime(ordered: Ohlcv[], price: number): Regime {
  const last24 = ordered.slice(-24);
  const trend = last24.length > 1 && last24[0].close > 0 ? last24.at(-1)!.close / last24[0].close - 1 : 0;
  const returns = ordered.slice(-73).flatMap((c, i, all) => (
    i > 0 && all[i - 1].close > 0 ? [Math.log(c.close / all[i - 1].close)] : []
  ));
  const daySigma = stdev(returns) * Math.sqrt(24);
  const volWidth = clamp(daySigma * 1.25, 0.06, 0.30);
  const down = trend < -0.03;
  const up = trend > 0.03;
  const tauHours = down || up ? 36 : 72;
  return { trend, down, up, volWidth: valid(price) ? volWidth : 0.12, tauHours };
}

function replayCandidate(raw: Raw, candles: Ohlcv[], price: number, feeRate: number | null, regime: Regime): Replay {
  const ordered = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  const latest = ordered.at(-1)!.timestamp;
  let weightedVolume = 0;
  let weightedInRange = 0;
  let timeWeight = 0;
  let activeWeight = 0;
  let observedInRange = 0;
  let transitions = 0;
  let previousInside: boolean | null = null;

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

  const widthPct = ((raw.upper - raw.lower) / price) * 100;
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
    structureFit,
  };
}

function rank(rows: Raw[], candles: Ohlcv[], price: number, feeRate: number | null, regime: Regime) {
  const evaluated = rows.map((raw) => ({ raw, replay: replayCandidate(raw, candles, price, feeRate, regime) }));
  const maxDensity = Math.max(1, ...evaluated.map((x) => x.replay.density));
  return evaluated.map((item) => {
    const density = clamp(item.replay.density / maxDensity, 0, 1);
    const r = item.replay;
    const rawScore = item.raw.kind === "CORE"
      ? 0.30 * density + 0.20 * r.capture + 0.15 * r.active + 0.10 * r.crossing + 0.10 * r.boundarySafety + 0.15 * r.structureFit
      : 0.10 * density + 0.25 * r.capture + 0.25 * r.active + 0.05 * r.crossing + 0.15 * r.boundarySafety + 0.20 * r.structureFit;
    return { ...item, score: Math.round(rawScore * 1000) / 10 };
  }).sort((a, b) => b.score - a.score || (a.raw.upper - a.raw.lower) - (b.raw.upper - b.raw.lower));
}

export function searchRanges(t: TruthHandoff): { candidates: RangeCandidate[]; core: RangeCandidate | null; buffer: RangeCandidate | null } {
  const price = t.market.priceUsd;
  const candles = (t.history.ohlcv1h ?? []).filter((c) => valid(c.close) && valid(c.high) && valid(c.low) && c.timestamp > 0);
  if (price === null || !valid(price) || candles.length < 12) {
    const fallback = (kind: Raw["kind"], halfWidth: number): RangeCandidate => ({
      kind,
      strategy: "FALLBACK_STATIC_BLOCKED",
      lowerPriceUsd: price === null ? null : price * (1 - halfWidth),
      upperPriceUsd: price === null ? null : price * (1 + halfWidth),
      widthPct: halfWidth * 200,
      score: null,
      selected: false,
      replay: { sampleHours: candles.length || null, observedVolumeUsd: null, feeProxyUsd: null, weightedVolumeCapturePct: null, activeTimePct: null, crossingDensity: null, boundarySafetyPct: null, structureFitPct: null },
      failureState: "BLOCKED_EVIDENCE",
    });
    return { candidates: [fallback("CORE", 0.12), fallback("BUFFER", 0.30)], core: null, buffer: null };
  }

  const ordered = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  const regime = detectRegime(ordered, price);
  const latest = ordered.at(-1)!.timestamp;
  const positiveVolumes = ordered.map((x) => Math.max(0, x.volumeUsd || 0)).filter((x) => x > 0).sort((a, b) => a - b);
  const medianVolume = positiveVolumes.length ? positiveVolumes[Math.floor(positiveVolumes.length / 2)] : 1;
  const samples = ordered.map((c) => ({
    value: (c.high + c.low + c.close) / 3,
    weight: Math.exp(-Math.max(0, (latest - c.timestamp) / 3600) / regime.tauHours) * (0.15 + Math.max(0, c.volumeUsd || 0) / Math.max(1, medianVolume)),
  }));
  const q = (value: number) => weightedQuantile(samples, value);
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
    makeRange("CORE", "VOLUME_Q20_Q80", q(0.20), q(0.80), price),
    makeRange("CORE", "VOLUME_Q15_Q85", q(0.15), q(0.85), price),
    makeRange("CORE", "RECENT_24H_ENVELOPE", low24, high24, price),
    makeRange("CORE", "RECENT_48H_ENVELOPE", low48, high48, price),
    makeRange("CORE", `VOLATILITY_SKEW_${regime.down ? "DOWN" : regime.up ? "UP" : "NEUTRAL"}`, price * (1 - regime.volWidth * lowerSkewFactor), price * (1 + regime.volWidth * upperSkewFactor), price),
  ]);

  const feeRate = t.market.feeTier === null ? null : t.market.feeTier / 1_000_000;
  const coreRanked = rank(coreRaw, ordered, price, feeRate, regime);
  const winningCore = coreRanked[0] ?? null;
  const expand = winningCore ? Math.max((winningCore.raw.upper - winningCore.raw.lower) * 0.25, price * 0.04) : price * 0.10;
  const directionalLow = price * (1 - regime.volWidth * (regime.down ? 1.75 : 1.10));
  const directionalHigh = price * (1 + regime.volWidth * (regime.up ? 1.75 : 1.10));

  const bufferRaw = unique([
    makeRange("BUFFER", "VOLUME_Q05_Q95", q(0.05), q(0.95), price),
    makeRange("BUFFER", "VOLUME_Q02_Q98", q(0.02), q(0.98), price),
    makeRange("BUFFER", "RECENT_24H_SAFETY", low24 * 0.94, high24 * 1.06, price),
    makeRange("BUFFER", "RECENT_48H_SAFETY", low48 * 0.94, high48 * 1.06, price),
    winningCore ? makeRange("BUFFER", "CORE_PLUS_REVISIT_MARGIN", winningCore.raw.lower - expand, winningCore.raw.upper + expand, price) : null,
    winningCore ? makeRange("BUFFER", `VOLATILITY_BUFFER_${regime.down ? "DOWN" : regime.up ? "UP" : "NEUTRAL"}`, Math.min(directionalLow, winningCore.raw.lower - expand), Math.max(directionalHigh, winningCore.raw.upper + expand), price) : null,
  ]).filter((candidate) => !winningCore || (candidate.lower <= winningCore.raw.lower && candidate.upper >= winningCore.raw.upper));

  const bufferRanked = rank(bufferRaw, ordered, price, feeRate, regime);
  const convert = (item: { raw: Raw; replay: Replay; score: number }, selected: boolean): RangeCandidate => ({
    kind: item.raw.kind,
    strategy: item.raw.strategy,
    lowerPriceUsd: item.raw.lower,
    upperPriceUsd: item.raw.upper,
    widthPct: ((item.raw.upper - item.raw.lower) / price) * 100,
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
      structureFitPct: item.replay.structureFitPct,
    },
    failureState: null,
  });
  const core = coreRanked.map((item, i) => convert(item, i === 0));
  const buffer = bufferRanked.map((item, i) => convert(item, i === 0));
  return { candidates: [...core, ...buffer], core: core[0] ?? null, buffer: buffer[0] ?? null };
}
