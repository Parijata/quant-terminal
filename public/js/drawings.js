// Drawing tools, rendered as a Lightweight Charts series primitive. Points are stored as
// { time (UTC seconds), price } so drawings stay put when you change timeframe.

export const TOOLS = [
  { id: "cursor", label: "Cursor", icon: '<path d="M5 3l14 7-6 2-2 6z"/>' },
  {
    id: "trend",
    label: "Trend line",
    points: 2,
    icon: '<path d="M4 19L20 5"/><circle cx="4" cy="19" r="1.6"/><circle cx="20" cy="5" r="1.6"/>',
  },
  {
    id: "ray",
    label: "Ray",
    points: 2,
    icon: '<path d="M4 19L21 4"/><circle cx="4" cy="19" r="1.6"/><circle cx="11" cy="13" r="1.6"/>',
  },
  {
    id: "extended",
    label: "Extended line",
    points: 2,
    icon: '<path d="M2 21L22 3"/><circle cx="8" cy="16" r="1.6"/><circle cx="16" cy="9" r="1.6"/>',
  },
  {
    id: "arrow",
    label: "Arrow",
    points: 2,
    icon: '<path d="M4 20L19 5M10 5h9v9"/>',
  },
  {
    id: "hline",
    label: "Horizontal line",
    points: 1,
    icon: '<path d="M3 12h18"/><circle cx="12" cy="12" r="1.6"/>',
  },
  {
    id: "hray",
    label: "Horizontal ray",
    points: 1,
    icon: '<path d="M8 12h13"/><circle cx="8" cy="12" r="1.6"/>',
  },
  {
    id: "vline",
    label: "Vertical line",
    points: 1,
    icon: '<path d="M12 3v18"/><circle cx="12" cy="12" r="1.6"/>',
  },
  {
    id: "channel",
    label: "Parallel channel",
    points: 3,
    icon: '<path d="M3 15L15 5M9 21l12-10"/>',
  },
  {
    id: "rect",
    label: "Rectangle",
    points: 2,
    icon: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
  },
  {
    id: "fib",
    label: "Fib retracement",
    points: 2,
    icon: '<path d="M3 5h18M3 10h18M3 14h18M3 19h18" stroke-dasharray="2 2"/>',
  },
  {
    id: "fibext",
    label: "Fibonacci extension",
    points: 2,
    icon: '<path d="M3 19h18M3 12h18M3 5h18" stroke-dasharray="2 2"/>',
  },
  {
    id: "measure",
    label: "Measure",
    points: 2,
    icon: '<path d="M4 20L20 4M7 17l-2-2M11 13l-2-2M15 9l-2-2M19 5l-2-2"/>',
  },
  {
    id: "long",
    label: "Long position",
    points: 2,
    icon: '<rect x="4" y="5" width="16" height="7" fill="currentColor" fill-opacity=".25"/><rect x="4" y="12" width="16" height="7"/>',
  },
  {
    id: "short",
    label: "Short position",
    points: 2,
    icon: '<rect x="4" y="5" width="16" height="7"/><rect x="4" y="12" width="16" height="7" fill="currentColor" fill-opacity=".25"/>',
  },
  {
    id: "text",
    label: "Text note",
    points: 1,
    icon: '<path d="M5 6h14M12 6v13"/>',
  },
];
export const TOOL_BY_ID = Object.fromEntries(TOOLS.map((t) => [t.id, t]));
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618];
export const FIB_EXT_LEVELS = [0, 0.618, 1, 1.272, 1.618, 2, 2.618];

const COLORS = {
  line: "#2962ff",
  fib: "#787b86",
  up: "rgba(8,153,129,",
  down: "rgba(242,54,69,",
};

export class DrawingLayer {
  constructor(pane) {
    this.pane = pane;
    this.items = [];
    this.temp = null;
    this.selected = null;
    this.history = [];
    this.historyIndex = -1;
    this._view = {
      zOrder: () => "top",
      renderer: () => ({
        draw: (target) =>
          target.useMediaCoordinateSpace(({ context, mediaSize }) =>
            this.draw(context, mediaSize),
          ),
      }),
    };
  }

