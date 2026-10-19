import { src, nan, extremes, sma } from "./_helpers.mjs";

function rsi(values, length) {
  const n = Math.max(1, Math.floor(length)), out = nan(values.length); let gain = 0, loss = 0, ag = NaN, al = NaN;
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1], g = Math.max(0, d), l = Math.max(0, -d);
    if (i <= n) { gain += g; loss += l; if (i === n) { ag = gain / n; al = loss / n; } }
    else { ag = (ag * (n - 1) + g) / n; al = (al * (n - 1) + l) / n; }
    if (i >= n) out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

export default {
  name: "Stochastic RSI (Custom)", group: "Momentum", overlay: false,
  inputs: [
    { key: "rsiLength", label: "RSI length", type: "int", default: 14, min: 1 },
    { key: "stochLength", label: "Stochastic length", type: "int", default: 14, min: 1 },
    { key: "smoothK", label: "%K smoothing", type: "int", default: 3, min: 1 },
    { key: "smoothD", label: "%D smoothing", type: "int", default: 3, min: 1 },
  ],
  outputs: [{ key: "k", label: "%K", color: "#39ff14" }, { key: "d", label: "%D", color: "#b5ff00" }], levels: [20, 80],
  calc(bars, p) {
    const values = rsi(src(bars, "close"), p.rsiLength), lo = extremes(values, p.stochLength, false), hi = extremes(values, p.stochLength, true);
    const raw = values.map((v, i) => Number.isFinite(v) && hi[i] !== lo[i] ? 100 * (v - lo[i]) / (hi[i] - lo[i]) : NaN);
    const k = sma(raw, p.smoothK), d = sma(k, p.smoothD);
    return { k, d };
  },
};
