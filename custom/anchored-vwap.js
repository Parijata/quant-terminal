import { src, nan } from "./_helpers.mjs";

export default {
  name: "Anchored VWAP (Custom)", group: "Volume", overlay: true,
  inputs: [
    { key: "anchor", label: "Anchor time", type: "time", default: 0 },
    { key: "source", label: "Price source", type: "source", default: "hlc3" },
  ],
  outputs: [{ key: "vwap", label: "Anchored VWAP", color: "#b5ff00", lineWidth: 2 }],
  calc(bars, p) {
    const prices = src(bars, p.source), vwap = nan(bars.length);
    let start = p.anchor ? bars.findIndex((b) => b.time >= p.anchor) : Math.max(0, bars.length - 150);
    if (start < 0) return { vwap };
    let pv = 0, volume = 0;
    for (let i = start; i < bars.length; i++) {
      const v = bars[i].volume || 0; pv += prices[i] * v; volume += v;
      if (volume) vwap[i] = pv / volume;
    }
    return { vwap };
  },
};
