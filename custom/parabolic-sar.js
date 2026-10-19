export default {
  name: "Parabolic SAR (Custom)", group: "Trend", overlay: true,
  inputs: [
    { key: "start", label: "Start", type: "float", default: 0.02, min: 0.001 },
    { key: "increment", label: "Increment", type: "float", default: 0.02, min: 0.001 },
    { key: "maximum", label: "Maximum", type: "float", default: 0.2, min: 0.01 },
  ],
  outputs: [{ key: "sar", label: "SAR", color: "#39ff14", dots: true }],
  calc(bars, p, ta) { return { sar: ta.psar(bars, p.start, p.increment, p.maximum) }; },
};
