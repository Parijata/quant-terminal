import { atr, nan } from "./_helpers.mjs";

export default {
  name: "Supertrend (Custom)", group: "Trend", overlay: true,
  inputs: [
    { key: "length", label: "ATR length", type: "int", default: 10, min: 1 },
    { key: "factor", label: "Factor", type: "float", default: 3, min: 0.1 },
  ],
  outputs: [
    { key: "up", label: "Up trend", kind: "line", color: "#39ff14", lineWidth: 2 },
    { key: "down", label: "Down trend", kind: "line", color: "#8cff5f", lineWidth: 2 },
  ],
  calc(bars, p) {
    const a = atr(bars, p.length), up = nan(bars.length), down = nan(bars.length);
    let upper = NaN, lower = NaN, dir = 1;
    for (let i = 0; i < bars.length; i++) {
      if (!Number.isFinite(a[i])) continue;
      const mid = (bars[i].high + bars[i].low) / 2, basicU = mid + p.factor * a[i], basicL = mid - p.factor * a[i];
      upper = i && Number.isFinite(upper) && bars[i - 1].close <= upper ? Math.min(basicU, upper) : basicU;
      lower = i && Number.isFinite(lower) && bars[i - 1].close >= lower ? Math.max(basicL, lower) : basicL;
      if (dir > 0 && bars[i].close < lower) dir = -1;
      else if (dir < 0 && bars[i].close > upper) dir = 1;
      if (dir > 0) up[i] = lower; else down[i] = upper;
    }
    return { up, down };
  },
};
