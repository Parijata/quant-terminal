import { nan } from "./_helpers.mjs";

function periodKey(time, period) {
  const date = new Date(time * 1000);
  if (period === "Week") return `w${Math.floor((Math.floor(time / 86400) + 3) / 7)}`;
  if (period === "Month") return `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
  return `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}`;
}

export default {
  name: "Woodie Pivot Points",
  group: "Levels",
  overlay: true,
  inputs: [{ key: "period", label: "Pivot period", type: "select", options: ["Day", "Week", "Month"], default: "Day" }],
  outputs: [
    { key: "pivot", label: "Pivot", color: "#087f68", lineWidth: 2 },
    { key: "r1", label: "R1", color: "#a45d52" },
    { key: "s1", label: "S1", color: "#527d68" },
    { key: "r2", label: "R2", color: "#a45d52" },
    { key: "s2", label: "S2", color: "#527d68" },
    { key: "r3", label: "R3", color: "#a45d52" },
    { key: "s3", label: "S3", color: "#527d68" },
  ],
  calc(bars, params) {
    const keys = ["pivot", "r1", "s1", "r2", "s2", "r3", "s3"];
    const out = Object.fromEntries(keys.map((key) => [key, nan(bars.length)]));
    const groups = [];
    const period = params.period || "Day";
    for (let i = 0; i < bars.length; i++) {
      const key = periodKey(bars[i].time, period);
      let group = groups.at(-1);
      if (!group || group.key !== key) groups.push(group = { key, start: i, high: bars[i].high, low: bars[i].low });
      group.end = i + 1;
      group.high = Math.max(group.high, bars[i].high);
      group.low = Math.min(group.low, bars[i].low);
      group.close = bars[i].close;
    }
    for (let g = 1; g < groups.length; g++) {
      const prev = groups[g - 1];
      const pivot = (prev.high + prev.low + 2 * prev.close) / 4;
      const range = prev.high - prev.low;
      const levels = {
        pivot,
        r1: 2 * pivot - prev.low,
        s1: 2 * pivot - prev.high,
        r2: pivot + range,
        s2: pivot - range,
        r3: prev.high + 2 * (pivot - prev.low),
        s3: prev.low - 2 * (prev.high - pivot),
      };
      for (let i = groups[g].start; i < groups[g].end; i++)
        for (const key of keys) out[key][i] = levels[key];
    }
    return out;
  },
};
