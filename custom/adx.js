import { nan, atr } from "./_helpers.mjs";

function rma(values, length) {
  const n = Math.max(1, Math.floor(length)), out = nan(values.length); let prev = NaN;
  for (let i = 0; i < values.length; i++) {
    if (i === n - 1) prev = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
    else if (i >= n) prev = (prev * (n - 1) + values[i]) / n;
    if (i >= n - 1) out[i] = prev;
  }
  return out;
}

export default {
  name: "ADX / DMI (Custom)", group: "Trend", overlay: false,
  inputs: [{ key: "length", label: "Length", type: "int", default: 14, min: 1 }],
  outputs: [
    { key: "adx", label: "ADX", color: "#39ff14", lineWidth: 2 },
    { key: "plusDI", label: "+DI", color: "#8cff5f" },
    { key: "minusDI", label: "-DI", color: "#b5ff00" },
  ], levels: [20, 25],
  calc(bars, p) {
    const n = bars.length, plus = nan(n), minus = nan(n);
    for (let i = 1; i < n; i++) {
      const up = bars[i].high - bars[i - 1].high, down = bars[i - 1].low - bars[i].low;
      plus[i] = up > down && up > 0 ? up : 0; minus[i] = down > up && down > 0 ? down : 0;
    }
    if (n) plus[0] = minus[0] = 0;
    const range = atr(bars, p.length), smoothPlus = rma(plus, p.length), smoothMinus = rma(minus, p.length);
    const plusDI = range.map((v, i) => v ? 100 * smoothPlus[i] / v : NaN), minusDI = range.map((v, i) => v ? 100 * smoothMinus[i] / v : NaN);
    const dx = plusDI.map((v, i) => Number.isFinite(v + minusDI[i]) && v + minusDI[i] ? 100 * Math.abs(v - minusDI[i]) / (v + minusDI[i]) : NaN);
    return { adx: rma(dx, p.length), plusDI, minusDI };
  },
};
