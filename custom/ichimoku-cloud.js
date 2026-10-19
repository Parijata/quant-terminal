import { nan, rollingMid } from "./_helpers.mjs";

export default {
  name: "Ichimoku Cloud (Custom)", group: "Trend", overlay: true,
  inputs: [
    { key: "conversion", label: "Conversion period", type: "int", default: 9, min: 1 },
    { key: "base", label: "Base period", type: "int", default: 26, min: 1 },
    { key: "spanB", label: "Leading span B period", type: "int", default: 52, min: 1 },
    { key: "displacement", label: "Displacement", type: "int", default: 26, min: 1 },
  ],
  outputs: [
    { key: "conversionLine", label: "Conversion", color: "#39ff14" },
    { key: "baseLine", label: "Base", color: "#8cff5f" },
    { key: "spanA", label: "Span A", color: "#21d84b" },
    { key: "spanB", label: "Span B", color: "#b5ff00" },
    { key: "lagging", label: "Lagging", color: "#c8ffd0" },
  ],
  calc(bars, p) {
    const n = bars.length, conversion = rollingMid(bars, p.conversion, p.conversion), base = rollingMid(bars, p.base, p.base), rawB = rollingMid(bars, p.spanB, p.spanB);
    const spanA = nan(n), spanB = nan(n), lagging = nan(n);
    for (let i = 0; i < n; i++) {
      if (i + p.displacement < n && Number.isFinite(conversion[i]) && Number.isFinite(base[i])) spanA[i + p.displacement] = (conversion[i] + base[i]) / 2;
      if (i + p.displacement < n && Number.isFinite(rawB[i])) spanB[i + p.displacement] = rawB[i];
      if (i - p.displacement >= 0) lagging[i - p.displacement] = bars[i].close;
    }
    return { conversionLine: conversion, baseLine: base, spanA, spanB, lagging };
  },
};
