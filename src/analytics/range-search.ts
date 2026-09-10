import type { Ohlcv, RangeCandidate, TruthHandoff } from "../schema/types.js";

type RawCandidate = { kind:"CORE"|"BUFFER"; strategy:string; lower:number; upper:number };
type Replay = RangeCandidate["replay"] & { density:number; capture:number; active:number; crossing:number };

const clamp=(x:number,lo:number,hi:number)=>Math.max(lo,Math.min(hi,x));
const valid=(x:number)=>Number.isFinite(x)&&x>0;

function weightedQuantile(values:Array<{value:number;weight:number}>,q:number):number|null{
  const rows=values.filter(x=>valid(x.value)&&x.weight>0).sort((a,b)=>a.value-b.value);
  if(!rows.length)return null;
  const total=rows.reduce((s,x)=>s+x.weight,0); let acc=0;
  for(const row of rows){acc+=row.weight;if(acc>=total*q)return row.value;}
  return rows.at(-1)!.value;
}

function stdev(values:number[]):number{
  if(values.length<2)return 0;
  const mean=values.reduce((a,b)=>a+b,0)/values.length;
  return Math.sqrt(values.reduce((s,x)=>s+(x-mean)**2,0)/(values.length-1));
}

function normalizeRange(kind:"CORE"|"BUFFER",strategy:string,lower:number|null,upper:number|null,price:number):RawCandidate|null{
  if(lower===null||upper===null||!valid(lower)||!valid(upper))return null;
  let lo=Math.min(lower,upper),hi=Math.max(lower,upper);
  lo=Math.min(lo,price*.995); hi=Math.max(hi,price*1.005);
  if(!valid(lo)||hi<=lo)return null;
  return {kind,strategy,lower:lo,upper:hi};
}

function dedupe(rows:RawCandidate[]):RawCandidate[]{
  const seen=new Set<string>();
  return rows.filter(r=>{const key=`${r.kind}:${r.lower.toPrecision(6)}:${r.upper.toPrecision(6)}`;if(seen.has(key))return false;seen.add(key);return true;});
}

function replay(raw:RawCandidate,candles:Ohlcv[],price:number,feeRate:number|null):Replay{
  const ordered=[...candles].filter(c=>valid(c.high)&&valid(c.low)&&valid(c.close)&&c.timestamp>0).sort((a,b)=>a.timestamp-b.timestamp);
  if(!ordered.length)return {sampleHours:null,observedVolumeUsd:null,feeProxyUsd:null,weightedVolumeCapturePct:null,activeTimePct:null,crossingDensity:null,density:0,capture:0,active:0,crossing:0};
  const latest=ordered.at(-1)!.timestamp;
  let weightedVolume=0,weightedIn=0,timeWeight=0,activeWeight=0,rawIn=0,transitions=0;
  let previousInside:boolean|null=null;
  for(const c of ordered){
    const ageHours=Math.max(0,(latest-c.timestamp)/3600); const decay=Math.exp(-ageHours/72);
    const lo=Math.min(c.low,c.high),hi=Math.max(c.low,c.high);
    const span=Math.max(hi-lo,Math.max(c.close*.000001,1e-12));
    const overlap=Math.max(0,Math.min(hi,raw.upper)-Math.max(lo,raw.lower));
    const fraction=clamp(overlap/span,0,1);
    const inside=c.close>=raw.lower&&c.close<=raw.upper;
    const vol=Math.max(0,c.volumeUsd||0);
    weightedVolume+=vol*decay; weightedIn+=vol*decay*fraction; rawIn+=vol*fraction;
    timeWeight+=decay; if(fraction>0)activeWeight+=decay;
    if(previousInside!==null&&inside!==previousInside)transitions+=1;
    previousInside=inside;
  }
  const widthPct=(raw.upper-raw.lower)/price*100;
  const capture=weightedVolume>0?weightedIn/weightedVolume:0;
  const active=timeWeight>0?activeWeight/timeWeight:0;
  const crossing=ordered.length>1?clamp(transitions/(ordered.length-1),0,1):0;
  const density=widthPct>0?weightedIn/widthPct:0;
  const sampleHours=ordered.length>1?Math.round((latest-ordered[0].timestamp)/3600)+1:1;
  return {sampleHours,observedVolumeUsd:rawIn,feeProxyUsd:feeRate===null?null:rawIn*feeRate,weightedVolumeCapturePct:capture*100,activeTimePct:active*100,crossingDensity:crossing*100,density,capture,active,crossing};
}

function scoreRows(rawRows:RawCandidate[],candles:Ohlcv[],price:number,feeRate:number|null):Array<{raw:RawCandidate;replay:Replay;score:number}>{
  const evaluated=rawRows.map(raw=>({raw,replay:replay(raw,candles,price,feeRate)}));
  const maxDensity=Math.max(1,...evaluated.map(x=>x.replay.density));
  return evaluated.map(x=>{
    const densityNorm=clamp(x.replay.density/maxDensity,0,1); const r=x.replay;
    const score=x.raw.kind==="CORE"?100*(.45*densityNorm+.25*r.capture+.20*r.active+.10*r.crossing):100*(.20*densityNorm+.35*r.capture+.35*r.active+.10*r.crossing);
    return {...x,score:Math.round(score*10)/10};
  }).sort((a,b)=>b.score-a.score||((a.raw.upper-a.raw.lower)-(b.raw.upper-b.raw.lower)));
}

