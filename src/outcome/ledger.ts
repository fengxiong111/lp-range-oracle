import { createHash } from "node:crypto";
import type { OracleRange, OracleSnapshot, OutcomeState, ShadowOutcomeArtifact } from "./schema.js";

function overlapPct(a: OracleRange | null, b: OracleRange | null): number | null {
  if (!a || !b) return null;
  const intersection = Math.max(0, Math.min(a.upperPriceUsd, b.upperPriceUsd) - Math.max(a.lowerPriceUsd, b.lowerPriceUsd));
  const union = Math.max(a.upperPriceUsd, b.upperPriceUsd) - Math.min(a.lowerPriceUsd, b.lowerPriceUsd);
  if (union <= 0) return null;
  return Math.round((intersection / union) * 10000) / 100;
}

function stateAtPrice(price: number | null, core: OracleRange | null, buffer: OracleRange | null): OutcomeState {
  if (price === null) return "UNKNOWN";
  if (core && price >= core.lowerPriceUsd && price <= core.upperPriceUsd) return "CORE_SURVIVED";
  if (buffer && price >= buffer.lowerPriceUsd && price <= buffer.upperPriceUsd) return "BUFFER_SURVIVED";
  return core || buffer ? "OUT_OF_RANGE" : "UNKNOWN";
}

function key(snapshot: OracleSnapshot): string {
  return createHash("sha256")
    .update(JSON.stringify({
      schemaVersion: snapshot.schemaVersion,
      timestamp: snapshot.timestamp,
      request: snapshot.request,
      core: snapshot.core,
      buffer: snapshot.buffer,
      action: snapshot.decision.action,
    }))
    .digest("hex");
}

export function buildShadowOutcome(start: OracleSnapshot, end: OracleSnapshot): ShadowOutcomeArtifact {
  if (start.request.tokenAddress.toLowerCase() !== end.request.tokenAddress.toLowerCase()) {
    throw new Error("TOKEN_MISMATCH");
  }
  const startMs = Date.parse(start.timestamp);
  const endMs = Date.parse(end.timestamp);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) throw new Error("INVALID_TIME_WINDOW");

  const startPrice = start.token.priceUsd;
  const endPrice = end.token.priceUsd;
  const priceReturnPct = startPrice !== null && endPrice !== null && startPrice > 0
    ? Math.round((((endPrice / startPrice) - 1) * 100) * 10000) / 10000
    : null;

  return {
    schemaVersion: "lp-outcome-v0.1-shadow",
    mode: "SHADOW",
    decisionKey: key(start),
    observedAt: end.timestamp,
    start,
    end,
    observation: {
      elapsedSeconds: Math.floor((endMs - startMs) / 1000),
      priceReturnPct,
      startCoreStateAtEnd: stateAtPrice(endPrice, start.core, start.buffer),
      poolStable: start.request.pool?.toLowerCase() === end.request.pool?.toLowerCase(),
      actionStable: start.decision.action === end.decision.action,
      coreOverlapPct: overlapPct(start.core, end.core),
      bufferOverlapPct: overlapPct(start.buffer, end.buffer),
      confidenceDelta: start.decision.confidence !== null && end.decision.confidence !== null
        ? Math.round((end.decision.confidence - start.decision.confidence) * 10000) / 10000
        : null,
    },
    pnl: {
      actualFeesUsd: null,
      impermanentLossUsd: null,
      gasUsd: null,
      swapCostUsd: null,
      rebalanceCostUsd: null,
      netPnlUsd: null,
    },
    learning: {
      eligibleForParameterUpdate: false,
      reason: "SHADOW_NO_POSITION_TRUTH",
    },
    failureState: null,
  };
}
