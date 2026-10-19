import { ema, src } from "./_helpers.mjs";
export default {
  name: "EMA Ribbon (Custom)", group: "Trend", overlay: true,
  inputs: [{ key: "source", label: "Source", type: "source", default: "close" }, ...[8,13,21,34,55,89].map((v,i)=>({key:`length${i+1}`,label:`EMA ${i+1} length`,type:"int",default:v,min:1}))],
  outputs: [1, 2, 3, 4, 5, 6].map((i) => ({ key: `ema${i}`, label: `EMA ${i}`, color: ["#39ff14", "#8cff5f", "#b5ff00", "#21d84b", "#c8ffd0", "#79c753"][i-1] })),
  calc(bars, p) { const s = src(bars, p.source); return Object.fromEntries([1,2,3,4,5,6].map(i => [`ema${i}`, ema(s, p[`length${i}`])])); },
};
