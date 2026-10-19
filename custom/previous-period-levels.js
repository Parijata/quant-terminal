import { nan } from "./_helpers.mjs";
function periodKey(time, period) {
  const d = new Date(time * 1000), y = d.getUTCFullYear(), m = d.getUTCMonth();
  if (period === "month") return `${y}-${m}`;
  if (period === "week") return Math.floor((time / 86400 + 3) / 7);
  return Math.floor(time / 86400);
}
function priorLevels(bars, period) {
  const high = nan(bars.length), low = nan(bars.length), groups = [];
  for (let i = 0; i < bars.length; i++) {
    const key = periodKey(bars[i].time, period);
    let g = groups.at(-1);
    if (!g || g.key !== key) groups.push(g = { key, start: i, high: bars[i].high, low: bars[i].low });
    g.end = i + 1; g.high = Math.max(g.high, bars[i].high); g.low = Math.min(g.low, bars[i].low);
  }
  for (let j = 1; j < groups.length; j++)
    for (let i = groups[j].start; i < groups[j].end; i++) { high[i] = groups[j - 1].high; low[i] = groups[j - 1].low; }
  return { high, low };
}
export default {
  name: "Previous Day/Week/Month High/Low (Custom)", group: "Levels", overlay: true,
  inputs: [],
  outputs: [
    { key: "dayHigh", label: "Previous day high", color: "#39ff14" }, { key: "dayLow", label: "Previous day low", color: "#8cff5f" },
    { key: "weekHigh", label: "Previous week high", color: "#b5ff00" }, { key: "weekLow", label: "Previous week low", color: "#21d84b" },
    { key: "monthHigh", label: "Previous month high", color: "#c8ffd0" }, { key: "monthLow", label: "Previous month low", color: "#79c753" },
  ],
  calc(bars) {
    const d = priorLevels(bars, "day"), w = priorLevels(bars, "week"), m = priorLevels(bars, "month");
    return { dayHigh: d.high, dayLow: d.low, weekHigh: w.high, weekLow: w.low, monthHigh: m.high, monthLow: m.low };
  },
};
