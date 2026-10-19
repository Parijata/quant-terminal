import { src, nan } from "./_helpers.mjs";
export default {
  name: "Rate of Change (Custom)", group: "Momentum", overlay: false,
  inputs: [{ key: "length", label: "Length", type: "int", default: 12, min: 1 }, { key: "source", label: "Source", type: "source", default: "close" }],
  outputs: [{ key: "roc", label: "ROC %", color: "#39ff14", lineWidth: 2 }], levels: [0],
  calc(bars,p){const s=src(bars,p.source),n=Math.max(1,p.length|0),out=nan(bars.length);for(let i=n;i<s.length;i++)if(s[i-n])out[i]=100*(s[i]/s[i-n]-1);return{roc:out};},
};
