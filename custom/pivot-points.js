import { nan } from "./_helpers.mjs";

export default {
  name: "Pivot Points (Custom)", group: "Levels", overlay: true,
  inputs: [],
  outputs: [
    { key: "pivot", label: "Pivot", color: "#39ff14" },
    { key: "r1", label: "R1", color: "#8cff5f" }, { key: "s1", label: "S1", color: "#8cff5f" },
    { key: "r2", label: "R2", color: "#b5ff00" }, { key: "s2", label: "S2", color: "#b5ff00" },
  ],
  calc(bars) {
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
        const p = (prev.high + prev.low + prev.close) / 3, r1 = 2 * p - prev.low, s1 = 2 * p - prev.high;
        const vals = { pivot: p, r1, s1, r2: p + prev.high - prev.low, s2: p - prev.high + prev.low };
        for (const k of keys) for (let i = d.start; i < d.end; i++) out[k][i] = vals[k];
      }
      prev = d;
    }
    return out;
  },
};
