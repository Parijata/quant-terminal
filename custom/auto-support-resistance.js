import { nan } from "./_helpers.mjs";
export default {
  name: "Auto Support/Resistance (Custom)", group: "Smart money", overlay: true,
  inputs: [{ key: "leftRight", label: "Pivot bars each side", type: "int", default: 5, min: 1, max: 30 }],
  outputs: [{ key: "resistance", label: "Resistance", color: "#ff5c5c" }, { key: "support", label: "Support", color: "#39ff14" }],
  calc(bars,p){const resistance=nan(bars.length),support=nan(bars.length),n=Math.max(1,p.leftRight|0);let r=NaN,s=NaN;for(let i=0;i<bars.length;i++){const c=i-n;if(c>=n){let rh=true,sl=true;for(let j=c-n;j<=c+n;j++)if(j!==c){if(bars[j].high>=bars[c].high)rh=false;if(bars[j].low<=bars[c].low)sl=false;}if(rh)r=bars[c].high;if(sl)s=bars[c].low;}resistance[i]=r;support[i]=s;}return{resistance,support};},
};
