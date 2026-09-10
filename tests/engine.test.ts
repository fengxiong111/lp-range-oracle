import test from "node:test";
import assert from "node:assert/strict";
import { buildAnalysis } from "../src/index.js";

const base={source:"dexscreener" as const,tier:3 as const,status:"READY" as const,fetchedAt:"2026-01-01T00:00:00Z",chainId:"base",tokenAddress:"0x39dbed3a2bd333467115de45665cc57f813c4571",poolAddress:"0xpool",payload:{pair:{baseToken:{name:"Pons",symbol:"PONS"},priceUsd:"0.65",marketCap:123,volume:{h24:1000}}},failureState:null,error:null};

test("legacy direct-source path is v3.2 compatibility-only and fail-closed",()=>{
  const x=buildAnalysis(base.tokenAddress,[base]);
  assert.equal(x.schemaVersion,"lp-oracle-v3.2");
  assert.equal(x.token.priceUsd,.65);
  assert.ok(Math.abs((x.candidates[0].lowerPriceUsd??0)-.572)<1e-12);
  assert.equal(x.candidates[0].strategy,"LEGACY_SOURCE_PROXY_STATIC");
  assert.equal(x.candidates[0].replay.feeProxyUsd,null);
  assert.equal(x.decision.action,"WAIT");
  assert.equal(x.validation.evidenceGrade,"C");
  assert.equal(x.decision.failureState,"BLOCKED_EVIDENCE");
});

test("unknowns stay null and data block is explicit",()=>{
  const x=buildAnalysis(base.tokenAddress,[{...base,status:"BLOCKED",payload:null,failureState:"BLOCKED_DATA",error:"NO_POOL"}]);
  assert.equal(x.token.priceUsd,null);
  assert.equal(x.decision.selected,null);
  assert.equal(x.decision.failureState,"BLOCKED_DATA");
});
