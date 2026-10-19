import { extremes } from "./_helpers.mjs";

export default {
  name: "Donchian Channels (Advanced)", group: "Advanced", overlay: true,
  inputs: [{ key: "length", label: "Lookback", type: "int", default: 20, min: 1 }],
  outputs: [
    { key: "upper", label: "Upper channel", color: "#39ff14" },
    { key: "middle", label: "Midpoint", color: "#8cff5f" },
    { key: "lower", label: "Lower channel", color: "#b5ff00" },
  ],
  calc(bars, p) {
    const upper = extremes(bars.map((b) => b.high), p.length, true);
    const lower = extremes(bars.map((b) => b.low), p.length, false);
    return { upper, lower, middle: upper.map((v, i) => (v + lower[i]) / 2) };
  },
};
