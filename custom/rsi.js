import { src } from "./_helpers.mjs";
export default {
  name: "Relative Strength Index (Custom)", group: "Momentum", overlay: false,
  inputs: [{ key: "length", label: "Length", type: "int", default: 14, min: 1 }, { key: "source", label: "Source", type: "source", default: "close" }],
  outputs: [{ key: "rsi", label: "RSI", color: "#39ff14", lineWidth: 2 }], levels: [30, 70],
  calc(bars, p, ta) { return { rsi: ta.rsi(src(bars, p.source), p.length) }; },
};
