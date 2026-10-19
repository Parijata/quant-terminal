import { nan } from "./_helpers.mjs";
export default {
  name: "Aroon (Custom)", group: "Trend", overlay: false,
  inputs: [{ key: "length", label: "Length", type: "int", default: 25, min: 2 }],
  outputs: [{ key: "up", label: "Aroon Up", color: "#39ff14" }, { key: "down", label: "Aroon Down", color: "#ff5c5c" }], levels: [30, 70],
  calc(bars, p) {
    const up = nan(bars.length), down = nan(bars.length), n = Math.max(2, p.length | 0);
    for (let i = n - 1; i < bars.length; i++) {
      let hi = -Infinity, lo = Infinity, hiAt = 0, loAt = 0;
      for (let j = i - n + 1; j <= i; j++) { if (bars[j].high >= hi) { hi = bars[j].high; hiAt = j; } if (bars[j].low <= lo) { lo = bars[j].low; loAt = j; } }
      up[i] = 100 * (hiAt - (i - n + 1)) / (n - 1); down[i] = 100 * (loAt - (i - n + 1)) / (n - 1);
    }
    return { up, down };
  },
};
