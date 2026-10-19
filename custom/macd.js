import { src } from "./_helpers.mjs";
export default {
  name: "MACD (Custom)", group: "Momentum", overlay: false,
  inputs: [{ key: "fast", label: "Fast length", type: "int", default: 12, min: 1 }, { key: "slow", label: "Slow length", type: "int", default: 26, min: 2 }, { key: "signalLength", label: "Signal length", type: "int", default: 9, min: 1 }, { key: "source", label: "Source", type: "source", default: "close" }],
  outputs: [{ key: "macd", label: "MACD", color: "#39ff14" }, { key: "signal", label: "Signal", color: "#b5ff00" }, { key: "histogram", label: "Histogram", kind: "histogram", color: "#8cff5f" }],
  calc(bars, p, ta) { const result = ta.macd(src(bars, p.source), p.fast, Math.max(p.fast + 1, p.slow), p.signalLength); return { macd: result.macd, signal: result.signal, histogram: result.hist }; },
};
