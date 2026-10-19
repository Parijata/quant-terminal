import { src, nan } from "./_helpers.mjs";

export default {
  name: "VWAP (Custom)", group: "Volume", overlay: true,
  inputs: [
    { key: "source", label: "Price source", type: "source", default: "hlc3" },
    { key: "anchor", label: "Reset period", type: "select", options: ["day", "week", "month", "year"], default: "day" },
  ],
  outputs: [{ key: "vwap", label: "VWAP", color: "#39ff14", lineWidth: 2 }],
  calc(bars, p) {
    const prices = src(bars, p.source), vwap = nan(bars.length);
    let key = "", pv = 0, volume = 0;
    for (let i = 0; i < bars.length; i++) {
      const d = new Date(bars[i].time * 1000);
      const next = p.anchor === "year" ? d.getUTCFullYear() : p.anchor === "month" ? `${d.getUTCFullYear()}-${d.getUTCMonth()}` : p.anchor === "week" ? Math.floor((bars[i].time / 86400 + 3) / 7) : Math.floor(bars[i].time / 86400);
      if (next !== key) { key = next; pv = 0; volume = 0; }
      const v = bars[i].volume || 0; pv += prices[i] * v; volume += v;
      if (volume) vwap[i] = pv / volume;
    }
    return { vwap };
  },
};
