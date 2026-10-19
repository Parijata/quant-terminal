import { nan } from "./_helpers.mjs";
export default {
  name: "Commodity Channel Index (Custom)", group: "Momentum", overlay: false,
  inputs: [{ key: "length", label: "Length", type: "int", default: 20, min: 1 }],
  outputs: [{ key: "cci", label: "CCI", color: "#39ff14", lineWidth: 2 }], levels: [-100, 100],
  calc(bars,p){const out=nan(bars.length),n=Math.max(1,p.length|0),tp=bars.map(b=>(b.high+b.low+b.close)/3);for(let i=n-1;i<bars.length;i++){const w=tp.slice(i-n+1,i+1),m=w.reduce((a,b)=>a+b,0)/n,md=w.reduce((a,b)=>a+Math.abs(b-m),0)/n;out[i]=md? (tp[i]-m)/(0.015*md):0;}return{cci:out};},
};
