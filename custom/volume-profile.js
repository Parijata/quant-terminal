import { nan } from "./_helpers.mjs";

export default {
  name: "Volume Profile (Custom)", group: "Volume", overlay: true,
  inputs: [
    { key: "rows", label: "Rows", type: "int", default: 24, min: 4 },
    { key: "width", label: "Width (% of chart)", type: "int", default: 30, min: 5 },
    { key: "valueArea", label: "Value area %", type: "int", default: 70, min: 10 },
  ],
  outputs: [{ key: "value", label: "Profile", color: "#39ff14" }],
  calc(bars, p) {
    return { value: nan(bars.length), volumeProfile: { rows: p.rows, width: p.width, valueArea: p.valueArea } };
  },
};
