import { src, sma, stdev } from "./_helpers.mjs";

export default {
  name: "Bollinger Bands (Custom)", group: "Volatility", overlay: true,
  inputs: [
    { key: "length", label: "Length", type: "int", default: 20, min: 1 },
    { key: "deviations", label: "Deviation multiplier", type: "float", default: 2, min: 0 },
    { key: "source", label: "Price source", type: "source", default: "close" },
  ],
  outputs: [
    { key: "upper", label: "Upper", color: "#8cff5f" },
    { key: "basis", label: "Basis", color: "#39ff14" },
    { key: "lower", label: "Lower", color: "#b5ff00" },
  ],
  calc(bars, p) {
    const prices = src(bars, p.source), basis = sma(prices, p.length), sd = stdev(prices, p.length);
    return { basis, upper: basis.map((v, i) => v + p.deviations * sd[i]), lower: basis.map((v, i) => v - p.deviations * sd[i]) };
  },
};
