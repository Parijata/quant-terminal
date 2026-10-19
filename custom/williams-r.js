import { nan } from "./_helpers.mjs";
export default {
  name: "Williams %R (Custom)", group: "Momentum", overlay: false,
  inputs: [{ key: "length", label: "Length", type: "int", default: 14, min: 1 }],
  outputs: [{ key: "williamsR", label: "%R", color: "#39ff14", lineWidth: 2 }], levels: [-80, -20],
  calc(bars,p){const out=nan(bars.length),n=Math.max(1,p.length|0);for(let i=n-1;i<bars.length;i++){let hi=-Infinity,lo=Infinity;for(let j=i-n+1;j<=i;j++){hi=Math.max(hi,bars[j].high);lo=Math.min(lo,bars[j].low);}out[i]=hi===lo?-50:-100*(hi-bars[i].close)/(hi-lo);}return{williamsR:out};},
};
