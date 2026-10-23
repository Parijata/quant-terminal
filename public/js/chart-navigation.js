// Pure time-range calculations used by each chart's navigation controls.
export function navigationRange(action, range, count, margin = 8) {
  if (!count) return null;
  const width = range ? Math.max(1, range.to - range.from) : Math.min(160, count);
  if (action === "reset") return { fit: true };
  if (action === "latest") return { from: Math.max(0, count - width + margin), to: count + margin };
  if (!range) return null;
  if (action === "in" || action === "out") {
    const next = Math.max(5, width * (action === "in" ? 0.8 : 1.25));
    const center = (range.from + range.to) / 2;
    return { from: center - next / 2, to: center + next / 2 };
  }
  if (action === "left") {
    const from = Math.max(0, range.from - width * 0.2);
    return { from, to: Math.max(from + width, range.to - width * 0.2) };
  }
  if (action === "right") {
    if (range.to >= count + margin - 1) return range;
    const to = Math.min(count + margin, range.to + width * 0.2);
    return { from: Math.max(0, to - width), to };
  }
  return null;
}

export function clampVisibleRange(range, count, margin = 8, fallbackWidth = 160) {
  if (!range || !count) return null;
  const maxTo = count + Math.max(0, margin);
  const oldWidth = Number(range.to) - Number(range.from);
  const width = Math.max(1, Math.min(maxTo, Number.isFinite(oldWidth) && oldWidth > 0 ? oldWidth : fallbackWidth));
  if (!Number.isFinite(Number(range.from)) || !Number.isFinite(Number(range.to)) || Number(range.from) >= count || Number(range.to) > maxTo) {
    const from = Math.max(0, count - width);
    return { from, to: Math.min(maxTo, from + width) };
  }
  const from = Math.max(0, Number(range.from));
  return { from, to: Math.min(maxTo, Math.max(from + 1, Number(range.to))) };
}