  // --- ISeriesPrimitive ---
  attached({ series, requestUpdate }) {
    this.series = series;
    this.requestUpdate = requestUpdate;
  }
  detached() {
    this.series = null;
  }
  updateAllViews() {}
  paneViews() {
    return [this._view];
  }
  update() {
    this.requestUpdate?.();
  }

  x(t) {
    return this.pane.timeToX(t);
  }
  y(p) {
    return this.series?.priceToCoordinate(p) ?? null;
  }

  setItems(items) {
    this.items = structuredClone(items || []);
    this.selected = null;
    this.history = [structuredClone(this.items)];
    this.historyIndex = 0;
    this.update();
  }

  commit() {
    const snapshot = structuredClone(this.items);
    if (JSON.stringify(snapshot) === JSON.stringify(this.history[this.historyIndex])) return;
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(snapshot);
    if (this.history.length > 100) this.history.shift();
    this.historyIndex = this.history.length - 1;
  }

  undo() {
    if (this.historyIndex <= 0) return false;
    this.historyIndex--;
    this.items = structuredClone(this.history[this.historyIndex]);
    this.selected = null;
    this.update();
    return true;
  }

  redo() {
    if (this.historyIndex >= this.history.length - 1) return false;
    this.historyIndex++;
    this.items = structuredClone(this.history[this.historyIndex]);
    this.selected = null;
    this.update();
    return true;
  }

  draw(ctx, size) {
    if (this.pane.cfg.drawingsHidden) return;
    ctx.save();
    ctx.font = "11px -apple-system, Segoe UI, Roboto, sans-serif";
    for (const d of [...this.items, ...(this.temp ? [this.temp] : [])]) {
      try {
        this.drawOne(ctx, size, d, d === this.selected || d === this.temp);
      } catch {
        /* off-screen */
      }
    }
    ctx.restore();
  }

