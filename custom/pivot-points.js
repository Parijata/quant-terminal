import { nan } from "./_helpers.mjs";

export default {
  name: "Pivot Points (Custom)", group: "Levels", overlay: true,
  inputs: [{ key: "method", label: "Calculation", type: "select", options: ["Classic", "Fibonacci", "Camarilla"], default: "Classic" }],
  outputs: [
    { key: "pivot", label: "Pivot", color: "#39ff14" },
    { key: "r1", label: "R1", color: "#8cff5f" }, { key: "s1", label: "S1", color: "#8cff5f" },
    { key: "r2", label: "R2", color: "#b5ff00" }, { key: "s2", label: "S2", color: "#b5ff00" },
  ],
  calc(bars, params) {
    const keys = ["pivot", "r1", "s1", "r2", "s2"], out = Object.fromEntries(keys.map((k) => [k, nan(bars.length)]));
    const days = new Map();
    for (let i = 0; i < bars.length; i++) {
      const day = Math.floor(bars[i].time / 86400);
      if (!days.has(day)) days.set(day, { start: i, high: bars[i].high, low: bars[i].low, close: bars[i].close });
      const d = days.get(day); d.end = i + 1; d.high = Math.max(d.high, bars[i].high); d.low = Math.min(d.low, bars[i].low); d.close = bars[i].close;
    }
    let prev = null;
    for (const d of days.values()) {
      if (prev) {
        const pivot = (prev.high + prev.low + prev.close) / 3, range = prev.high - prev.low;
        const method = params.method || "Classic";
        const levels = method === "Fibonacci"
          ? { pivot, r1: pivot + range * .382, s1: pivot - range * .382, r2: pivot + range * .618, s2: pivot - range * .618 }
          : method === "Camarilla"
            ? { pivot, r1: prev.close + range * 1.1 / 12, s1: prev.close - range * 1.1 / 12, r2: prev.close + range * 1.1 / 6, s2: prev.close - range * 1.1 / 6 }
            : { pivot, r1: 2 * pivot - prev.low, s1: 2 * pivot - prev.high, r2: pivot + range, s2: pivot - range };
        for (const k of keys) for (let i = d.start; i < d.end; i++) out[k][i] = levels[k];
      }
      prev = d;
    }
    return out;
  },
};
