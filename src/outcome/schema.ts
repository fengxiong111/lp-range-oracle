export type OutcomeState = "CORE_SURVIVED" | "BUFFER_SURVIVED" | "OUT_OF_RANGE" | "UNKNOWN";

export type OracleRange = {
  lowerPriceUsd: number;
  upperPriceUsd: number;
};

export type OracleSnapshot = {
  schemaVersion: string;
  timestamp: string;
  request: {
    tokenAddress: string;
    chain: string | null;
    pool: string | null;
  };
  token: { priceUsd: number | null };
  decision: {
    action: string;
    confidence: number | null;
  };
  core: OracleRange | null;
  buffer: OracleRange | null;
};

export type ShadowOutcomeArtifact = {
  schemaVersion: "lp-outcome-v0.1-shadow";
  mode: "SHADOW";
  decisionKey: string;
  observedAt: string;
  start: OracleSnapshot;
  end: OracleSnapshot;
  observation: {
    elapsedSeconds: number;
    priceReturnPct: number | null;
    startCoreStateAtEnd: OutcomeState;
    poolStable: boolean;
    actionStable: boolean;
    coreOverlapPct: number | null;
    bufferOverlapPct: number | null;
    confidenceDelta: number | null;
  };
  pnl: {
    actualFeesUsd: null;
    impermanentLossUsd: null;
    gasUsd: null;
    swapCostUsd: null;
    rebalanceCostUsd: null;
    netPnlUsd: null;
  };
  learning: {
    eligibleForParameterUpdate: false;
    reason: "SHADOW_NO_POSITION_TRUTH";
  };
  failureState: null;
};
