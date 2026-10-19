import { nan } from "./_helpers.mjs";

export default {
  name: "Money Flow Index (Advanced)", group: "Advanced", overlay: false,
  inputs: [{ key: "length", label: "Length", type: "int", default: 14, min: 1 }],
  outputs: [{ key: "mfi", label: "MFI", color: "#39ff14", lineWidth: 2 }], levels: [20, 50, 80],
  calc(bars, p) {
    const out = nan(bars.length), typical = bars.map((b) => (b.high + b.low + b.close) / 3);
    for (let i = p.length; i < bars.length; i++) {
      let positive = 0, negative = 0;
      for (let j = i - p.length + 1; j <= i; j++) {
        const flow = typical[j] * (bars[j].volume || 0);
        if (typical[j] > typical[j - 1]) positive += flow;
        else if (typical[j] < typical[j - 1]) negative += flow;
      }
      out[i] = negative === 0 ? 100 : positive === 0 ? 0 : 100 - 100 / (1 + positive / negative);
    }
    return { mfi: out };
  },
};
