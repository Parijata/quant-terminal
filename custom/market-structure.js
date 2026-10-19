import { nan } from "./_helpers.mjs";
export default {
  name: "Market Structure BOS/CHoCH (Custom)", group: "Smart money", overlay: true,
  inputs: [{ key: "pivot", label: "Swing strength", type: "int", default: 3, min: 1, max: 20 }],
  outputs: [{ key: "structure", label: "Structure direction", color: "#39ff14" }],
  calc(bars,p){const structure=nan(bars.length),markers=[],n=Math.max(1,p.pivot|0);let hi=NaN,lo=NaN,trend=0;for(let i=0;i<bars.length;i++){const c=i-n;if(c>=n){let isH=true,isL=true;for(let j=c-n;j<=c+n;j++)if(j!==c){if(bars[j].high>=bars[c].high)isH=false;if(bars[j].low<=bars[c].low)isL=false;}if(isH)hi=bars[c].high;if(isL)lo=bars[c].low;}if(Number.isFinite(hi)&&bars[i].close>hi){const change=trend<0;trend=1;hi=NaN;markers.push({time:bars[i].time,position:"aboveBar",shape:"arrowUp",color:"#39ff14",text:change?"CHoCH":"BOS"});}else if(Number.isFinite(lo)&&bars[i].close<lo){const change=trend>0;trend=-1;lo=NaN;markers.push({time:bars[i].time,position:"belowBar",shape:"arrowDown",color:"#ff5c5c",text:change?"CHoCH":"BOS"});}structure[i]=trend;}return{structure,markers};},
};
