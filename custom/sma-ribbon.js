import { sma, src } from "./_helpers.mjs";
export default {
  name: "SMA Ribbon (Custom)", group: "Trend", overlay: true,
  inputs: [{ key: "source", label: "Source", type: "source", default: "close" }, ...[10,20,50,100,150,200].map((v,i)=>({key:`length${i+1}`,label:`SMA ${i+1} length`,type:"int",default:v,min:1}))],
  outputs: [1, 2, 3, 4, 5, 6].map((i) => ({ key: `sma${i}`, label: `SMA ${i}`, color: ["#39ff14", "#8cff5f", "#b5ff00", "#21d84b", "#c8ffd0", "#79c753"][i-1] })),
  calc(bars, p) { const s = src(bars, p.source); return Object.fromEntries([1,2,3,4,5,6].map(i => [`sma${i}`, sma(s, p[`length${i}`])])); },
};
