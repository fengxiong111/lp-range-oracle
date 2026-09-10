import type { Ohlcv, RangeCandidate, TruthHandoff } from "../schema/types.js";

type Raw = { kind: "CORE" | "BUFFER"; strategy: string; lower: number; upper: number };
type Replay = RangeCandidate["replay"] & {
  density: number;
  capture: number;
  active: number;
  crossing: number;
};

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

function makeRange(
  kind: Raw["kind"],
  strategy: string,
  lowerInput: number | null,
  upperInput: number | null,
  price: number,
): Raw | null {
  if (lowerInput === null || upperInput === null || !valid(lowerInput) || !valid(upperInput)) return null;
  let lower = Math.min(lowerInput, upperInput);
  let upper = Math.max(lowerInput, upperInput);
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

function replayCandidate(raw: Raw, candles: Ohlcv[], price: number, feeRate: number | null): Replay {
  const ordered = [...candles]
    .filter((c) => valid(c.high) && valid(c.low) && valid(c.close) && c.timestamp > 0)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (!ordered.length) {
    return {
      sampleHours: null,
      observedVolumeUsd: null,
      feeProxyUsd: null,
      weightedVolumeCapturePct: null,
      activeTimePct: null,
      crossingDensity: null,
      density: 0,
      capture: 0,
      active: 0,
      crossing: 0,
    };
  }

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
    const decay = Math.exp(-ageHours / 72);
    const low = Math.min(candle.low, candle.high);
    const high = Math.max(candle.low, candle.high);
    const span = Math.max(high - low, candle.close * 1e-6);
    const overlap = Math.max(0, Math.min(high, raw.upper) - Math.max(low, raw.lower));
    const overlapFraction = clamp(overlap / span, 0, 1);
    const inside = candle.close >= raw.lower && candle.close <= raw.upper;
    const volume = Math.max(0, candle.volumeUsd || 0);

    weightedVolume += volume * decay;
    weightedInRange += volume * decay * overlapFraction;
    observedInRange += volume * overlapFraction;
    timeWeight += decay;
    if (overlapFraction > 0) activeWeight += decay;
    if (previousInside !== null && inside !== previousInside) transitions += 1;
    previousInside = inside;
  }

  const widthPct = ((raw.upper - raw.lower) / price) * 100;
  const capture = weightedVolume > 0 ? weightedInRange / weightedVolume : 0;
  const active = timeWeight > 0 ? activeWeight / timeWeight : 0;
  const crossing = ordered.length > 1 ? transitions / (ordered.length - 1) : 0;
  const density = widthPct > 0 ? weightedInRange / widthPct : 0;

  return {
    sampleHours: ordered.length > 1 ? Math.round((latest - ordered[0].timestamp) / 3600) + 1 : 1,
    observedVolumeUsd: observedInRange,
    feeProxyUsd: feeRate === null ? null : observedInRange * feeRate,
    weightedVolumeCapturePct: capture * 100,
    activeTimePct: active * 100,
    crossingDensity: crossing * 100,
    density,
    capture,
    active,
    crossing,
  };
}

function rank(
  rows: Raw[],
  candles: Ohlcv[],
  price: number,
  feeRate: number | null,
): Array<{ raw: Raw; replay: Replay; score: number }> {
  const evaluated = rows.map((raw) => ({ raw, replay: replayCandidate(raw, candles, price, feeRate) }));
  const maxDensity = Math.max(1, ...evaluated.map((x) => x.replay.density));

  return evaluated.map((item) => {
    const density = clamp(item.replay.density / maxDensity, 0, 1);
    const r = item.replay;
    const rawScore = item.raw.kind === "CORE"
      ? 0.45 * density + 0.25 * r.capture + 0.20 * r.active + 0.10 * r.crossing
      : 0.20 * density + 0.35 * r.capture + 0.35 * r.active + 0.10 * r.crossing;
    return { ...item, score: Math.round(rawScore * 1000) / 10 };
  }).sort((a, b) => b.score - a.score || (a.raw.upper - a.raw.lower) - (b.raw.upper - b.raw.lower));
}

