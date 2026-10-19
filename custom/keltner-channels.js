import { src, ema, atr } from "./_helpers.mjs";

export default {
  name: "Keltner Channels (Custom)", group: "Volatility", overlay: true,
  inputs: [
    { key: "length", label: "EMA length", type: "int", default: 20, min: 1 },
    { key: "atrLength", label: "ATR length", type: "int", default: 10, min: 1 },
    { key: "multiplier", label: "ATR multiplier", type: "float", default: 2, min: 0 },
    { key: "source", label: "Price source", type: "source", default: "close" },
  ],
  outputs: [
    { key: "upper", label: "Upper", color: "#8cff5f" },
    { key: "middle", label: "Middle", color: "#39ff14" },
    { key: "lower", label: "Lower", color: "#b5ff00" },
  ],
  calc(bars, p) {
    const middle = ema(src(bars, p.source), p.length), range = atr(bars, p.atrLength);
    return { middle, upper: middle.map((v, i) => v + p.multiplier * range[i]), lower: middle.map((v, i) => v - p.multiplier * range[i]) };
  },
};