export function searchRanges(t:TruthHandoff):{candidates:RangeCandidate[];core:RangeCandidate|null;buffer:RangeCandidate|null}{
  const price=t.market.priceUsd; const candles=(t.history.ohlcv1h??[]).filter(c=>valid(c.close)&&valid(c.high)&&valid(c.low));
  if(price===null||!valid(price)||candles.length<12){
    const fallback=(kind:"CORE"|"BUFFER",width:number):RangeCandidate=>({kind,strategy:"FALLBACK_STATIC_BLOCKED",lowerPriceUsd:price===null?null:price*(1-width),upperPriceUsd:price===null?null:price*(1+width),widthPct:width*200,score:null,selected:false,replay:{sampleHours:candles.length||null,observedVolumeUsd:null,feeProxyUsd:null,weightedVolumeCapturePct:null,activeTimePct:null,crossingDensity:null},failureState:"BLOCKED_EVIDENCE"});
    return {candidates:[fallback("CORE",.12),fallback("BUFFER",.30)],core:null,buffer:null};
  }

  const ordered=[...candles].sort((a,b)=>a.timestamp-b.timestamp); const latest=ordered.at(-1)!.timestamp;
  const positiveVolumes=ordered.map(c=>Math.max(0,c.volumeUsd||0)).filter(v=>v>0).sort((a,b)=>a-b); const medianVol=positiveVolumes.length?positiveVolumes[Math.floor(positiveVolumes.length/2)]:1;
  const samples=ordered.map(c=>{const decay=Math.exp(-Math.max(0,(latest-c.timestamp)/3600)/72);const volumeWeight=.15+Math.max(0,c.volumeUsd||0)/Math.max(1,medianVol);return {value:(c.high+c.low+c.close)/3,weight:decay*volumeWeight};});
  const q=(p:number)=>weightedQuantile(samples,p); const last24=ordered.slice(-24);
  const low24=last24.length?Math.min(...last24.map(c=>c.low)):null; const high24=last24.length?Math.max(...last24.map(c=>c.high)):null;
  const returns=ordered.slice(-73).flatMap((c,i,a)=>i&&a[i-1].close>0?[Math.log(c.close/a[i-1].close)]:[]);
  const daySigma=stdev(returns)*Math.sqrt(24); const volWidth=clamp(daySigma*1.25,.06,.30);
  const trendBase=last24.length>1?last24[0].close:null; const trend=trendBase&&trendBase>0?last24.at(-1)!.close/trendBase-1:0; const down=trend<-.03,up=trend>.03;
  const lowerSkewFactor=down?1.35:up?.75:1; const upperSkewFactor=up?1.35:down?.75:1;
  const skewLower=price*(1-volWidth*lowerSkewFactor); const skewUpper=price*(1+volWidth*upperSkewFactor);

  const coreRaw=dedupe([normalizeRange("CORE","VOLUME_Q25_Q75",q(.25),q(.75),price),normalizeRange("CORE","VOLUME_Q20_Q80",q(.20),q(.80),price),normalizeRange("CORE","VOLUME_Q15_Q85",q(.15),q(.85),price),normalizeRange("CORE","RECENT_24H_ENVELOPE",low24,high24,price),normalizeRange("CORE",`VOLATILITY_SKEW_${down?"DOWN":up?"UP":"NEUTRAL"}`,skewLower,skewUpper,price)].filter((x):x is RawCandidate=>Boolean(x)));
  const feeRate=t.market.feeTier===null?null:t.market.feeTier/1_000_000; const coreScored=scoreRows(coreRaw,ordered,price,feeRate); const winningCore=coreScored[0]??null;
  const expand=winningCore?Math.max((winningCore.raw.upper-winningCore.raw.lower)*.25,price*.04):price*.10;
  const bufferRaw=dedupe([normalizeRange("BUFFER","VOLUME_Q05_Q95",q(.05),q(.95),price),normalizeRange("BUFFER","VOLUME_Q02_Q98",q(.02),q(.98),price),normalizeRange("BUFFER","RECENT_24H_SAFETY",low24===null?null:low24*.94,high24===null?null:high24*1.06,price),winningCore?normalizeRange("BUFFER","CORE_PLUS_REVISIT_MARGIN",winningCore.raw.lower-expand,winningCore.raw.upper+expand,price):null].filter((x):x is RawCandidate=>Boolean(x))).filter(b=>!winningCore||(b.lower<=winningCore.raw.lower&&b.upper>=winningCore.raw.upper));
  const bufferScored=scoreRows(bufferRaw,ordered,price,feeRate); const convert=(x:{raw:RawCandidate;replay:Replay;score:number},selected:boolean):RangeCandidate=>({kind:x.raw.kind,strategy:x.raw.strategy,lowerPriceUsd:x.raw.lower,upperPriceUsd:x.raw.upper,widthPct:(x.raw.upper-x.raw.lower)/price*100,score:x.score,selected,replay:{sampleHours:x.replay.sampleHours,observedVolumeUsd:x.replay.observedVolumeUsd,feeProxyUsd:x.replay.feeProxyUsd,weightedVolumeCapturePct:x.replay.weightedVolumeCapturePct,activeTimePct:x.replay.activeTimePct,crossingDensity:x.replay.crossingDensity},failureState:null});
  const cores=coreScored.map((x,i)=>convert(x,i===0)); const buffers=bufferScored.map((x,i)=>convert(x,i===0)); return {candidates:[...cores,...buffers],core:cores[0]??null,buffer:buffers[0]??null};
}