export function searchRanges(t: TruthHandoff): {
  candidates: RangeCandidate[];
  core: RangeCandidate | null;
  buffer: RangeCandidate | null;
} {
  const price = t.market.priceUsd;
  const candles = (t.history.ohlcv1h ?? []).filter((c) => valid(c.close) && valid(c.high) && valid(c.low));

  if (price === null || !valid(price) || candles.length < 12) {
    const fallback = (kind: Raw["kind"], halfWidth: number): RangeCandidate => ({
      kind,
      strategy: "FALLBACK_STATIC_BLOCKED",
      lowerPriceUsd: price === null ? null : price * (1 - halfWidth),
      upperPriceUsd: price === null ? null : price * (1 + halfWidth),
      widthPct: halfWidth * 200,
      score: null,
      selected: false,
      replay: {
        sampleHours: candles.length || null,
        observedVolumeUsd: null,
        feeProxyUsd: null,
        weightedVolumeCapturePct: null,
        activeTimePct: null,
        crossingDensity: null,
      },
      failureState: "BLOCKED_EVIDENCE",
    });
    return { candidates: [fallback("CORE", 0.12), fallback("BUFFER", 0.30)], core: null, buffer: null };
  }

  const ordered = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  const latest = ordered.at(-1)!.timestamp;
  const positiveVolumes = ordered.map((x) => Math.max(0, x.volumeUsd || 0)).filter((x) => x > 0).sort((a, b) => a - b);
  const medianVolume = positiveVolumes.length ? positiveVolumes[Math.floor(positiveVolumes.length / 2)] : 1;
  const samples = ordered.map((c) => ({
    value: (c.high + c.low + c.close) / 3,
    weight: Math.exp(-Math.max(0, (latest - c.timestamp) / 3600) / 72)
      * (0.15 + Math.max(0, c.volumeUsd || 0) / Math.max(1, medianVolume)),
  }));
  const q = (value: number) => weightedQuantile(samples, value);
  const last24 = ordered.slice(-24);
  const low24 = Math.min(...last24.map((x) => x.low));
  const high24 = Math.max(...last24.map((x) => x.high));
  const returns = ordered.slice(-73).flatMap((c, i, all) => (
    i > 0 && all[i - 1].close > 0 ? [Math.log(c.close / all[i - 1].close)] : []
  ));
  const daySigma = stdev(returns) * Math.sqrt(24);
  const volWidth = clamp(daySigma * 1.25, 0.06, 0.30);
  const trend = last24.length > 1 ? last24.at(-1)!.close / last24[0].close - 1 : 0;
  const down = trend < -0.03;
  const up = trend > 0.03;
  const lowerSkewFactor = down ? 1.35 : (up ? 0.75 : 1);
  const upperSkewFactor = up ? 1.35 : (down ? 0.75 : 1);

  const coreRaw = unique([
    makeRange("CORE", "VOLUME_Q25_Q75", q(0.25), q(0.75), price),
    makeRange("CORE", "VOLUME_Q20_Q80", q(0.20), q(0.80), price),
    makeRange("CORE", "VOLUME_Q15_Q85", q(0.15), q(0.85), price),
    makeRange("CORE", "RECENT_24H_ENVELOPE", low24, high24, price),
    makeRange(
      "CORE",
      `VOLATILITY_SKEW_${down ? "DOWN" : up ? "UP" : "NEUTRAL"}`,
      price * (1 - volWidth * lowerSkewFactor),
      price * (1 + volWidth * upperSkewFactor),
      price,
    ),
  ]);

  const feeRate = t.market.feeTier === null ? null : t.market.feeTier / 1_000_000;
  const coreRanked = rank(coreRaw, ordered, price, feeRate);
  const winningCore = coreRanked[0] ?? null;
  const expand = winningCore
    ? Math.max((winningCore.raw.upper - winningCore.raw.lower) * 0.25, price * 0.04)
    : price * 0.10;

  const bufferRaw = unique([
    makeRange("BUFFER", "VOLUME_Q05_Q95", q(0.05), q(0.95), price),
    makeRange("BUFFER", "VOLUME_Q02_Q98", q(0.02), q(0.98), price),
    makeRange("BUFFER", "RECENT_24H_SAFETY", low24 * 0.94, high24 * 1.06, price),
    winningCore
      ? makeRange("BUFFER", "CORE_PLUS_REVISIT_MARGIN", winningCore.raw.lower - expand, winningCore.raw.upper + expand, price)
      : null,
  ]).filter((candidate) => !winningCore || (
    candidate.lower <= winningCore.raw.lower && candidate.upper >= winningCore.raw.upper
  ));

  const bufferRanked = rank(bufferRaw, ordered, price, feeRate);
  const convert = (
    item: { raw: Raw; replay: Replay; score: number },
    selected: boolean,
  ): RangeCandidate => ({
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
    },
    failureState: null,
  });

  const core = coreRanked.map((item, i) => convert(item, i === 0));
  const buffer = bufferRanked.map((item, i) => convert(item, i === 0));
  return { candidates: [...core, ...buffer], core: core[0] ?? null, buffer: buffer[0] ?? null };
}
