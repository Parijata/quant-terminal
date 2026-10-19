import { extremes, atr } from "./_helpers.mjs";

export default {
  name: "Chandelier Exit (Advanced)", group: "Advanced", overlay: true,
  inputs: [
    { key: "length", label: "Lookback", type: "int", default: 22, min: 1 },
    { key: "atrLength", label: "ATR length", type: "int", default: 22, min: 1 },
    { key: "multiplier", label: "ATR multiplier", type: "float", default: 3, min: 0.1 },
  ],
  outputs: [
    { key: "long", label: "Long exit", color: "#39ff14", lineWidth: 2 },
    { key: "short", label: "Short exit", color: "#ff4d6d", lineWidth: 2 },
  ],
  calc(bars, p) {
    const range = atr(bars, p.atrLength);
    const high = extremes(bars.map((b) => b.high), p.length, true);
    const low = extremes(bars.map((b) => b.low), p.length, false);
    return {
      long: high.map((v, i) => v - p.multiplier * range[i]),
      short: low.map((v, i) => v + p.multiplier * range[i]),
    };
  },
};
