import { nan } from "./_helpers.mjs";
export default {
  name: "Swing Highs/Lows (Custom)", group: "Smart money", overlay: true,
  inputs: [{ key: "leftRight", label: "Pivot bars each side", type: "int", default: 3, min: 1, max: 30 }],
  outputs: [{ key: "swingHigh", label: "Swing high", color: "#ff5c5c", dots: true }, { key: "swingLow", label: "Swing low", color: "#39ff14", dots: true }],
  calc(bars,p){const swingHigh=nan(bars.length),swingLow=nan(bars.length),n=Math.max(1,p.leftRight|0);for(let i=n*2;i<bars.length;i++){const c=i-n,window=bars.slice(c-n,c+n+1);if(window.every((b,j)=>j===n||bars[c].high>b.high))swingHigh[c]=bars[c].high;if(window.every((b,j)=>j===n||bars[c].low<b.low))swingLow[c]=bars[c].low;}return{swingHigh,swingLow};},
};
