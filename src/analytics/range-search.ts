import type { Ohlcv, RangeCandidate, TruthHandoff } from "../schema/types.js";

type Raw={kind:"CORE"|"BUFFER";strategy:string;lower:number;upper:number};
type Replay=RangeCandidate["replay"]&{density:number;capture:number;active:number;crossing:number};
const clamp=(x:number,a:number,b:number)=>Math.max(a,Math.min(b,x));
const valid=(x:number)=>Number.isFinite(x)&&x>0;

function quantile(xs:Array<{value:number;weight:number}>,q:number):number|null{
  const a=xs.filter(x=>valid(x.value)&&x.weight>0).sort((x,y)=>x.value-y.value); if(!a.length)return null;
  const total=a.reduce((s,x)=>s+x.weight,0); let seen=0;
  for(const x of a){seen+=x.weight;if(seen>=total*q)return x.value;} return a.at(-1)!.value;
}
function sd(xs:number[]):number{if(xs.length<2)return 0;const m=xs.reduce((a,b)=>a+b,0)/xs.length;return Math.sqrt(xs.reduce((s,x)=>s+(x-m)**2,0)/(xs.length-1));}
function range(kind:Raw["kind"],strategy:string,lo:number|null,hi:number|null,p:number):Raw|null{
  if(lo===null||hi===null||!valid(lo)||!valid(hi))return null; let lower=Math.min(lo,hi),upper=Math.max(lo,hi);
  lower=Math.min(lower,p*.995); upper=Math.max(upper,p*1.005); return lower>0&&upper>lower?{kind,strategy,lower,upper}:null;
}
function unique(rows:Array<Raw|null>):Raw[]{const seen=new Set<string>();return rows.filter((r):r is Raw=>Boolean(r)).filter(r=>{const k=`${r.kind}:${r.lower.toPrecision(6)}:${r.upper.toPrecision(6)}`;if(seen.has(k))return false;seen.add(k);return true;});}

function replay(r:Raw,candles:Ohlcv[],p:number,feeRate:number|null):Replay{
  const a=[...candles].filter(c=>valid(c.high)&&valid(c.low)&&valid(c.close)&&c.timestamp>0).sort((x,y)=>x.timestamp-y.timestamp); if(!a.length)return{sampleHours:null,observedVolumeUsd:null,feeProxyUsd:null,weightedVolumeCapturePct:null,activeTimePct:null,crossingDensity:null,density:0,capture:0,active:0,crossing:0};
  const latest=a.at(-1)!.timestamp;let wv=0,wi=0,tw=0,aw=0,rawIn=0,transitions=0;let prev:boolean|null=null;
  for(const c of a){const decay=Math.exp(-Math.max(0,(latest-c.timestamp)/3600)/72);const lo=Math.min(c.low,c.high),hi=Math.max(c.low,c.high);const span=Math.max(hi-lo,c.close*1e-6);const overlap=Math.max(0,Math.min(hi,r.upper)-Math.max(lo,r.lower));const f=clamp(overlap/span,0,1);const inside=c.close>=r.lower&&c.close<=r.upper;const v=Math.max(0,c.volumeUsd||0);wv+=v*decay;wi+=v*decay*f;rawIn+=v*f;tw+=decay;if(f>0)aw+=decay;if(prev!==null&&inside!==prev)transitions++;prev=inside;}
  const width=(r.upper-r.lower)/p*100,capture=wv>0?wi/wv:0,active=tw>0?aw/tw:0,crossing=a.length>1?transitions/(a.length-1):0;
  return{sampleHours:a.length>1?Math.round((latest-a[0].timestamp)/3600)+1:1,observedVolumeUsd:rawIn,feeProxyUsd:feeRate===null?null:rawIn*feeRate,weightedVolumeCapturePct:capture*100,activeTimePct:active*100,crossingDensity:crossing*100,density:width>0?wi/width:0,capture,active,crossing};
}
function ranked(rows:Raw[],candles:Ohlcv[],p:number,feeRate:number|null){const e=rows.map(raw=>({raw,replay:replay(raw,candles,p,feeRate)}));const maxD=Math.max(1,...e.map(x=>x.replay.density));return e.map(x=>{const d=clamp(x.replay.density/maxD,0,1),r=x.replay;const s=x.raw.kind==="CORE"?.45*d+.25*r.capture+.20*r.active+.10*r.crossing:.20*d+.35*r.capture+.35*r.active+.10*r.crossing;return{...x,score:Math.round(s*1000)/10};}).sort((a,b)=>b.score-a.score||(a.raw.upper-a.raw.lower)-(b.raw.upper-b.raw.lower));}

