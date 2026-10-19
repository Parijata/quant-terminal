import { nan } from "./_helpers.mjs";
export default {
  name: "On-Balance Volume (Custom)", group: "Volume", overlay: false,
  inputs: [], outputs: [{ key: "obv", label: "OBV", color: "#39ff14", lineWidth: 2 }],
  calc(bars){const obv=nan(bars.length);if(bars.length)obv[0]=bars[0].volume||0;for(let i=1;i<bars.length;i++)obv[i]=obv[i-1]+(bars[i].close>bars[i-1].close?1:bars[i].close<bars[i-1].close?-1:0)*(bars[i].volume||0);return{obv};},
};
