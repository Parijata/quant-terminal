import { nan } from "./_helpers.mjs";
export default {
  name: "52-Week High/Low (Custom)", group: "Levels", overlay: true,
  inputs: [{ key: "days", label: "Lookback days", type: "int", default: 365, min: 30 }],
  outputs: [{ key: "high", label: "52-week high", color: "#39ff14" }, { key: "low", label: "52-week low", color: "#ff5c5c" }],
  calc(bars,p){const high=nan(bars.length),low=nan(bars.length),window=Math.max(30,p.days|0)*86400,hq=[],lq=[];let hh=0,lh=0;for(let i=0;i<bars.length;i++){if(hh===hq.length){hq.length=0;hh=0;}while(hq.length>hh&&bars[hq.at(-1)].high<=bars[i].high)hq.pop();hq.push(i);if(lh===lq.length){lq.length=0;lh=0;}while(lq.length>lh&&bars[lq.at(-1)].low>=bars[i].low)lq.pop();lq.push(i);const cutoff=bars[i].time-window;while(hq[hh]!=null&&bars[hq[hh]].time<cutoff)hh++;while(lq[lh]!=null&&bars[lq[lh]].time<cutoff)lh++;high[i]=bars[hq[hh]].high;low[i]=bars[lq[lh]].low;}return{high,low};},
};