export function searchRanges(t:TruthHandoff):{candidates:RangeCandidate[];core:RangeCandidate|null;buffer:RangeCandidate|null}{
  const p=t.market.priceUsd,c=(t.history.ohlcv1h??[]).filter(x=>valid(x.close)&&valid(x.high)&&valid(x.low));
  if(p===null||!valid(p)||c.length<12){const f=(kind:Raw["kind"],w:number):RangeCandidate=>({kind,strategy:"FALLBACK_STATIC_BLOCKED",lowerPriceUsd:p===null?null:p*(1-w),upperPriceUsd:p===null?null:p*(1+w),widthPct:w*200,score:null,selected:false,replay:{sampleHours:c.length||null,observedVolumeUsd:null,feeProxyUsd:null,weightedVolumeCapturePct:null,activeTimePct:null,crossingDensity:null},failureState:"BLOCKED_EVIDENCE"});return{candidates:[f("CORE",.12),f("BUFFER",.30)],core:null,buffer:null};}
  const a=[...c].sort((x,y)=>x.timestamp-y.timestamp),latest=a.at(-1)!.timestamp,vols=a.map(x=>Math.max(0,x.volumeUsd||0)).filter(x=>x>0).sort((x,y)=>x-y),median=vols.length?vols[Math.floor(vols.length/2)]:1;
  const samples=a.map(x=>({value:(x.high+x.low+x.close)/3,weight:Math.exp(-Math.max(0,(latest-x.timestamp)/3600)/72)*(.15+Math.max(0,x.volumeUsd||0)/Math.max(1,median))})),q=(n:number)=>quantile(samples,n),last24=a.slice(-24),lo24=Math.min(...last24.map(x=>x.low)),hi24=Math.max(...last24.map(x=>x.high));
  const rets=a.slice(-73).flatMap((x,i,z)=>i&&z[i-1].close>0?[Math.log(x.close/z[i-1].close)]:[]),vw=clamp(sd(rets)*Math.sqrt(24)*1.25,.06,.30),trend=last24.length>1?last24.at(-1)!.close/last24[0].close-1:0,down=trend<-.03,up=trend>.03;
  const lowFactor=down?1.35:(up?.75:1),highFactor=up?1.35:(down?.75:1);
  const cores=unique([range("CORE","VOLUME_Q25_Q75",q(.25),q(.75),p),range("CORE","VOLUME_Q20_Q80",q(.20),q(.80),p),range("CORE","VOLUME_Q15_Q85",q(.15),q(.85),p),range("CORE","RECENT_24H_ENVELOPE",lo24,hi24,p),range("CORE",`VOLATILITY_SKEW_${down?"DOWN":up?"UP":"NEUTRAL"}`,p*(1-vw*lowFactor),p*(1+vw*highFactor),p)]);
  const fee=t.market.feeTier===null?null:t.market.feeTier/1_000_000,cr=ranked(cores,a,p,fee),win=cr[0]??null,expand=win?Math.max((win.raw.upper-win.raw.lower)*.25,p*.04):p*.10;
  const buffers=unique([range("BUFFER","VOLUME_Q05_Q95",q(.05),q(.95),p),range("BUFFER","VOLUME_Q02_Q98",q(.02),q(.98),p),range("BUFFER","RECENT_24H_SAFETY",lo24*.94,hi24*1.06,p),win?range("BUFFER","CORE_PLUS_REVISIT_MARGIN",win.raw.lower-expand,win.raw.upper+expand,p):null]).filter(b=>!win||(b.lower<=win.raw.lower&&b.upper>=win.raw.upper)),br=ranked(buffers,a,p,fee);
  const out=(x:{raw:Raw;replay:Replay;score:number},selected:boolean):RangeCandidate=>({kind:x.raw.kind,strategy:x.raw.strategy,lowerPriceUsd:x.raw.lower,upperPriceUsd:x.raw.upper,widthPct:(x.raw.upper-x.raw.lower)/p*100,score:x.score,selected,replay:{sampleHours:x.replay.sampleHours,observedVolumeUsd:x.replay.observedVolumeUsd,feeProxyUsd:x.replay.feeProxyUsd,weightedVolumeCapturePct:x.replay.weightedVolumeCapturePct,activeTimePct:x.replay.activeTimePct,crossingDensity:x.replay.crossingDensity},failureState:null});
  const core=cr.map((x,i)=>out(x,i===0)),buffer=br.map((x,i)=>out(x,i===0));return{candidates:[...core,...buffer],core:core[0]??null,buffer:buffer[0]??null};
}
