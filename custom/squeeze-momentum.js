import { nan, sma, extremes, stdev, atr } from "./_helpers.mjs";

export default {
  name: "Squeeze Momentum (Advanced)", group: "Advanced", overlay: false,
  inputs: [
    { key: "length", label: "Length", type: "int", default: 20, min: 2 },
    { key: "bbMultiplier", label: "Bollinger multiplier", type: "float", default: 2, min: 0.1 },
    { key: "kcMultiplier", label: "Keltner multiplier", type: "float", default: 1.5, min: 0.1 },
  ],
  outputs: [
    { key: "momentum", label: "Momentum", color: "#39ff14", lineWidth: 2 },
    { key: "squeeze", label: "Squeeze on", color: "#8cff5f" },
  ],
  calc(bars, p) {
    const n = bars.length, close = bars.map((b) => b.close), mean = sma(close, p.length);
    const sd = stdev(close, p.length), range = atr(bars, p.length);
    const hi = extremes(bars.map((b) => b.high), p.length, true), lo = extremes(bars.map((b) => b.low), p.length, false);
    const momentum = nan(n), squeeze = nan(n);
    for (let i = p.length - 1; i < n; i++) {
      const center = (hi[i] + lo[i] + mean[i]) / 3;
      momentum[i] = close[i] - center;
      squeeze[i] = mean[i] + p.bbMultiplier * sd[i] < mean[i] + p.kcMultiplier * range[i] && mean[i] - p.bbMultiplier * sd[i] > mean[i] - p.kcMultiplier * range[i] ? 1 : 0;
    }
    return { momentum, squeeze };
  },
};
