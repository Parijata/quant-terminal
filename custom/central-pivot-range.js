import { nan } from "./_helpers.mjs";

function periodKey(time, period) {
  const date = new Date(time * 1000);
  if (period === "Week") return `w${Math.floor((Math.floor(time / 86400) + 3) / 7)}`;
  if (period === "Month") return `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
  return `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}`;
}

export default {
  name: "Central Pivot Range (CPR)",
  group: "Levels",
  overlay: true,
  inputs: [{ key: "period", label: "Pivot period", type: "select", options: ["Day", "Week", "Month"], default: "Day" }],
  outputs: [
    { key: "pivot", label: "Pivot", color: "#087f68", lineWidth: 2 },
    { key: "bc", label: "BC", color: "#526a9c" },
    { key: "tc", label: "TC", color: "#8a527b" },
  ],
  calc(bars, params) {
    const keys = ["pivot", "bc", "tc"];
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
      const pivot = (prev.high + prev.low + prev.close) / 3;
      const bc = (prev.high + prev.low) / 2;
      const tc = 2 * pivot - bc;
      for (let i = groups[g].start; i < groups[g].end; i++) {
        out.pivot[i] = pivot;
        out.bc[i] = Math.min(bc, tc);
        out.tc[i] = Math.max(bc, tc);
      }
    }
    return out;
  },
};
