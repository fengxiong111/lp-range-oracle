import { searchRanges } from "./analytics/range-search.js";
import type { AnalysisArtifact, SourceName, TruthHandoff } from "./schema/types.js";
import { createHash } from "node:crypto";

const SOURCE_NAMES=new Set<SourceName>(["okx","uniswap","rpc","dexpaprika","geckoterminal","dexscreener","revert","vfat"]);
const primarySource=(t:TruthHandoff):SourceName|null=>{const s=t.selectedPool?.source;return typeof s==="string"&&SOURCE_NAMES.has(s as SourceName)?s as SourceName:null;};

function confidence(t:TruthHandoff,score:number|null):number|null{
  if(score===null)return null;
  const base={A:.90,B:.82,C:.65,D:.35}[t.evidence.grade];
  const freshness=t.evidence.freshnessSeconds;
  const freshnessPenalty=freshness===null?.05:freshness>43200?.12:freshness>14400?.07:freshness>7200?.03:0;
  const conflictPenalty=Math.min(.15,t.evidence.conflicts.length*.04);
  const wickPenalty=t.evidence.wickPenalty?.05:0;
  const scorePenalty=score<60?.08:score<75?.04:0;
  return Math.max(.20,Math.min(.95,Math.round((base-freshnessPenalty-conflictPenalty-wickPenalty-scorePenalty)*100)/100));
}

export function buildAnalysisFromTruth(t:TruthHandoff):AnalysisArtifact{
  const search=searchRanges(t);
  const ready=t.evidence.sources.filter(s=>s.status==="READY").length;
  const selected=search.core;
  const blocked=t.failureState??(!search.core||!search.buffer?"BLOCKED_EVIDENCE":null);
  const conf=confidence(t,selected?.score??null);
  const gradeNote=t.evidence.grade==="A"
    ?"A-grade Truth achieved from canonical pool state + tick-density + verified fee-growth delta; execution authority remains separate, so this Oracle stays WAIT until an explicit ENTER gate exists."
    :"WAIT remains fail-closed below A-grade: tick-density/fee-growth or other required evidence is incomplete.";
  return {
    schemaVersion:"lp-oracle-v3.3",
    request:{tokenAddress:t.request.tokenAddress,chain:t.selectedPool?.chainId??null,pool:t.selectedPool?.poolAddress??null},
    timestamp:t.timestamp,
    validation:{input:"VALID_EVM_ADDRESS",sourcesReady:ready,evidenceGrade:t.evidence.grade},
    failureState:blocked,
    evidence:{
      primarySource:primarySource(t),
      sourceCount:ready,
      notes:[
        "Consumed versioned lp-truth-v1 handoff; Oracle performs no market fetch in this path.",
        `Range engine=STRUCTURE_AWARE_REPLAY_V2; truth freshness=${t.evidence.freshnessSeconds??"unknown"}; conflicts=${t.evidence.conflicts.length}; wickPenalty=${t.evidence.wickPenalty}.`,
        "Replay penalizes current-price boundary risk and rewards regime-direction coverage; stale 7d volume cannot dominate a confirmed 24h structure shift.",
        gradeNote
      ]
    },
    token:{name:null,symbol:null,priceUsd:t.market.priceUsd,marketCapUsd:null},
    sources:[],
    search:{engine:"STRUCTURE_AWARE_REPLAY_V2",candidatesEvaluated:search.candidates.length,coreStrategy:search.core?.strategy??null,bufferStrategy:search.buffer?.strategy??null},
    candidates:search.candidates,
    decision:{
      action:"WAIT",
      selected:selected?"CORE":null,
      score:selected?.score??null,
      confidence:conf,
      allocation:{corePct:70,bufferPct:30,rationale:"DEFAULT_70_30_UNLESS_VERIFIED_EVIDENCE_JUSTIFIES_OVERRIDE"},
      failureState:blocked
    },
    receipts:{
      decision:{
        inputSchemaVersion:"lp-truth-v1",
        inputHash:createHash("sha256").update(JSON.stringify(t)).digest("hex"),
        createdAt:t.timestamp,
        action:"WAIT",
        selected:selected?"CORE":null,
        failureState:blocked
      }
    },
    truth:t
  };
}
