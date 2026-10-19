import { nan } from "./_helpers.mjs";
export default {
  name: "Fair Value Gaps (Custom)", group: "Smart money", overlay: true,
  inputs: [{ key: "extend", label: "Extend bars", type: "int", default: 30, min: 1, max: 500 }],
  outputs: [{ key: "bullTop", label: "Bullish gap top", color: "#39ff14" }, { key: "bullBottom", label: "Bullish gap bottom", color: "#8cff5f" }, { key: "bearTop", label: "Bearish gap top", color: "#ff5c5c" }, { key: "bearBottom", label: "Bearish gap bottom", color: "#ff9e9e" }],
  calc(bars,p){const keys=["bullTop","bullBottom","bearTop","bearBottom"],o=Object.fromEntries(keys.map(k=>[k,nan(bars.length)]));for(let i=2;i<bars.length;i++){if(bars[i].low>bars[i-2].high){const end=Math.min(bars.length,i+Math.max(1,p.extend|0));for(let j=i;j<end;j++){o.bullTop[j]=bars[i].low;o.bullBottom[j]=bars[i-2].high;}}if(bars[i].high<bars[i-2].low){const end=Math.min(bars.length,i+Math.max(1,p.extend|0));for(let j=i;j<end;j++){o.bearTop[j]=bars[i-2].low;o.bearBottom[j]=bars[i].high;}}}return o;},
};
