export const nan = (n) => Array(n).fill(NaN);

export function src(bars, key = "hlc3") {
  return bars.map((b) => key === "open" ? b.open : key === "high" ? b.high : key === "low" ? b.low : key === "close" ? b.close : key === "hl2" ? (b.high + b.low) / 2 : key === "ohlc4" ? (b.open + b.high + b.low + b.close) / 4 : (b.high + b.low + b.close) / 3);
}

export function sma(values, length) {
  const n = Math.max(1, Math.floor(length)), out = nan(values.length);
  let sum = 0, invalid = 0;
  for (let i = 0; i < values.length; i++) {
    if (Number.isFinite(values[i])) sum += values[i]; else invalid++;
    if (i >= n) {
      if (Number.isFinite(values[i - n])) sum -= values[i - n]; else invalid--;
    }
    if (i >= n - 1 && invalid === 0) out[i] = sum / n;
  }
  return out;
}

export function ema(values, length) {
  const n = Math.max(1, Math.floor(length)), out = nan(values.length), seed = sma(values, n);
  const alpha = 2 / (n + 1);
  let prev = NaN;
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(prev)) {
      if (Number.isFinite(seed[i])) prev = seed[i];
    } else prev = values[i] * alpha + prev * (1 - alpha);
    if (Number.isFinite(prev)) out[i] = prev;
  }
  return out;
}

export function stdev(values, length) {
  const n = Math.max(1, Math.floor(length)), out = nan(values.length);
  for (let i = n - 1; i < values.length; i++) {
    const w = values.slice(i - n + 1, i + 1);
    if (!w.every(Number.isFinite)) continue;
    const mean = w.reduce((a, b) => a + b, 0) / n;
    out[i] = Math.sqrt(w.reduce((a, x) => a + (x - mean) ** 2, 0) / n);
  }
  return out;
}

export function extremes(values, length, high = true) {
  const n = Math.max(1, Math.floor(length)), out = nan(values.length);
  for (let i = n - 1; i < values.length; i++) {
    const w = values.slice(i - n + 1, i + 1);
    out[i] = high ? Math.max(...w) : Math.min(...w);
  }
  return out;
}

export function atr(bars, length) {
  const tr = bars.map((b, i) => i ? Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)) : b.high - b.low);
  const n = Math.max(1, Math.floor(length)), out = nan(bars.length);
  let prev = NaN;
  for (let i = 0; i < tr.length; i++) {
    if (i === n - 1) prev = tr.slice(0, n).reduce((a, b) => a + b, 0) / n;
    else if (i >= n) prev = (prev * (n - 1) + tr[i]) / n;
    if (i >= n - 1) out[i] = prev;
  }
  return out;
}

export function rollingMid(bars, start, end) {
  const hi = extremes(bars.map((b) => b.high), start, true),
    lo = extremes(bars.map((b) => b.low), end, false);
  return hi.map((v, i) => Number.isFinite(v) && Number.isFinite(lo[i]) ? (v + lo[i]) / 2 : NaN);
}
