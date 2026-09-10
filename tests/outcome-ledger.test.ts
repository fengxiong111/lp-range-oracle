import test from "node:test";
import assert from "node:assert/strict";
import { buildShadowOutcome } from "../src/outcome/ledger.js";
import type { OracleSnapshot } from "../src/outcome/schema.js";

const start: OracleSnapshot = {
  schemaVersion: "lp-oracle-v3.3",
  timestamp: "2026-09-10T08:09:11.224Z",
  request: { tokenAddress: "0x39dbed3a2bd333467115de45665cc57f813c4571", chain: "robinhood", pool: "0xEd50bDeeA8aDC232f159486192a4157281D722ff" },
  token: { priceUsd: 0.63 },
  decision: { action: "WAIT", confidence: 0.86 },
  core: { lowerPriceUsd: 0.612557333707266, upperPriceUsd: 0.8396924033660034 },
  buffer: { lowerPriceUsd: 0.42274337993565103, upperPriceUsd: 0.8964761707806878 },
};

const end: OracleSnapshot = {
  ...start,
  timestamp: "2026-09-10T08:10:11.224Z",
  token: { priceUsd: 0.64 },
  core: { lowerPriceUsd: 0.61, upperPriceUsd: 0.84 },
  buffer: { lowerPriceUsd: 0.42, upperPriceUsd: 0.90 },
};

test("shadow outcome is deterministic and fail-closed on profit truth", () => {
  const a = buildShadowOutcome(start, end);
  const b = buildShadowOutcome(start, end);
  assert.deepEqual(a, b);
  assert.equal(a.schemaVersion, "lp-outcome-v0.1-shadow");
  assert.equal(a.observation.elapsedSeconds, 60);
  assert.equal(a.observation.startCoreStateAtEnd, "CORE_SURVIVED");
  assert.equal(a.observation.poolStable, true);
  assert.equal(a.observation.actionStable, true);
  assert.equal(a.learning.eligibleForParameterUpdate, false);
  assert.equal(a.pnl.netPnlUsd, null);
  assert.ok(a.decisionKey.length === 64);
});

test("mismatched tokens are rejected", () => {
  assert.throws(() => buildShadowOutcome(start, { ...end, request: { ...end.request, tokenAddress: "0x0000000000000000000000000000000000000001" } }), /TOKEN_MISMATCH/);
});
