import { atr } from "./_helpers.mjs";
export default {
  name: "Average True Range (Custom)", group: "Volatility", overlay: false,
  inputs: [{ key: "length", label: "Length", type: "int", default: 14, min: 1 }],
  outputs: [{ key: "atr", label: "ATR", color: "#39ff14", lineWidth: 2 }],
  calc(bars, p) { return { atr: atr(bars, p.length) }; },
};
