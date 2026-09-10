import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAnalysisFromTruth } from "../src/truth.js";
import type { Ohlcv, TruthHandoff } from "../src/schema/types.js";

const candles:Ohlcv[]=Array.from({length:72},(_,i)=>{
  const center=.70-.0015*i+Math.sin(i/4)*.018;
  return {timestamp:1788900000+i*3600,open:center*.998,high:center*1.012,low:center*.988,close:center,volumeUsd:100_000+(i%8)*20_000};
});

const truth:TruthHandoff={
  schemaVersion:"lp-truth-v1",
  request:{tokenAddress:"0x39dbed3a2bd333467115de45665cc57f813c4571"},
  timestamp:new Date().toISOString(),
  selectedPool:{chainId:"robinhood",poolAddress:"0xpool",priceUsd:.60,volume24hUsd:5_000_000,liquidityUsd:5_000_000,feeTier:10000,poolAgeDays:50,source:"dexscreener"},
  onchainPool:{feeTier:10000,currentTick:123,activeLiquidityRaw:"1000000",sqrtPriceX96:"1",canonical:true},
  poolCandidates:[],
  market:{priceUsd:.60,high24hUsd:.68,low24hUsd:.57,high7dUsd:.73,low7dUsd:.56,volume5mUsd:10_000,volume30mUsd:50_000,volume1hUsd:200_000,volume24hUsd:5_000_000,tvlUsd:5_000_000,activeLiquidityUsd:null,feeTier:10000,poolAgeDays:50,tick:{current:123,lower:null,upper:null},holderFlow:null},
  history:{ohlcv1h:candles,ohlcv5m:[],ohlcv30m:[],ohlcv1d:[]},
  evidence:{grade:"B",freshnessSeconds:1200,conflicts:[],wickPenalty:false,sources:[{source:"dexscreener",status:"READY"},{source:"dexpaprika",status:"READY"},{source:"rpc",status:"READY"},{source:"uniswap",status:"READY"}]},
  failureState:null
};

test("oracle searches structure-aware replay ranges from lp-truth-v1",()=>{
  const a=buildAnalysisFromTruth(truth);
  assert.equal(a.schemaVersion,"lp-oracle-v3.3");
  assert.equal(a.validation.evidenceGrade,"B");
  assert.equal(a.search.engine,"STRUCTURE_AWARE_REPLAY_V2");
  assert.ok(a.search.candidatesEvaluated>=5);
  const core=a.candidates.find(x=>x.kind==="CORE"&&x.selected);
  const buffer=a.candidates.find(x=>x.kind==="BUFFER"&&x.selected);
  assert.ok(core&&buffer);
  assert.notEqual(core.strategy,"FALLBACK_STATIC_BLOCKED");
  assert.ok((core.replay.weightedVolumeCapturePct??0)>0);
  assert.ok((core.replay.feeProxyUsd??0)>0,"actual truth fee tier must drive fee proxy");
  assert.ok((core.replay.boundarySafetyPct??0)>=0);
  assert.ok((core.replay.structureFitPct??0)>=0);
  assert.ok((buffer.lowerPriceUsd??Infinity)<=(core.lowerPriceUsd??0));
  assert.ok((buffer.upperPriceUsd??0)>=(core.upperPriceUsd??Infinity));
  assert.ok((buffer.replay.structureFitPct??0)>0,"buffer must be scored for current regime coverage");
  assert.equal(a.decision.action,"WAIT");
  assert.equal(a.decision.allocation.corePct,70);
  assert.equal(a.decision.allocation.bufferPct,30);
  assert.equal(a.decision.allocation.corePct+a.decision.allocation.bufferPct,100);
  assert.ok((a.decision.confidence??0)>=.75);
  assert.equal(a.evidence.sourceCount,4);
});

test("missing historical truth blocks replay instead of inventing a range",()=>{
  const blocked=structuredClone(truth);
  blocked.history={ohlcv1h:[]}; blocked.market.high7dUsd=null; blocked.market.low7dUsd=null; blocked.evidence.grade="C";
  const a=buildAnalysisFromTruth(blocked);
  assert.equal(a.decision.failureState,"BLOCKED_EVIDENCE");
  assert.equal(a.decision.selected,null);
  assert.equal(a.candidates[0].strategy,"FALLBACK_STATIC_BLOCKED");
  assert.equal(a.candidates[0].replay.boundarySafetyPct,null);
  assert.equal(a.candidates[0].replay.structureFitPct,null);
  assert.equal(a.decision.allocation.corePct,70);
  assert.equal(a.decision.allocation.bufferPct,30);
});
