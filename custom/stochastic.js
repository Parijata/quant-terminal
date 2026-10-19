import { nan } from "./_helpers.mjs";
export default {
  name: "Stochastic Oscillator (Custom)", group: "Momentum", overlay: false,
  inputs: [{ key: "length", label: "%K length", type: "int", default: 14, min: 1 }, { key: "smoothK", label: "%K smoothing", type: "int", default: 3, min: 1 }, { key: "smoothD", label: "%D length", type: "int", default: 3, min: 1 }],
  outputs: [{ key: "k", label: "%K", color: "#39ff14" }, { key: "d", label: "%D", color: "#b5ff00" }], levels: [20, 80],
  calc(bars, p, ta) { const raw = nan(bars.length), n = Math.max(1, p.length | 0); for (let i=n-1;i<bars.length;i++){let hi=-Infinity,lo=Infinity;for(let j=i-n+1;j<=i;j++){hi=Math.max(hi,bars[j].high);lo=Math.min(lo,bars[j].low);}raw[i]=hi===lo?50:100*(bars[i].close-lo)/(hi-lo);} const k=ta.sma(raw,Math.max(1,p.smoothK|0)); return {k,d:ta.sma(k,Math.max(1,p.smoothD|0))}; },
};
