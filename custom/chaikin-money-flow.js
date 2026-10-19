import { nan } from "./_helpers.mjs";

export default {
  name: "Chaikin Money Flow (Advanced)", group: "Advanced", overlay: false,
  inputs: [{ key: "length", label: "Length", type: "int", default: 20, min: 1 }],
  outputs: [{ key: "cmf", label: "CMF", color: "#39ff14", lineWidth: 2 }], levels: [0],
  calc(bars, p) {
    const out = nan(bars.length);
    for (let i = p.length - 1; i < bars.length; i++) {
      let flowVolume = 0, volume = 0;
      for (let j = i - p.length + 1; j <= i; j++) {
        const b = bars[j], v = b.volume || 0, span = b.high - b.low;
        flowVolume += (span ? ((2 * b.close - b.high - b.low) / span) : 0) * v;
        volume += v;
      }
      if (volume) out[i] = flowVolume / volume;
    }
    return { cmf: out };
  },
};
