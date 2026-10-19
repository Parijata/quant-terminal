import { nan } from "./_helpers.mjs";
export default {
  name: "Order Blocks (Custom)", group: "Smart money", overlay: true,
  inputs: [{ key: "lookback", label: "Search back bars", type: "int", default: 12, min: 2, max: 100 }, { key: "atrLength", label: "ATR length", type: "int", default: 14, min: 1 }, { key: "strength", label: "Breakout ATR multiple", type: "float", default: 1.5, min: 0.1 }],
  outputs: [{ key: "bullBlock", label: "Bullish block", color: "#39ff14" }, { key: "bearBlock", label: "Bearish block", color: "#ff5c5c" }],
  calc(bars,p,ta){const bullBlock=nan(bars.length),bearBlock=nan(bars.length),a=ta.atr(bars,p.atrLength),n=Math.max(2,p.lookback|0);let bull=NaN,bear=NaN;for(let i=1;i<bars.length;i++){if(Number.isFinite(bull)&&bars[i].close<bull)bull=NaN;if(Number.isFinite(bear)&&bars[i].close>bear)bear=NaN;if(bars[i].close>bars[i-1].high+(a[i]||0)*p.strength){for(let j=i-1;j>=Math.max(0,i-n);j--)if(bars[j].close<bars[j].open){bull=(bars[j].high+bars[j].low)/2;break;}}if(bars[i].close<bars[i-1].low-(a[i]||0)*p.strength){for(let j=i-1;j>=Math.max(0,i-n);j--)if(bars[j].close>bars[j].open){bear=(bars[j].high+bars[j].low)/2;break;}}bullBlock[i]=bull;bearBlock[i]=bear;}return{bullBlock,bearBlock};},
};