  drawOne(ctx, size, d, active) {
    const pts = d.points.map((p) => ({
      x: this.x(p.time),
      y: this.y(p.price),
      ...p,
    }));
    if (pts.some((p) => p.x == null || p.y == null)) return;
    const color = d.color || COLORS.line;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = active ? 2 : 1.5;
    ctx.setLineDash([]);
    const [a, b, c] = pts;
    const line = (x1, y1, x2, y2) => {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    };
    const label = (txt, x, y, align = "left", bg = null) => {
      ctx.textAlign = align;
      ctx.textBaseline = "middle";
      if (bg) {
        const w = ctx.measureText(txt).width + 10;
        ctx.fillStyle = bg;
        ctx.fillRect(
          align === "center" ? x - w / 2 : align === "right" ? x - w : x,
          y - 9,
          w,
          18,
        );
        ctx.fillStyle = "#fff";
        ctx.fillText(
          txt,
          align === "center" ? x : align === "right" ? x - 5 : x + 5,
          y,
        );
        ctx.fillStyle = color;
      } else ctx.fillText(txt, x, y);
    };
    const extend = (p, q, both) => {
      const dx = q.x - p.x,
        dy = q.y - p.y;
      if (dx === 0 && dy === 0) return [p, q];
      const far = 1e5;
      const len = Math.hypot(dx, dy);
      const e2 = { x: p.x + (dx / len) * far, y: p.y + (dy / len) * far };
      const e1 = both
        ? { x: p.x - (dx / len) * far, y: p.y - (dy / len) * far }
        : p;
      return [e1, e2];
    };
    const price = (v) => this.pane.formatPrice(v);

    switch (d.type) {
      case "trend":
        line(a.x, a.y, b.x, b.y);
        break;
      case "ray": {
        const [p, q] = extend(a, b, false);
        line(p.x, p.y, q.x, q.y);
        break;
      }
      case "extended": {
        const [p, q] = extend(a, b, true);
        line(p.x, p.y, q.x, q.y);
        break;
      }
      case "arrow": {
        line(a.x, a.y, b.x, b.y);
        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        const size = 10;
        ctx.beginPath();
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(b.x - size * Math.cos(angle - Math.PI / 6), b.y - size * Math.sin(angle - Math.PI / 6));
        ctx.lineTo(b.x - size * Math.cos(angle + Math.PI / 6), b.y - size * Math.sin(angle + Math.PI / 6));
        ctx.closePath();
        ctx.fill();
        break;
      }
      case "hline":
        line(0, a.y, size.width, a.y);
        label(price(a.price), size.width - 4, a.y - 10, "right");
        break;
      case "hray":
        line(a.x, a.y, size.width, a.y);
        label(price(a.price), size.width - 4, a.y - 10, "right");
        break;
      case "vline":
        line(a.x, 0, a.x, size.height);
        break;
      case "channel": {
        line(a.x, a.y, b.x, b.y);
        if (c) {
          const off =
            c.y - (a.y + ((b.y - a.y) * (c.x - a.x)) / (b.x - a.x || 1));
          line(a.x, a.y + off, b.x, b.y + off);
          ctx.globalAlpha = 0.08;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.lineTo(b.x, b.y + off);
          ctx.lineTo(a.x, a.y + off);
          ctx.closePath();
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        break;
      }
      case "rect": {
        ctx.globalAlpha = 0.12;
        ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
        ctx.globalAlpha = 1;
        ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
        break;
      }
      case "fib":
      case "fibext": {
        const x1 = Math.min(a.x, b.x),
          x2 = Math.max(a.x, b.x);
        ctx.strokeStyle = d.color || COLORS.fib;
        const levels = d.type === "fibext" ? FIB_EXT_LEVELS : FIB_LEVELS;
        for (const lv of levels) {
          const p = d.type === "fibext"
            ? a.price + (b.price - a.price) * lv
            : b.price + (a.price - b.price) * lv;
          const y = this.y(p);
          if (y == null) continue;
          ctx.globalAlpha = lv === 0.5 || lv === 0.618 ? 1 : 0.7;
          line(x1, y, x2, y);
          ctx.globalAlpha = 1;
          ctx.fillStyle = d.color || COLORS.fib;
          label(`${lv} (${price(p)})`, x1 + 2, y - 8);
        }
        ctx.setLineDash([3, 3]);
        line(a.x, a.y, b.x, b.y);
        ctx.setLineDash([]);
        break;
      }
      case "measure": {
        const up = b.price >= a.price;
        ctx.fillStyle = (up ? COLORS.up : COLORS.down) + "0.15)";
        ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
        ctx.strokeStyle = (up ? COLORS.up : COLORS.down) + "1)";
        line((a.x + b.x) / 2, a.y, (a.x + b.x) / 2, b.y);
        const bars = Math.round(
          this.pane.logicalOf(b.time) - this.pane.logicalOf(a.time),
        );
        const seconds = Math.abs(b.time - a.time);
        const duration = seconds >= 86400
          ? `${Math.floor(seconds / 86400)}d${Math.floor(seconds % 86400 / 3600) ? ` ${Math.floor(seconds % 86400 / 3600)}h` : ""}`
          : seconds >= 3600
            ? `${Math.floor(seconds / 3600)}h${Math.floor(seconds % 3600 / 60) ? ` ${Math.floor(seconds % 3600 / 60)}m` : ""}`
            : `${Math.max(1, Math.floor(seconds / 60))}m`;
        const diff = b.price - a.price,
          pct = (diff / a.price) * 100;
        ctx.fillStyle = (up ? COLORS.up : COLORS.down) + "1)";
        label(
          `${diff >= 0 ? "+" : ""}${price(diff)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)  ${bars} bars · ${duration}`,
          (a.x + b.x) / 2,
          b.y + (up ? -14 : 14),
          "center",
          (up ? COLORS.up : COLORS.down) + "0.9)",
        );
        break;
      }
      case "long":
      case "short": {
        // first point = entry, second point sets the stop (its price) and the width (its time); target = 2R
        const dir = d.type === "long" ? 1 : -1;
        const risk = Math.abs(a.price - b.price) || a.price * 0.01;
        const stop = a.price - dir * risk,
          target = a.price + dir * risk * (d.rr || 2);
        const ys = this.y(stop),
          yt = this.y(target);
        const x1 = Math.min(a.x, b.x),
          w = Math.max(Math.abs(b.x - a.x), 40);
        ctx.fillStyle = COLORS.up + "0.18)";
        ctx.fillRect(x1, a.y, w, yt - a.y);
        ctx.fillStyle = COLORS.down + "0.18)";
        ctx.fillRect(x1, a.y, w, ys - a.y);
        ctx.strokeStyle = "#787b86";
        line(x1, a.y, x1 + w, a.y);
        ctx.fillStyle = COLORS.up + "1)";
        label(
          `Target ${price(target)} (${(((target - a.price) / a.price) * 100 * dir).toFixed(2)}%)`,
          x1 + w / 2,
          yt + (dir > 0 ? 10 : -10),
          "center",
          COLORS.up + "0.9)",
        );
        label(
          `Stop ${price(stop)} (${(((a.price - stop) / a.price) * 100 * dir).toFixed(2)}%)`,
          x1 + w / 2,
          ys + (dir > 0 ? -10 : 10),
          "center",
          COLORS.down + "0.9)",
        );
        ctx.fillStyle = "#787b86";
        label(
          `Entry ${price(a.price)}  R:R ${(d.rr || 2).toFixed(1)}`,
          x1 + 4,
          a.y - 9,
        );
        break;
      }
      case "text": {
        ctx.font = "13px -apple-system, Segoe UI, Roboto, sans-serif";
        label(d.text || "Note", a.x, a.y, "left", d.color || COLORS.line);
        break;
      }
      default:
        break;
    }
    if (active) {
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      for (const p of pts) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  // Nearest drawing within a few pixels of (x, y), for selecting.
  hitTest(x, y) {
    let best = null,
      bestD = 7;
    const segDist = (p, q) => {
      const dx = q.x - p.x,
        dy = q.y - p.y,
        l2 = dx * dx + dy * dy;
      const t = l2
        ? Math.max(0, Math.min(1, ((x - p.x) * dx + (y - p.y) * dy) / l2))
        : 0;
      return Math.hypot(x - (p.x + t * dx), y - (p.y + t * dy));
    };
    for (const d of this.items) {
      const pts = d.points.map((p) => ({
        x: this.x(p.time),
        y: this.y(p.price),
      }));
      if (pts.some((p) => p.x == null || p.y == null)) continue;
      const [a, b] = pts;
      let dist = Infinity;
      if (d.type === "hline") dist = Math.abs(y - a.y);
      else if (d.type === "hray")
        dist = x >= a.x - 4 ? Math.abs(y - a.y) : Infinity;
      else if (d.type === "vline") dist = Math.abs(x - a.x);
      else if (d.type === "text")
        dist =
          x >= a.x - 4 && x <= a.x + 120 && Math.abs(y - a.y) < 12
            ? 0
            : Infinity;
      else if (["rect", "fib", "fibext", "measure", "long", "short"].includes(d.type)) {
        const inside =
          x >= Math.min(a.x, b.x) - 4 &&
          x <= Math.max(a.x, b.x, a.x + 40) + 4 &&
          y >= Math.min(a.y, b.y) - 40 &&
          y <= Math.max(a.y, b.y) + 40;
        dist = inside ? 3 : Infinity;
      } else if (b) {
        const far = (p, q, both) => {
          const dx = q.x - p.x,
            dy = q.y - p.y,
            len = Math.hypot(dx, dy) || 1;
          return [
            both ? { x: p.x - (dx / len) * 1e5, y: p.y - (dy / len) * 1e5 } : p,
            { x: p.x + (dx / len) * 1e5, y: p.y + (dy / len) * 1e5 },
          ];
        };
        const [p, q] =
          d.type === "ray"
            ? far(a, b, false)
            : d.type === "extended"
              ? far(a, b, true)
              : [a, b];
        dist = segDist(p, q);
      }
      if (dist < bestD) {
        bestD = dist;
        best = d;
      }
    }
    return best;
  }
}
