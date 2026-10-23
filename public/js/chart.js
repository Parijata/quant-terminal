// One chart: candles + volume + any number of indicators, drawings, compare symbols, replay and live data.
import { api, fmtPrice, formatSymbolPrice, fmtPct, esc, ticker, exchange, displayExchange } from "./api.js";
import { BY_ID, compute, periodKey } from "../lib/indicators.js";
import {
  parseTf,
  isIntraday,
  heikinAshi,
  renko,
  lineBreak,
  rangeBars,
  kagi,
  pointFigure,
} from "../lib/series.js";
import { DrawingLayer, TOOL_BY_ID } from "./drawings.js";
import { VolumeProfile, SessionVolumeProfile } from "./volume-profile.js";
import { navigationRange, clampVisibleRange } from "./chart-navigation.js";

const LW = window.LightweightCharts;

export const CHART_TYPES = [
  ["candles", "Candlestick"],
  ["hollow", "Hollow candles"],
  ["bars", "Bars"],
  ["heikin", "Heikin Ashi"],
  ["line", "Line"],
  ["linemarkers", "Line with markers"],
  ["step", "Step line"],
  ["area", "Area"],
  ["baseline", "Baseline"],
  ["columns", "Columns"],
  ["renko", "Renko"],
  ["linebreak", "Line break"],
  ["range", "Range bars"],
  ["kagi", "Kagi"],
  ["pnf", "Point & figure"],
];
// Chart types built from price alone, with no meaningful volume per bar.
const PRICE_ONLY = ["renko", "linebreak", "kagi", "pnf"];
const BINANCE_WS_TF = {
  "1s": "1s",
  "1m": "1m",
  "3m": "3m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1h",
  "2h": "2h",
  "4h": "4h",
  "6h": "6h",
  "8h": "8h",
  "12h": "12h",
  "1D": "1d",
  "3D": "3d",
  "1W": "1w",
  "1M": "1M",
};
const ICON = {
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>',
  eye: '<svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};
const css = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();
let uidSeq = 0;
export const newUid = () =>
  `i${Date.now().toString(36)}${(uidSeq++).toString(36)}`;

// A chart line can't skip a blank point: it joins the neighbours. A segment takes the colour of
// the point it starts from, so hiding a gap means making the point before it transparent and
// parking the gap's points (invisibly) at the next real value.
const CLEAR = "rgba(0,0,0,0)";
function lineData(vals, breaks, timeAt, n) {
  const out = [];
  const next = new Array(vals.length);
  let nv = NaN;
  for (let i = vals.length - 1; i >= 0; i--) { if (Number.isFinite(vals[i])) nv = vals[i]; next[i] = nv; }
  let started = false;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i], time = timeAt(i);
    if (!Number.isFinite(v)) {
      if (i >= n) continue;
      out.push(started && Number.isFinite(next[i]) ? { time, value: next[i], color: CLEAR } : { time });
      continue;
    }
    started = true;
    const gapAhead = i + 1 < vals.length && (!Number.isFinite(vals[i + 1]) || breaks?.[i + 1]);
    out.push(gapAhead ? { time, value: v, color: CLEAR } : { time, value: v });
  }
  return out;
}
function histData(vals, colors, timeAt, n) {
  const out = [];
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (i >= n && !Number.isFinite(v)) continue;
    if (!Number.isFinite(v)) out.push({ time: timeAt(i) });
    else out.push(colors ? { time: timeAt(i), value: v, color: colors[i] } : { time: timeAt(i), value: v });
  }
  return out;
}

// Higher-timeframe values onto chart bars. A chart bar sees a higher-timeframe bar only once that
// bar has finished, except inside the newest one, where it shows the still-forming value (as
// TradingView does in real time).
function mapToChart(res, hb, htf, cb, ctf) {
  const hSec = parseTf(htf).seconds, cSec = parseTf(ctf).seconds;
  const end = (j) => (j + 1 < hb.length ? hb[j + 1].time : hb[j].time + hSec);
  const idx = new Array(cb.length).fill(-1);
  let j = -1;
  for (let i = 0; i < cb.length; i++) {
    const cEnd = cb[i].time + cSec;
    while (j + 1 < hb.length && end(j + 1) <= cEnd) j++;
    idx[i] = j + 1 === hb.length - 1 && cb[i].time >= hb[hb.length - 1].time ? hb.length - 1 : j;
  }
  const out = {};
  for (const [k, v] of Object.entries(res)) {
    if (k === "markers") continue;
    out[k] = Array.isArray(v) && v.length >= hb.length ? idx.map((x) => (x >= 0 ? v[x] : NaN)) : v;
  }
  return out;
}

export class ChartPane {
  constructor(app, el, cfg) {
    this.app = app;
    this.el = el;
    this.cfg = {
      symbol: "BINANCE:BTCUSDT",
      tf: "1D",
      type: "candles",
      indicators: [],
      compare: [],
      log: false,
      scale: undefined,
      ...cfg,
    };
    this.bars = [];
    this.shown = [];
    this.times = [];
    this.indSeries = new Map();
    this.indResults = {};
    this.compareSeries = new Map();
    this.extraMarkers = [];
    this.eventMarkers = [];
    this._indicatorMarkers = [];
    this._eventLoadKey = "";
    this._eventLoadToken = 0;
    this.alertLines = [];
    this._alertLineKey = "";
    this.replay = null;
    el.innerHTML =
      '<div class="chart"></div><div class="legend"></div><div class="pane-msg hidden"></div><div class="chart-controls" aria-label="Chart controls"><button type="button" data-chart-action="fullscreen" title="Full screen" aria-label="Full screen"><svg viewBox="0 0 24 24"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/></svg></button><button type="button" data-chart-action="settings" title="Settings (Alt+S)" aria-label="Settings"><svg viewBox="0 0 24 24"><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM4 13.5v-3l2-.6.7-1.7-1-1.8L7.8 4.3l1.8 1 1.7-.7.6-2h3l.6 2 1.7.7 1.8-1 2.1 2.1-1 1.8.7 1.7 2 .6v3l-2 .6-.7 1.7 1 1.8-2.1 2.1-1.8-1-1.7.7-.6 2h-3l-.6-2-1.7-.7-1.8 1-2.1-2.1 1-1.8-.7-1.7z"/></svg></button></div><div class="chart-nav" aria-label="Chart navigation"><button data-nav="out" title="Zoom out" aria-label="Zoom out">−</button><button data-nav="in" title="Zoom in" aria-label="Zoom in">+</button><span class="nav-divider"></span><button data-nav="left" title="Scroll left" aria-label="Scroll left">‹</button><button data-nav="right" title="Scroll right" aria-label="Scroll right">›</button><button data-nav="latest" title="Scroll to the latest bar" aria-label="Scroll to the latest bar">»</button><button data-nav="reset" title="Reset chart view (Alt+R)" aria-label="Reset chart view"><svg viewBox="0 0 24 24"><path d="M4 11a8 8 0 1 1 2.3 5.7M4 5v6h6"/></svg></button></div><div class="chart-paper-buttons hidden"><button data-paper-side="buy">Buy</button><button data-paper-side="sell">Sell</button></div>';
    this.chartEl = el.querySelector(".chart");
    this.legendEl = el.querySelector(".legend");
    this.msgEl = el.querySelector(".pane-msg");
    this.controlsEl = el.querySelector(".chart-controls");
    this.controlsEl.classList.toggle("hidden", this.chartSettings().paneButtons === "never");
    this.controlsEl.dataset.visibility = this.chartSettings().paneButtons || "hover";
    this.navEl = el.querySelector(".chart-nav");
    this.navEl.addEventListener("click", (e) => {
      const button = e.target.closest("[data-nav]");
      if (!button || button.disabled) return;
      this.navAction(button.dataset.nav);
    });
    this.navRepeat = null;
    this.navEl.addEventListener("pointerdown", (e) => {
      const action = e.target.closest("[data-nav]")?.dataset.nav;
      if (!["in", "out", "left", "right"].includes(action)) return;
      e.preventDefault();
      clearInterval(this.navRepeat);
      this.navRepeat = setInterval(() => this.navAction(action), 90);
    });
    for (const event of ["pointerup", "pointerleave", "pointercancel"]) this.navEl.addEventListener(event, () => { clearInterval(this.navRepeat); this.navRepeat = null; });
    this.controlsEl.addEventListener("click", (e) => {
      const button = e.target.closest("[data-chart-action]");
      if (!button) return;
      e.preventDefault();
      e.stopPropagation();
      const action = button.dataset.chartAction;
      if (action === "in") this.zoomTime(0.8);
      else if (action === "out") this.zoomTime(1.25);
      else if (action === "fit") this.fitChart();
      else if (action === "fullscreen") this.toggleFullscreen();
      else if (action === "settings") this.app.openChartSettings(this);
    });
    this.tradeButtonsEl = el.querySelector(".chart-paper-buttons");
    this.tradeButtonsEl.classList.toggle("hidden", !this.chartSettings().tradeButtons);
    this.tradeButtonsEl.addEventListener("click", (e) => {
      const side = e.target.closest("[data-paper-side]")?.dataset.paperSide;
      if (side) this.openPaperOrder(side);
    });
    this.contextMenu = document.createElement("div");
    this.contextMenu.className = "chart-context-menu hidden";
    document.body.append(this.contextMenu);
    this.chartEl.addEventListener("contextmenu", (e) => this.showContextMenu(e));
    this.contextMenu.addEventListener("click", (e) => this.onContextMenuClick(e));
    this.dismissContextMenu = (e) => {
      if (!this.contextMenu.contains(e.target)) this.contextMenu.classList.add("hidden");
    };
    document.addEventListener("pointerdown", this.dismissContextMenu);
    this.createChart();
    // The watchlist grip and side-panel collapse change pane width without a
    // window resize. Keep the canvas in step with its container as it flexes.
    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeFrame) return;
      this.resizeFrame = requestAnimationFrame(() => {
        this.resizeFrame = 0;
        this.resizeChart();
      });
    });
    this.resizeObserver.observe(el);
    this.bindNavigation();
    el.addEventListener("mousedown", () => app.setActive(this), true);
  }

  // ---------- setup ----------
  chartSettings() {
    const saved = this.cfg.chartSettings || {};
    const defaultColors = { lastLineColor: ["#0ec7a3", "#39ff14"], highLowColor: ["#e5a84b"], averagePriceColor: ["#8b7cf6"] };
    for (const [key, legacy] of Object.entries(defaultColors)) {
      if (legacy.includes(String(saved[key] || "").toLowerCase())) saved[key] = "#087f68";
    }
    return { ...(this.app.state.chartSettingsDefault || {}), ...saved };
  }

  themeOptions() {
    const s = this.chartSettings();
    const custom = s.themePreset === "custom";
    const light = s.themePreset === "light" || (!custom && s.themePreset !== "dark" && document.documentElement.dataset.theme === "light");
    const background = custom ? s.backgroundColor || css("--bg") : light ? "#ffffff" : css("--bg");
    const grid = custom ? s.gridColor || css("--grid") : css("--grid");
    return {
      layout: {
        background: s.backgroundMode === "gradient" ? { type: LW.ColorType.VerticalGradient, topColor: background, bottomColor: s.backgroundBottom || css("--panel") } : { type: LW.ColorType.Solid, color: background },
        textColor: custom ? s.scaleFontColor || css("--text") : light ? "#131722" : css("--text"),
        fontSize: Number(s.scaleFontSize) || 11,
        panes: {
          separatorColor: custom ? s.paneSeparatorColor || css("--border") : css("--border"),
          separatorHoverColor: css("--accent-soft"),
          enableResize: true,
        },
      },
      grid: {
        vertLines: { color: s.gridVColor || grid, style: ({ dashed: LW.LineStyle.Dashed, dotted: LW.LineStyle.Dotted })[s.gridVStyle] ?? LW.LineStyle.Solid, visible: s.canvasGrid !== false && s.verticalGrid !== false && s.gridVStyle !== "none" },
        horzLines: { color: s.gridHColor || grid, style: ({ dashed: LW.LineStyle.Dashed, dotted: LW.LineStyle.Dotted })[s.gridHStyle] ?? LW.LineStyle.Solid, visible: s.canvasGrid !== false && s.horizontalGrid !== false && s.gridHStyle !== "none" },
      },
      crosshair: {
        mode: s.crosshairMode === "magnet" ? LW.CrosshairMode.Magnet : LW.CrosshairMode.Normal,
        vertLine: { color: s.crosshairColor || css("--muted"), style: s.crosshairLineStyle === "dotted" ? LW.LineStyle.Dotted : s.crosshairLineStyle === "dashed" ? LW.LineStyle.Dashed : LW.LineStyle.Solid, width: Number(s.crosshairLineWidth) || 1, labelVisible: s.axisTimeLabel !== false },
        horzLine: { color: s.crosshairColor || css("--muted"), style: s.crosshairLineStyle === "dotted" ? LW.LineStyle.Dotted : s.crosshairLineStyle === "dashed" ? LW.LineStyle.Dashed : LW.LineStyle.Solid, width: Number(s.crosshairLineWidth) || 1, labelVisible: s.axisPriceLabel !== false },
      },
      rightPriceScale: { borderColor: custom ? s.scaleLineColor || css("--border") : css("--border"), visible: s.scalePlacement !== "left", alignLabels: s.scaleNoOverlap !== false },
      leftPriceScale: { borderColor: custom ? s.scaleLineColor || css("--border") : css("--border"), visible: s.scalePlacement === "left", alignLabels: s.scaleNoOverlap !== false },
      timeScale: { borderColor: custom ? s.scaleLineColor || css("--border") : css("--border"), rightOffset: Number(s.rightOffset ?? 8) },
    };
  }

  createChart() {
    const settings = this.chartSettings();
    this.chart = LW.createChart(this.chartEl, {
      // Size the canvas from the pane itself. This avoids the chart engine keeping a
      // zero-sized canvas after the settings dialog or layout changes its container.
      autoSize: false,
      ...this.themeOptions(),
      timeScale: {
        borderColor: settings.scaleLineColor || css("--border"),
        rightOffset: Number(settings.rightOffset ?? 8),
        timeVisible: true,
        secondsVisible: false,
      },
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true },
      localization: { priceFormatter: (p) => this.formatPrice(p) },
    });
    this.chart.subscribeCrosshairMove((p) => this.onCrosshair(p));
    this.chart.subscribeClick((p) => {
      if (this.app.tool === "cursor") this.onClick(p);
    });
    // Lightweight Charts drops a second click that lands within 500ms of the first (it waits for a
    // double-click), so drawing tools read native clicks instead.
    this.chartEl.addEventListener("click", (e) => {
      if (this._ignoreNextMeasureClick) {
        this._ignoreNextMeasureClick = false;
        return;
      }
      if (this.app.tool === "cursor") return;
      const r = this.chartEl.getBoundingClientRect();
      const x = e.clientX - r.left,
        y = e.clientY - r.top;
      const inPlot =
        x >= 0 &&
        x <= this.chart.timeScale().width() &&
        y >= 0 &&
        y <= this.chart.panes()[0].getHeight();
      this.onClick({
        point: inPlot ? { x, y } : undefined,
        logical: inPlot ? this.chart.timeScale().coordinateToLogical(x) : null,
        paneIndex: 0,
      });
    });
    this.drawings = new DrawingLayer(this);
    this.bindDrawingPointer();
    this.makeMainSeries();
  }

  zoomTime(factor) {
    const scale = this.chart.timeScale();
    const range = scale.getVisibleLogicalRange();
    if (!range) return scale.fitContent();
    const center = (range.from + range.to) / 2;
    const half = Math.max(5, ((range.to - range.from) * factor) / 2);
    scale.setVisibleLogicalRange({ from: center - half, to: center + half });
  }

  navAction(action) {
    const scale = this.chart.timeScale();
    const range = scale.getVisibleLogicalRange();
    const n = this.shown.length;
    if (!n) return;
    const margin = Number(this.chartSettings().rightOffset ?? 8);
    const next = navigationRange(action, range, n, margin);
    if (action === "reset") { this.chart.priceScale("right").setAutoScale(true); this.chart.priceScale("left").setAutoScale(true); for (const pane of this.chart.panes()) pane.setStretchFactor?.(1); this.fitChart(); }
    else if (next && range && (action === "right" && next.to === range.to)) return;
    else if (next) scale.setVisibleLogicalRange(next);
    this.updateNavigationButtons();
    this.refreshAlertLines();
    this.cfg.navRange = scale.getVisibleLogicalRange() || null;
    this.cfg.navRangeContext = `${this.cfg.symbol}|${this.cfg.tf}`;
  }

  goToDate(value) {
    const target = Date.parse(value);
    if (!Number.isFinite(target) || !this.shown.length) return this.app.toast("Choose a valid date.", "err");
    const seconds = target / 1000;
    let index = this.shown.findIndex((bar) => bar.time >= seconds);
    if (index < 0) index = this.shown.length - 1;
    const current = this.chart.timeScale().getVisibleLogicalRange();
    const width = current ? current.to - current.from : Math.min(160, this.shown.length);
    this.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, index - width / 2), to: index + width / 2 });
    this.updateNavigationButtons();
  }

  openGoToDate() {
    const today = new Date().toISOString().slice(0, 10);
    const card = this.app.modal("Go to date", '<label class="field">Date<input id="gotoDate" type="date"></label>', { foot: '<button class="btn" data-cancel>Cancel</button><button class="btn primary" data-go>Go to date</button>' });
    card.querySelector("#gotoDate").value = today;
    card.querySelector("[data-cancel]").onclick = () => this.app.closeModal();
    card.querySelector("[data-go]").onclick = () => { this.goToDate(card.querySelector("#gotoDate").value); this.app.closeModal(); };
  }

  updateNavigationButtons() {
    if (!this.navEl || !this.chart) return;
    const range = this.chart.timeScale().getVisibleLogicalRange();
    const n = this.shown.length;
    const set = (name, disabled) => { const button = this.navEl.querySelector(`[data-nav="${name}"]`); if (button) button.disabled = disabled; };
    set("left", !range || range.from <= 0);
    set("right", !range || range.to >= n + Number(this.chartSettings().rightOffset ?? 8) - 1);
    set("in", !range || range.to - range.from <= 12);
    set("out", !range || range.to - range.from >= Math.max(n, 100));
    this.navEl.classList.toggle("hidden", this.chartSettings().navigationButtons === "never");
    this.navEl.dataset.visibility = this.chartSettings().navigationButtons || "hover";
  }

  bindNavigation() {
    this.chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (!range) return;
      this.cfg.navRange = range;
      this.cfg.navRangeContext = `${this.cfg.symbol}|${this.cfg.tf}`;
      this.updateNavigationButtons();
      this.updateVisibleRangeLines();
      clearTimeout(this._navPersistTimer);
      if (!this._settingsPreview) this._navPersistTimer = setTimeout(() => this.app.persist(), 250);
    });
    this.resizeChart();
    this.chartEl.addEventListener("wheel", (e) => {
      const rect = this.chartEl.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      if (x > this.chart.timeScale().width() || y > this.chart.panes()[0].getHeight()) return;
      e.preventDefault();
      const scale = this.chart.timeScale(), range = this._wheelRange || scale.getVisibleLogicalRange();
      if (!range) return;
      const width = range.to - range.from;
      if (e.ctrlKey || e.shiftKey) {
        const delta = Math.sign(e.deltaY || e.deltaX) * width * 0.12;
        this._wheelRange = { from: Math.max(0, range.from + delta), to: Math.max(width, range.to + delta) };
      } else {
        const anchor = scale.coordinateToLogical(x) ?? (range.from + range.to) / 2;
        const factor = e.deltaY > 0 ? 1.12 : 0.89;
        const nextWidth = Math.max(12, Math.min(this.shown.length + 20, width * factor));
        const at = (anchor - range.from) / width;
        this._wheelRange = { from: Math.max(0, anchor - nextWidth * at), to: anchor + nextWidth * (1 - at) };
      }
      if (!this._wheelFrame) this._wheelFrame = requestAnimationFrame(() => { this._wheelFrame = 0; const next = this._wheelRange; this._wheelRange = null; if (next) scale.setVisibleLogicalRange(next); });
    }, { passive: false });
    this.chartEl.addEventListener("dblclick", (e) => {
      const r = this.chartEl.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      if (x >= this.chart.timeScale().width() || x <= 40) { this.chart.priceScale("right").setAutoScale(true); this.chart.priceScale("left").setAutoScale(true); }
      else if (y >= this.chart.panes()[0].getHeight()) this.chart.timeScale().fitContent();
      else return;
      this.updateNavigationButtons();
    });
    this.updateNavigationButtons();
  }

  fitChart() {
    this.chart.timeScale().fitContent();
    this.chart.priceScale("right").setAutoScale(true);
    this.chart.priceScale("left").setAutoScale(true);
    this.cfg.navRange = null;
    this.updateNavigationButtons();
  }

  resizeChart() {
    if (!this.chart || !this.chartEl) return;
    const rect = this.chartEl.getBoundingClientRect();
    const width = Math.floor(rect.width), height = Math.floor(rect.height);
    if (width < 1 || height < 1) return;
    this.chart.resize(width, height);
  }

  async toggleFullscreen() {
    try {
      if (document.fullscreenElement === this.el) await document.exitFullscreen();
      else await this.el.requestFullscreen();
    } catch (error) {
      this.app.toast(`Fullscreen is unavailable: ${error.message}`, "err");
    }
  }

  showContextMenu(e) {
    e.preventDefault();
    const rect = this.chartEl.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const logical = this.chart.timeScale().coordinateToLogical(x);
    const price = y >= 0 && y <= this.chart.panes()[0].getHeight() ? this.main.coordinateToPrice(y) : null;
    const time = Number.isFinite(logical) ? this.timeOfLogical(logical) : null;
    this.contextPoint = { price, time, logical };
    this.contextMenu.innerHTML = `<button data-action="alert" ${price == null ? "disabled" : ""}>Add alert</button><button data-action="order" ${price == null ? "disabled" : ""}>Add order</button><button data-action="lock">Lock vertical cursor line by time</button><button data-action="drawings">${this.cfg.drawingsHidden ? "Show all drawings" : "Hide all drawings"}</button><button data-action="reset">Reset chart view</button><button data-action="copy" ${price == null ? "disabled" : ""}>Copy price</button><hr><button data-action="settings">Settings</button>`;
    this.contextMenu.style.left = `${Math.min(e.clientX, innerWidth - 230)}px`;
    this.contextMenu.style.top = `${Math.min(e.clientY, innerHeight - 300)}px`;
    this.contextMenu.classList.remove("hidden");
  }

  onContextMenuClick(e) {
    const action = e.target.closest("[data-action]")?.dataset.action;
    if (!action) return;
    this.contextMenu.classList.add("hidden");
    const price = this.contextPoint?.price;
    if (action === "settings") this.app.openChartSettings(this);
    else if (action === "alert" && Number.isFinite(price)) {
      this.app.setActive(this);
      this.app.panels.openAlertDialog({ rules: [{ left: { kind: "price", field: "close" }, op: "crosses", right: { kind: "value", v: Number(price.toPrecision(8)) } }] });
    } else if (action === "order") {
      this.openPaperOrder("order", price);
    } else if (action === "reset") this.navAction("reset");
    else if (action === "lock") {
      this.cfg.lockedCursor = !this.cfg.lockedCursor;
      if (this.cfg.lockedCursor && this.contextPoint?.price != null && this.contextPoint?.time != null)
        this.chart.setCrosshairPosition(this.contextPoint.price, this.toChart(this.contextPoint.time), this.main);
      this.app.persist();
      this.app.toast(this.cfg.lockedCursor ? "Vertical cursor line locked by time." : "Vertical cursor line unlocked.");
    } else if (action === "drawings") {
      this.cfg.drawingsHidden = !this.cfg.drawingsHidden;
      this.drawings.update();
      this.app.persist();
    } else if (action === "copy" && Number.isFinite(price)) {
      navigator.clipboard?.writeText(String(price)).then(() => this.app.toast(`Copied ${price}.`)).catch(() => this.app.toast("Clipboard access was blocked.", "err"));
    }
  }

  openPaperOrder(side, price = this.contextPoint?.price) {
    this.app.setActive(this);
    this.app.panels.showBottom("paper", false);
    const type = document.querySelector("#ppType"), value = document.querySelector("#ppPrice");
    if (type && price != null) type.value = "limit";
    if (value && price != null) value.value = Number(price.toPrecision(8));
    this.app.toast(side === "order" ? `Paper order form opened${price == null ? "" : ` at ${this.formatPrice(price)}`}. Choose Buy or Sell in the form.` : `Paper ${side} order form opened${price == null ? "" : ` at ${this.formatPrice(price)}`}. Review it and press ${side === "buy" ? "Buy" : "Sell / short"} to place.`);
  }

  bindDrawingPointer() {
    this.chartEl.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const rect = this.chartEl.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (this.app.tool === "measure") {
        const point = this.pointAt({ point: { x, y }, logical: this.chart.timeScale().coordinateToLogical(x), paneIndex: 0 });
        if (!point) return;
        this.measurePointer = { pointerId: e.pointerId, start: point, x, y, dragging: false };
        return;
      }
      if (this.app.tool !== "cursor") return;
      const drawing = this.drawings.hitTest(x, y);
      if (!drawing) return;
      this.app.setActive(this);
      this.drawings.selected = drawing;
      this.drawings.update();
      if (drawing.locked) return;
      const logical = this.chart.timeScale().coordinateToLogical(x);
      const time = this.timeOfLogical(logical);
      const price = this.main.coordinateToPrice(y);
      if (time == null || price == null) return;
      this.drawingDrag = {
        pointerId: e.pointerId,
        drawing,
        points: structuredClone(drawing.points),
        time,
        price,
      };
      this.chart.applyOptions({ handleScroll: false, handleScale: false });
      this.chartEl.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    }, true);
    this.chartEl.addEventListener("pointermove", (e) => {
      const measure = this.measurePointer;
      if (measure?.pointerId === e.pointerId) {
        const rect = this.chartEl.getBoundingClientRect();
        const x = e.clientX - rect.left, y = e.clientY - rect.top;
        if (!measure.dragging && Math.hypot(x - measure.x, y - measure.y) < 3) return;
        if (!measure.dragging) {
          measure.dragging = true;
          this.drawings.temp = { id: newUid(), type: "measure", points: [measure.start, measure.start], color: this.app.drawingColor || this.app.settings.drawingColor };
          this.chart.applyOptions({ handleScroll: false, handleScale: false });
          this.chartEl.setPointerCapture(e.pointerId);
        }
        const point = this.pointAt({ point: { x, y }, logical: this.chart.timeScale().coordinateToLogical(x), paneIndex: 0 });
        if (point && this.drawings.temp) {
          this.drawings.temp.points[1] = point;
          this.drawings.update();
        }
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const drag = this.drawingDrag;
      if (!drag || drag.pointerId !== e.pointerId) return;
      const rect = this.chartEl.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const logical = this.chart.timeScale().coordinateToLogical(x);
      const time = this.timeOfLogical(logical);
      const price = this.main.coordinateToPrice(y);
      if (time == null || price == null) return;
      const dt = time - drag.time;
      const dp = price - drag.price;
      drag.drawing.points = drag.points.map((p) => ({ time: p.time + dt, price: p.price + dp }));
      this.drawings.update();
      e.preventDefault();
      e.stopPropagation();
    }, true);
    const finish = (e) => {
      const measure = this.measurePointer;
      if (measure?.pointerId === e.pointerId) {
        this.measurePointer = null;
        if (!measure.dragging) return;
        if (measure.dragging && e.type === "pointerup" && this.drawings.temp) {
          const drawing = this.drawings.temp;
          this.drawings.temp = null;
          this.drawings.items.push(drawing);
          this.drawings.selected = drawing;
          this.drawings.update();
          this.commitDrawings();
          this._ignoreNextMeasureClick = true;
          setTimeout(() => { this._ignoreNextMeasureClick = false; }, 0);
        } else if (e.type === "pointercancel" && measure.dragging) {
          this.drawings.temp = null;
          this.drawings.update();
        }
        if (measure.dragging) this.chart.applyOptions({ handleScroll: false, handleScale: false });
        try { this.chartEl.releasePointerCapture(e.pointerId); } catch { /* already released */ }
        if (measure.dragging) { e.preventDefault(); e.stopPropagation(); }
        return;
      }
      const drag = this.drawingDrag;
      if (!drag || drag.pointerId !== e.pointerId) return;
      this.drawingDrag = null;
      this.setInteractive(this.app.tool === "cursor");
      if (JSON.stringify(drag.points) !== JSON.stringify(drag.drawing.points))
        this.commitDrawings();
      try { this.chartEl.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      e.preventDefault();
      e.stopPropagation();
    };
    this.chartEl.addEventListener("pointerup", finish, true);
    this.chartEl.addEventListener("pointercancel", finish, true);
  }

  applyTheme() {
    this.applyChartSettings();
  }

  applyChartSettings() {
    const s = this.chartSettings();
    this.tradeButtonsEl?.classList.toggle("hidden", !s.tradeButtons);
    this.controlsEl?.classList.toggle("hidden", s.paneButtons === "never");
    if (this.controlsEl) this.controlsEl.dataset.visibility = s.paneButtons || "hover";
    this.cfg.type = s.chartType || this.cfg.type;
    this.cfg.scale = s.scaleMode === "percent" ? "percentage" : s.scaleMode === "indexed" ? "indexed" : s.scaleMode || "normal";
    this.cfg.log = this.cfg.scale === "log";
    this.chart.applyOptions(this.themeOptions());
    this.updateWatermark();
    this.chart.timeScale().applyOptions({ rightOffset: Number(s.rightOffset ?? 8) });
    const theme = s.themePreset === "light" ? "light" : s.themePreset === "dark" ? "dark" : document.documentElement.dataset.theme;
    const defaultCandleColor = (value, direction) => {
      const color = String(value || "").toLowerCase();
      const isDefault = direction === "up" ? ["#39ff14", "#0ec7a3", "#0b9981"].includes(color) : ["#f23645", "#cc3958"].includes(color);
      return isDefault ? (direction === "up" ? (theme === "light" ? "#0b9981" : "#0ec7a3") : (theme === "light" ? "#f23645" : "#cc3958")) : value;
    };
    const styleKey = JSON.stringify([theme, this.cfg.type, defaultCandleColor(s.upColor, "up"), defaultCandleColor(s.downColor, "down"), defaultCandleColor(s.upBorder || s.upColor, "up"), defaultCandleColor(s.downBorder || s.downColor, "down"), defaultCandleColor(s.upWick || s.upColor, "up"), defaultCandleColor(s.downWick || s.downColor, "down"), s.upBody, s.downBody, s.upColorVisible, s.downColorVisible, s.upBorderVisible, s.downBorderVisible, s.upWickVisible, s.downWickVisible, s.borderVisible, s.scalePlacement, s.lineWidth, s.areaFill, s.colorBarsPreviousClose]);
    const seriesChanged = this.main && styleKey !== this._chartStyleKey;
    const coordinatesChanged = this._appliedTimezone !== s.timezone || this._appliedPrecision !== s.precision;
    if (seriesChanged) this.makeMainSeries();
    if (this.main) this.main.applyOptions({
      priceLineVisible: s.lastPriceLine !== "hidden" && s.priceLine !== false,
      priceLineStyle: s.lastPriceLine === "dotted" ? LW.LineStyle.Dotted : s.lastPriceLine === "dashed" ? LW.LineStyle.Dashed : LW.LineStyle.Solid,
      priceLineColor: ["#39ff14", "#0ec7a3"].includes(String(s.lastLineColor || "").toLowerCase()) ? css("--accent") : s.lastLineColor || "",
      priceLineWidth: Number(s.lastPriceLineWidth) || 1,
      lastValueVisible: s.labelLastPrice !== false,
      scaleMargins: { top: Math.min(0.4, Math.max(0, Number(s.marginTop ?? 8) / 100)), bottom: Math.min(0.4, Math.max(0, Number(s.marginBottom ?? 8) / 100)) },
    });
    // Keep both axes in sync when settings or series placement changes. A stale manual
    // range on the inactive side can otherwise come back when the series is rebuilt.
    const scaleId = s.scalePlacement === "left" ? "left" : "right";
    this.chart.priceScale(scaleId).setAutoScale(s.scaleAuto !== false && !s.scaleLockRatio);
    this.refreshAlertLines();
    this.updateNavigationButtons();
    this._appliedTimezone = s.timezone;
    this._appliedPrecision = s.precision;
    if (seriesChanged || coordinatesChanged) this.render(false);
    else { this.updatePreviousCloseLine(); this.updateVisibleRangeLines(); this.updateLegend(); }
    this.refreshEventMarkers();
  }

  makeMainSeries() {
    this._alertLineKey = "";
    this.prevCloseLine = null;
    for (const vp of this.vpPrims || []) { try { this.main?.detachPrimitive(vp); } catch { /* gone */ } }
    this.vpPrims = [];
    if (this.main) {
      this.main.detachPrimitive(this.drawings);
      this.chart.removeSeries(this.main);
    }
    if (this.volume) {
      this.chart.removeSeries(this.volume);
      this.volume = null;
    }
    const s = this.chartSettings();
    const theme = s.themePreset === "light" ? "light" : s.themePreset === "dark" ? "dark" : document.documentElement.dataset.theme;
    const resolveCandleColor = (value, direction) => {
      const color = String(value || "").toLowerCase();
      const isDefault = direction === "up"
        ? ["#39ff14", "#0ec7a3", "#0b9981"].includes(color)
        : ["#f23645", "#cc3958"].includes(color);
      if (!isDefault) return value;
      return direction === "up" ? (theme === "light" ? "#0b9981" : "#0ec7a3") : (theme === "light" ? "#f23645" : "#cc3958");
    };
    const up = resolveCandleColor(s.upColor || css("--up"), "up"),
      down = resolveCandleColor(s.downColor || css("--down"), "down"),
      upBorder = resolveCandleColor(s.upBorder || s.upColor || css("--up"), "up"),
      downBorder = resolveCandleColor(s.downBorder || s.downColor || css("--down"), "down"),
      upWick = resolveCandleColor(s.upWick || s.upColor || css("--up"), "up"),
      downWick = resolveCandleColor(s.downWick || s.downColor || css("--down"), "down"),
      accent = s.lineColor || css("--accent");
    const t = this.cfg.type;
    this._chartStyleKey = JSON.stringify([theme, t, up, down, upBorder, downBorder, upWick, downWick, s.upBody, s.downBody, s.upColorVisible, s.downColorVisible, s.upBorderVisible, s.downBorderVisible, s.upWickVisible, s.downWickVisible, s.borderVisible, s.scalePlacement, s.lineWidth, s.areaFill, s.colorBarsPreviousClose]);
    const common = {
      priceLineVisible: s.lastPriceLine !== "hidden" && s.priceLine !== false,
      priceLineStyle: s.lastPriceLine === "dotted" ? LW.LineStyle.Dotted : s.lastPriceLine === "dashed" ? LW.LineStyle.Dashed : LW.LineStyle.Solid,
      priceLineWidth: Number(s.lastPriceLineWidth) || 1,
      lastValueVisible: s.lastValue !== false,
      priceScaleId: s.scalePlacement === "left" ? "left" : "right",
    };
    if (t === "bars")
      this.main = this.chart.addSeries(LW.BarSeries, {
        ...common,
        upColor: s.upBody === false || s.upColorVisible === false ? "rgba(0,0,0,0)" : up,
        downColor: s.downBody === false || s.downColorVisible === false ? "rgba(0,0,0,0)" : down,
      });
    else if (["line", "linemarkers", "step", "kagi"].includes(t))
      this.main = this.chart.addSeries(LW.LineSeries, {
        ...common,
        color: accent,
        lineWidth: Number(s.lineWidth) || 2,
        lineType: t === "step" || t === "kagi" ? 1 : 0,
        pointMarkersVisible: t === "linemarkers",
      });
    else if (t === "area")
      this.main = this.chart.addSeries(LW.AreaSeries, {
        ...common,
        lineColor: accent,
        topColor: s.areaFill || "rgba(14,199,163,0.28)",
        bottomColor: "rgba(14,199,163,0.02)",
        lineWidth: Number(s.lineWidth) || 2,
      });
    else if (t === "baseline")
      this.main = this.chart.addSeries(LW.BaselineSeries, {
        ...common,
        topLineColor: up,
        bottomLineColor: down,
        topFillColor1: "rgba(8,153,129,0.25)",
        topFillColor2: "rgba(8,153,129,0.02)",
        bottomFillColor1: "rgba(242,54,69,0.02)",
        bottomFillColor2: "rgba(242,54,69,0.25)",
      });
    else if (t === "columns")
      this.main = this.chart.addSeries(LW.HistogramSeries, { ...common });
    else if (t === "hollow")
      this.main = this.chart.addSeries(LW.CandlestickSeries, {
        ...common,
        upColor: "rgba(0,0,0,0)",
        downColor: s.downBody === false ? "rgba(0,0,0,0)" : down,
        borderUpColor: s.upBorderVisible === false ? "rgba(0,0,0,0)" : upBorder,
        borderDownColor: s.downBorderVisible === false ? "rgba(0,0,0,0)" : downBorder,
        wickUpColor: s.upWickVisible === false ? "rgba(0,0,0,0)" : upWick,
        wickDownColor: s.downWickVisible === false ? "rgba(0,0,0,0)" : downWick,
        borderVisible: true,
      });
    else
      this.main = this.chart.addSeries(LW.CandlestickSeries, {
        ...common,
        upColor: s.upBody === false || s.upColorVisible === false ? "rgba(0,0,0,0)" : up,
        downColor: s.downBody === false || s.downColorVisible === false ? "rgba(0,0,0,0)" : down,
        borderVisible: s.borderVisible !== false,
        borderUpColor: s.upBorderVisible === false ? "rgba(0,0,0,0)" : upBorder,
        borderDownColor: s.downBorderVisible === false ? "rgba(0,0,0,0)" : downBorder,
        wickUpColor: s.upWickVisible === false ? "rgba(0,0,0,0)" : upWick,
        wickDownColor: s.downWickVisible === false ? "rgba(0,0,0,0)" : downWick,
      });
    this.main.attachPrimitive(this.drawings);
    this.markers = LW.createSeriesMarkers(this.main, []);
    this.mainType = t;
    if (
      !PRICE_ONLY.includes(t) &&
      this.app.settings.volume !== false
    ) {
      this.volume = this.chart.addSeries(LW.HistogramSeries, {
        priceScaleId: "vol",
        priceFormat: { type: "volume" },
        lastValueVisible: false,
        priceLineVisible: false,
      });
      this.chart
        .priceScale("vol")
        .applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    }
  }

  // ---------- time helpers (drawings, legend, markers all go through these) ----------
  get shift() {
    const zone = this.resolvedTimezone();
    return zone === "local" ? -new Date().getTimezoneOffset() * 60 : zone === "UTC" ? 0 : this.shiftAt(Math.floor(Date.now() / 1000));
  }
  shiftAt(utc) {
    const zone = this.resolvedTimezone();
    if (zone === "UTC") return 0;
    if (zone === "local") return -new Date(utc * 1000).getTimezoneOffset() * 60;
    try {
      const p = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(utc * 1000));
      const v = Object.fromEntries(p.map((x) => [x.type, Number(x.value)]));
      return Math.round(Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute, v.second) / 1000 - utc);
    } catch { return 0; }
  }
  resolvedTimezone() {
    const zone = this.chartSettings().timezone || "Asia/Kolkata";
    if (zone !== "exchange") return zone;
    const venue = displayExchange(this.cfg.symbol);
    if (["NSE", "BSE"].includes(venue)) return "Asia/Kolkata";
    if (["NASDAQ", "NYSE", "AMEX"].includes(venue)) return "America/New_York";
    return "UTC";
  }
  get step() {
    return this.times.length > 1
      ? this.times.at(-1) - this.times.at(-2)
      : parseTf(this.cfg.tf).seconds;
  }
  toChart(t) {
    return t + this.shiftAt(t);
  }

  logicalOf(utc) {
    const T = this.times,
      t = utc + this.shiftAt(utc),
      n = T.length;
    if (!n) return null;
    if (t <= T[0]) return (t - T[0]) / this.step;
    if (t >= T[n - 1]) return n - 1 + (t - T[n - 1]) / this.step;
    let lo = 0,
      hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (T[m] <= t) lo = m;
      else hi = m;
    }
    return lo + (t - T[lo]) / (T[hi] - T[lo]);
  }

  timeOfLogical(l) {
    const T = this.times,
      n = T.length;
    if (!n) return null;
    let t;
    if (l <= 0) t = T[0] + l * this.step;
    else if (l >= n - 1) t = T[n - 1] + (l - (n - 1)) * this.step;
    else {
      const i = Math.floor(l);
      t = T[i] + (l - i) * (T[i + 1] - T[i]);
    }
    let utc = t - this.shift;
    utc = t - this.shiftAt(utc);
    return utc;
  }

  timeToX(utc) {
    const l = this.logicalOf(utc);
    return l == null ? null : this.chart.timeScale().logicalToCoordinate(l);
  }

  formatPrice(v) {
    const p = this.chartSettings().precision;
    if (p == null || p === "default") return formatSymbolPrice(this.cfg.symbol, v);
    const digits = Math.max(0, Math.min(8, Number(p) || 0));
    const text = Number(v).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
    return /\.NS$|\.BO$|\^NSEI|\^BSESN/.test(ticker(this.cfg.symbol)) ? `₹${text}` : text;
  }

  // ---------- data ----------
  async load({ keepView = false } = {}) {
    const token = (this.loadToken = {});
    this.stopLive();
    this.showMsg(`Loading ${ticker(this.cfg.symbol)}…`);
    try {
      const requested = parseTf(this.cfg.tf);
      if (requested.unit === "s" && exchange(this.cfg.symbol) !== "BINANCE") {
        this.bars = [];
        this.render(true);
        const indianVenue = ["NSE", "BSE"].includes(displayExchange(this.cfg.symbol));
        const limitNote = indianVenue ? "NSE/BSE history starts at 1 minute." : "This market's available history starts at 1 minute.";
        this.showMsg(`${this.cfg.tf} historical bars are not available for ${ticker(this.cfg.symbol)} from the current data feed. ${limitNote} Choose 1m or longer, or connect a data source that provides second bars.`);
        return;
      }
      const limit = this.app.settings.bars || 3000;
      const r = await api.candles(this.cfg.symbol, this.cfg.tf, limit);
      if (token !== this.loadToken) return;
      this.cfg.symbol = r.symbol;
      const viewContext = `${this.cfg.symbol}|${this.cfg.tf}`;
      if (this.cfg.navRangeContext !== viewContext) this.cfg.navRange = null;
      this.cfg.navRangeContext = viewContext;
      const descriptionSymbol = this.cfg.symbol;
      if (this._descriptionSymbol !== descriptionSymbol) {
        this._descriptionSymbol = descriptionSymbol;
        api.search(ticker(descriptionSymbol), "all").then((items) => {
          if (this.cfg.symbol !== descriptionSymbol) return;
          const exact = items.find((item) => String(item.symbol || "").split(":").pop() === ticker(descriptionSymbol));
          this.cfg.description = exact?.name || ticker(descriptionSymbol);
          this.updateLegend();
        }).catch(() => {});
      }
      this.provider = r.provider;
      this.notes = r.notes || [];
      this.bars = r.candles;
      if (this.cfg.navRange) this.cfg.navRange = clampVisibleRange(this.cfg.navRange, this.bars.length, Number(this.chartSettings().rightOffset ?? 8));
      this.mtf = {};
      this.replay = null;
      this.el.querySelector(".replay-bar")?.remove();
      this.drawings.setItems(this.app.getDrawings(r.symbol, this.cfg.tf));
      this.showMsg(
        this.bars.length ? "" : "No data for this symbol and timeframe.",
      );
      await this.loadCompare();
      // Data reloads can change the number and range of bars. Never restore a saved
      // logical range against a different response; start from the newest data and
      // let an explicitly requested timeframe left-edge restore run below.
      this.cfg.navRange = null;
      this.render(true);
      // A layout or modal can finish resizing after the candle response arrives.
      // Resize on the next frame, then reapply the current view and autoscale.
      requestAnimationFrame(() => {
        if (token !== this.loadToken || !this.bars.length) return;
        this.resizeChart();
        // Re-submit the data after the final canvas resize so the initial paint
        // cannot be lost if bars arrived while the pane was still settling.
        this.main?.setData(this.shown.map((bar, index) => this.pointFor(bar, index)));
        this.volume?.setData(this.shown.map((bar) => this.volPoint(bar)));
        if (!this.chartSettings().scaleLockRatio) {
          this.chart.priceScale("right").setAutoScale(true);
          this.chart.priceScale("left").setAutoScale(true);
        }
        const count = this.shown.length;
        if (count) this.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, count - 160), to: count + 8 });
        this.updateNavigationButtons();
      });
      this._alertLineKey = "";
      this.refreshAlertLines();
      clearInterval(this.alertLineRefreshTimer);
      this.alertLineRefreshTimer = setInterval(() => { this._alertLineKey = ""; this.refreshAlertLines(); }, 60 * 1000);
      this._eventLoadKey = "";
      this.refreshEventMarkers();
      clearInterval(this.eventRefreshTimer);
      this.eventRefreshTimer = setInterval(() => {
        const settings = this.chartSettings();
        if (settings.eventLatestNews && settings.eventNewsNotification) {
          this._eventLoadKey = "";
          this.refreshEventMarkers();
        }
      }, 5 * 60e3);
      this.startLive();
      this.app.onPaneLoaded(this);
    } catch (e) {
      if (token !== this.loadToken) return;
      this.bars = [];
      this.render(true);
      const rawMessage = String(e.message || e).replace(/yahoo(?: finance)?/ig, "public market data");
      const message = /no source could load this chart/i.test(rawMessage)
        ? "No available data source returned candles for this symbol and interval. Try a longer interval or check the symbol and connection."
        : rawMessage;
      this.showMsg(`Couldn't load ${this.cfg.symbol} on ${this.cfg.tf}.
${message}`);
    }
  }

  async loadCompare() {
    this.compareData = {};
    await Promise.all(
      this.cfg.compare.map(async (sym) => {
        try {
          this.compareData[sym] = (
            await api.candles(sym, this.cfg.tf, this.app.settings.bars || 3000)
          ).candles;
        } catch {
          this.compareData[sym] = [];
        }
      }),
    );
  }

  showMsg(text) {
    this.msgEl.classList.toggle("hidden", !text);
    this.msgEl.innerHTML = esc(text).replace(/\n/g, "<br>");
  }

  visibleBars() {
    const raw = this.replay
      ? this.bars.slice(0, this.replay.index + 1)
      : this.bars;
    switch (this.cfg.type) {
      case "heikin":
        return heikinAshi(raw);
      case "renko":
        return renko(raw, Number(this.chartSettings().renkoBoxSize) || 0);
      case "linebreak":
        return lineBreak(raw);
      case "range":
        return rangeBars(raw);
      case "kagi":
        return kagi(raw);
      case "pnf":
        return pointFigure(raw);
      default:
        return raw;
    }
  }

  pointFor(b, index = this.shown.indexOf(b)) {
    const time = this.toChart(b.time);
    const s = this.chartSettings();
    const prior = index > 0 ? this.shown[index - 1] : null;
    const upBar = s.colorBarsPreviousClose && prior ? b.close >= prior.close : b.close >= b.open;
    const barColor = upBar ? (s.upColor || css("--up")) : (s.downColor || css("--down"));
    switch (this.mainType) {
      case "line":
      case "linemarkers":
      case "step":
      case "area":
      case "baseline":
        return { time, value: b.close };
      case "kagi":
        return { time, value: b.close, color: b.color };
      case "columns":
        return { time, value: b.close, color: barColor };
      default:
        // Some public feeds include empty minute slots with no volume and a flat
        // OHLC value. They are not traded candles, but the chart engine draws
        // them as small horizontal ticks. Preserve their timestamps and volume
        // data while suppressing only that misleading candle glyph.
        if (!(Number(b.volume) > 0) && b.open === b.high && b.high === b.low && b.low === b.close)
          return { time, open: b.open, high: b.high, low: b.low, close: b.close, color: "rgba(0,0,0,0)", borderColor: "rgba(0,0,0,0)", wickColor: "rgba(0,0,0,0)" };
        if (s.colorBarsPreviousClose) return { time, open: b.open, high: b.high, low: b.low, close: b.close, color: s.chartType === "hollow" || (upBar ? s.upBody === false || s.upColorVisible === false : s.downBody === false || s.downColorVisible === false) ? "rgba(0,0,0,0)" : barColor, borderColor: upBar ? (s.upBorderVisible === false ? "rgba(0,0,0,0)" : s.upBorder || barColor) : (s.downBorderVisible === false ? "rgba(0,0,0,0)" : s.downBorder || barColor), wickColor: upBar ? (s.upWickVisible === false ? "rgba(0,0,0,0)" : s.upWick || barColor) : (s.downWickVisible === false ? "rgba(0,0,0,0)" : s.downWick || barColor) };
        return { time, open: b.open, high: b.high, low: b.low, close: b.close };
    }
  }

  volPoint(b) {
    return {
      time: this.toChart(b.time),
      value: b.volume || 0,
      color:
      b.close >= b.open ? "rgba(57,255,20,0.45)" : "rgba(140,255,95,0.4)",
    };
  }

  render(resetView) {
    // Ensure the engine knows the host size before series data or ranges are applied.
    this.resizeChart();
    const prevRange = this.chart.timeScale().getVisibleLogicalRange();
    const atEnd =
      prevRange && this.shown.length && prevRange.to >= this.shown.length - 3;
    if (
      this.mainType !== this.cfg.type ||
      !!this.volume !==
        (!PRICE_ONLY.includes(this.cfg.type) &&
          this.app.settings.volume !== false)
    )
      this.makeMainSeries();
    this.shown = this.visibleBars();
    this.times = this.shown.map((b) => this.toChart(b.time));
    const last = this.shown.at(-1)?.close || 1;
    const precision = last >= 100 ? 2 : last >= 1 ? 4 : last >= 0.01 ? 6 : 8;
    this.main.applyOptions({
      priceFormat: {
        type: "custom",
        minMove: 1 / 10 ** (this.chartSettings().precision === "default" ? precision : Math.max(0, Math.min(8, Number(this.chartSettings().precision) || 0))),
        formatter: (price) => this.formatPrice(price),
      },
    });
    if (this.cfg.type === "baseline" && this.shown.length)
      this.main.applyOptions({
        baseValue: {
          type: "price",
          price: this.shown[Math.max(0, this.shown.length - 150)].close,
        },
      });
    this.main.setData(this.shown.map((b, i) => this.pointFor(b, i)));
    if (resetView && !this.chartSettings().scaleLockRatio) {
      // setData can leave Lightweight Charts with a manually dragged range. Clear it
      // after installing the new bars, before fitting the time window.
      this.chart.priceScale("right").setAutoScale(true);
      this.chart.priceScale("left").setAutoScale(true);
    }
    this.updatePreviousCloseLine();
    this.updateVisibleRangeLines();
    this.refreshAlertLines();
    this.updateWatermark();
    this.volume?.setData(this.shown.map((b) => this.volPoint(b)));
    this.chart.applyOptions({
      timeScale: {
        timeVisible: isIntraday(this.cfg.tf),
        secondsVisible: parseTf(this.cfg.tf).seconds < 60,
      },
    });
    const scale = this.cfg.scale || (this.cfg.compare.length ? "percentage" : this.cfg.log ? "log" : "normal");
    const mode = scale === "percentage" || scale === "percent" ? LW.PriceScaleMode.Percentage : scale === "log" ? LW.PriceScaleMode.Logarithmic : scale === "indexed" ? LW.PriceScaleMode.IndexedTo100 : LW.PriceScaleMode.Normal;
    this.chart.priceScale("right").applyOptions({ mode });
    this.renderCompare();
    this.renderIndicators();
    this.drawings.update();
    if (resetView && this.shown.length)
      this.chart.timeScale().setVisibleLogicalRange({
        from: Math.max(0, this.shown.length - 160),
        to: this.shown.length + 8,
      });
    if (!resetView && this.shown.length && (this.replay || atEnd)) {
      const w = prevRange ? Math.max(20, prevRange.to - prevRange.from) : 160;
      const n = this.shown.length;
      this.chart
        .timeScale()
        .setVisibleLogicalRange({ from: n - w + 8, to: n + 8 });
    }
    if (!resetView && this.cfg.navRange && !this.replay) {
      const margin = Math.max(0, Number(this.chartSettings().rightOffset ?? 8));
      this.cfg.navRange = clampVisibleRange(this.cfg.navRange, this.shown.length, margin);
      const range = this.cfg.navRange;
      if (range) this.chart.timeScale().setVisibleLogicalRange(range);
    }
    this.updateNavigationButtons();
    this.updateLegend();
  }

  updatePreviousCloseLine() {
    if (this.prevCloseLine) {
      try { this.main.removePriceLine(this.prevCloseLine); } catch { /* main series was replaced */ }
      this.prevCloseLine = null;
    }
    const s = this.chartSettings();
    if ((!s.previousDayLines && !s.labelPreviousClose) || !this.shown.length || !this.main) return;
    const last = this.shown.at(-1);
    const today = periodKey(last.time, "day");
    let previous = null;
    for (let i = this.shown.length - 2; i >= 0; i--) {
      if (periodKey(this.shown[i].time, "day") !== today) { previous = this.shown[i]; break; }
    }
    if (!previous) return;
    const showLabel = s.labelPreviousClose === true;
    const closeColor = s.previousCloseColor || "#087f68";
    this.prevCloseLine = this.main.createPriceLine({ price: previous.close, color: closeColor, lineWidth: 2, lineStyle: LW.LineStyle.Dotted, lineVisible: s.previousDayLines === true || s.labelPreviousClose === true, axisLabelVisible: showLabel, title: showLabel ? "Prev close" : "" });
  }

  updateVisibleRangeLines() {
    if (!this.main) return;
    for (const line of this.visibleRangeLines || []) { try { this.main.removePriceLine(line); } catch { /* replaced series */ } }
    this.visibleRangeLines = [];
    const s = this.chartSettings();
    if ((!s.highLowLines && !s.averagePriceLine) || !this.shown.length) return;
    const range = this.chart.timeScale().getVisibleLogicalRange();
    const from = Math.max(0, Math.floor(range?.from ?? Math.max(0, this.shown.length - 160)));
    const to = Math.min(this.shown.length - 1, Math.ceil(range?.to ?? this.shown.length - 1));
    if (to < from) return;
    const bars = this.shown.slice(from, to + 1);
    const hi = Math.max(...bars.map((b) => b.high));
    const lo = Math.min(...bars.map((b) => b.low));
    const avg = bars.reduce((sum, b) => sum + b.close, 0) / bars.length;
    const add = (enabled, price, title, color) => {
      if (!enabled) return;
      this.visibleRangeLines.push(this.main.createPriceLine({ price, color, lineWidth: 2, lineStyle: LW.LineStyle.Dotted, axisLabelVisible: true, title }));
    };
    add(s.highLowLines, hi, "High", s.highLowColor || "#087f68");
    add(s.highLowLines, lo, "Low", s.highLowColor || "#087f68");
    add(s.averagePriceLine, avg, "Average", s.averagePriceColor || "#087f68");
  }

  updateWatermark() {
    const s = this.chartSettings();
    if (!this.watermarkEl) {
      this.watermarkEl = document.createElement("div");
      this.watermarkEl.className = "chart-watermark";
      this.chartEl.append(this.watermarkEl);
    }
    const mode = s.watermarkMode || "off";
    this.watermarkEl.textContent = mode === "symbol" ? ticker(this.cfg.symbol) : mode === "symbol-timeframe" ? `${ticker(this.cfg.symbol)} · ${this.cfg.tf}` : "";
    this.watermarkEl.style.display = mode === "off" ? "none" : "";
    this.watermarkEl.style.color = s.watermarkColor || "#8995a3";
    this.watermarkEl.style.opacity = String(Math.max(0, Math.min(100, Number(s.watermarkOpacity ?? 16))) / 100);
  }

  renderCompare() {
    for (const s of this.compareSeries.values()) this.chart.removeSeries(s);
    this.compareSeries.clear();
    const palette = ["#0ec7a3", "#20a7d8", "#8b7cf6", "#e5bc63", "#cc3958"];
    this.cfg.compare.forEach((sym, k) => {
      const data = (this.compareData?.[sym] || []).filter(
        (b) => !this.replay || b.time <= this.shown.at(-1)?.time,
      );
      const s = this.chart.addSeries(LW.LineSeries, {
        color: palette[k % palette.length],
        lineWidth: 2,
        priceLineVisible: false,
        title: ticker(sym),
      });
      s.setData(
        data.map((b) => ({ time: this.toChart(b.time), value: b.close })),
      );
      this.compareSeries.set(sym, s);
    });
  }

  // Indicator values for one instance: on the chart's bars, on another indicator's output
  // (source "ind:<uid>:<output>"), or on a higher timeframe mapped back without look-ahead.
  computeIndicator(ind, bars) {
    const src = String(ind.params?.source || "");
    if (ind.tf && ind.tf !== this.cfg.tf) {
      const h = this.mtf[ind.tf];
      if (!h) { this.loadMtf(ind.tf); return { pending: true }; }
      if (h.error) return { error: h.error };
      let hb = h.bars;
      if (this.replay && bars.length) {
        // replay: only higher-timeframe bars that had finished by the replayed bar
        const cEnd = bars.at(-1).time + parseTf(this.cfg.tf).seconds, hs = parseTf(ind.tf).seconds;
        hb = hb.filter((x, j) => (j + 1 < hb.length ? hb[j + 1].time : x.time + hs) <= cEnd);
      }
      if (!hb.length) return {};
      const res = compute(ind.id, hb, src.startsWith("ind:") ? { ...ind.params, source: "close" } : ind.params);
      return mapToChart(res, hb, ind.tf, bars, this.cfg.tf);
    }
    if (src.startsWith("ind:")) {
      const [, uid, key] = src.split(":");
      const vals = this.indResults[uid]?.[key];
      if (!Array.isArray(vals)) return { error: "Its source indicator is missing" };
      const synth = bars.map((x, i) => { const v = vals[i]; return { ...x, open: v, high: v, low: v, close: v }; });
      return compute(ind.id, synth, { ...ind.params, source: "close" });
    }
    return compute(ind.id, bars, ind.params);
  }

  async loadMtf(tf) {
    this.mtfLoading ||= {};
    if (this.mtfLoading[tf]) return;
    this.mtfLoading[tf] = true;
    try {
      if (parseTf(tf).seconds < parseTf(this.cfg.tf).seconds) throw new Error(`Pick a timeframe at or above the chart's (${this.cfg.tf})`);
      const r = await api.candles(this.cfg.symbol, tf, 2000);
      this.mtf[tf] = { bars: r.candles, at: Date.now() };
    } catch (e) {
      this.mtf[tf] = { error: e.message, at: Date.now() };
    }
    delete this.mtfLoading[tf];
    this.render(false);
  }

  renderIndicators() {
    for (const list of this.indSeries.values())
      for (const s of list) {
        try { this.chart.removeSeries(s); } catch { /* already gone */ }
      }
    this.indSeries.clear();
    for (const vp of this.vpPrims || []) { try { this.main.detachPrimitive(vp); } catch { /* gone with the series */ } }
    this.vpPrims = [];
    while (this.chart.panes().length > 1) this.chart.removePane(this.chart.panes().length - 1);
    this.indResults = {};
    this.mtf ||= {};
    const bars = this.shown, n = bars.length;
    this.indicatorCache ||= new Map();
    const lastBar = bars.at(-1), firstBar = bars[0];
    const indicatorSetKey = JSON.stringify(this.cfg.indicators.map((x) => [x.uid, x.id, x.params, x.tf, x.hidden]));
    const dataKey = `${this.cfg.symbol}|${this.cfg.tf}|${n}|${firstBar?.time}|${lastBar?.time}|${lastBar?.open}|${lastBar?.high}|${lastBar?.low}|${lastBar?.close}|${lastBar?.volume}|${indicatorSetKey}`;
    const timeAt = (i) => (i < n ? this.times[i] : this.times[n - 1] + (i - n + 1) * this.step);
    // indicators built on another indicator's output go after their source
    const byUid = new Map(this.cfg.indicators.map((x) => [x.uid, x]));
    const depth = (x, seen = new Set()) => {
      const src = String(x.params?.source || "");
      if (!src.startsWith("ind:") || seen.has(x.uid)) return 0;
      seen.add(x.uid);
      const parent = byUid.get(src.split(":")[1]);
      return parent ? 1 + depth(parent, seen) : 0;
    };
    const ordered = [...this.cfg.indicators].sort((x, y) => depth(x) - depth(y));
    let paneIdx = 0;
    const paneOf = {};
    const markers = [];
    for (const ind of ordered) {
      const def = BY_ID[ind.id];
      if (!def) continue;
      const cacheKey = `${dataKey}|${ind.uid}`;
      let res = this.indicatorCache.get(cacheKey);
      if (!res || res.pending) {
        try { res = n ? this.computeIndicator(ind, bars) : {}; } catch (e) { res = { error: e.message }; }
        if (!res.pending) this.indicatorCache.set(cacheKey, res);
        while (this.indicatorCache.size > 40) this.indicatorCache.delete(this.indicatorCache.keys().next().value);
      }
      this.indResults[ind.uid] = res;
      if (ind.hidden || !n) continue;
      if (res.markers && !ind.tf) markers.push(...res.markers);
      if (res.volumeProfile) {
        const vp = new VolumeProfile(this, { ...res.volumeProfile, color: ind.colors?.value || css("--accent") });
        this.main.attachPrimitive(vp);
        this.vpPrims.push(vp);
      }
      if (res.sessionProfile) {
        const sp = new SessionVolumeProfile(this, res.sessionProfile);
        sp.keyOf = periodKey;
        sp.tfSeconds = parseTf(this.cfg.tf).seconds;
        this.main.attachPrimitive(sp);
        this.vpPrims.push(sp);
      }
      const outs = def.outputs.filter((o) => Array.isArray(res[o.key]));
      if (!outs.length) continue;
      const src = String(ind.params?.source || "");
      const parentPane = src.startsWith("ind:") ? paneOf[src.split(":")[1]] : undefined;
      const pane = parentPane !== undefined ? parentPane : def.overlay ? 0 : ++paneIdx;
      paneOf[ind.uid] = pane;
      const list = [];
      for (const out of outs) {
        const color = ind.colors?.[out.key] || out.color;
        const opts = {
          ...(def.noAutoscale ? { autoscaleInfoProvider: () => null } : {}),
          ...(def.volumeFormat ? { priceFormat: { type: "volume" } } : {}),
          color,
          priceLineVisible: false,
          lastValueVisible: pane > 0,
          crosshairMarkerVisible: false,
          title: "",
        };
        const s = out.kind === "histogram"
          ? this.chart.addSeries(LW.HistogramSeries, opts, pane)
          : this.chart.addSeries(LW.LineSeries, { ...opts, lineWidth: out.lineWidth || 1, ...(out.dots ? { lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 1.5 } : {}) }, pane);
        const vals = res[out.key];
        s.setData(out.kind === "histogram" ? histData(vals, res.colors, timeAt, n) : lineData(vals, res.breaks, timeAt, n));
        list.push(s);
      }
      if (parentPane === undefined)
        for (const lv of def.levels || [])
          list[0].createPriceLine({ price: lv, color: css("--muted"), lineWidth: 1, lineStyle: LW.LineStyle.Dashed, axisLabelVisible: false });
      this.indSeries.set(ind.uid, list);
    }
    this.chart.panes().forEach((p, i) => p.setStretchFactor(i === 0 ? 1 : 0.28));
    this._indicatorMarkers = markers;
    this.updateMarkerLayer();
  }

  updateMarkerLayer() {
    const all = [...(this._indicatorMarkers || []), ...this.extraMarkers, ...(this.eventMarkers || [])]
      .map((m) => ({ ...m, time: this.toChart(m.time) }))
      .filter((m) => !this.replay || m.time <= this.times.at(-1));
    all.sort((x, y) => x.time - y.time);
    this.markers.setMarkers(all);
  }

  async refreshEventMarkers() {
    if (!this.bars?.length || !this.times?.length) return;
    const s = this.chartSettings();
    const enabled = [s.eventDividends, s.eventSplits, s.eventEarnings, s.eventEarningsBreaks, s.eventEconomic, s.eventLatestNews].some(Boolean);
    const key = JSON.stringify([this.cfg.symbol, this.cfg.tf, enabled, s.eventDividends, s.eventSplits, s.eventEarnings, s.eventEconomic, s.eventEconomicImportance, s.eventLatestNews, s.eventNewsNotification, s.eventEarningsBreaks, s.eventSessionBreaks, s.eventSessionColor, s.eventSessionStyle]);
    if (key === this._eventLoadKey) return;
    this._eventLoadKey = key;
    const token = ++this._eventLoadToken;
    this.eventMarkers = [];
    const rows = [];
    const symbol = this.cfg.symbol;
    const addRows = (list, kind, color, shape = "circle") => {
      for (const e of list || []) {
        let sec = typeof e.time === "number" ? (e.time > 1e12 ? Math.floor(e.time / 1000) : Math.floor(e.time)) : Math.floor(Date.parse(e.date || e.time) / 1000);
        if (!Number.isFinite(sec)) continue;
        const idx = this.bars.findIndex((b) => b.time >= sec);
        const i = idx < 0 ? this.bars.length - 1 : idx;
        if (Math.abs(this.bars[i].time - sec) > Math.max(this.step * 3, 86400 * 3)) continue;
        rows.push({ time: this.bars[i].time, position: "aboveBar", color, shape, text: kind, size: 1, _detail: e.title || e.detail || "" });
      }
    };
    const fetches = [];
    if (s.eventDividends || s.eventSplits) fetches.push(api.get(`/api/chart-events?symbol=${encodeURIComponent(symbol)}`).catch(() => ({})));
    else fetches.push(Promise.resolve({}));
    if (s.eventEarnings || s.eventEarningsBreaks) {
      const india = /\.(NS|BO)$/i.test(ticker(symbol));
      fetches.push(api.get(india ? "/api/india-earnings" : "/api/earnings?days=10").catch(() => []));
    } else fetches.push(Promise.resolve([]));
    if (s.eventEconomic) fetches.push(api.get("/api/calendar").catch(() => [])); else fetches.push(Promise.resolve([]));
    if (s.eventLatestNews) fetches.push(api.get(`/api/news?symbol=${encodeURIComponent(symbol)}`).catch(() => ({ items: [] }))); else fetches.push(Promise.resolve({ items: [] }));
    const [corporate, earnings, economic, news] = await Promise.all(fetches);
    if (token !== this._eventLoadToken) return;
    const targetTicker = ticker(symbol).replace(/\.(NS|BO)$/i, "").toUpperCase();
    if (s.eventDividends) addRows(corporate.dividends, "DIV", "#4b87e8");
    if (s.eventSplits) addRows(corporate.splits, "SPL", "#9b72cf", "square");
    if (s.eventEarnings || s.eventEarningsBreaks) addRows((earnings || []).filter((e) => !e.ticker || String(e.ticker).replace(/\.(NS|BO)$/i, "").toUpperCase() === targetTicker), s.eventEarnings ? "ERN" : "E", "#e0a83e", "square");
    if (s.eventEconomic) {
      const importance = s.eventEconomicImportance || "all";
      addRows((economic || []).filter((e) => importance === "all" || String(e.impact || "").toLowerCase() === importance), "ECO", "#d67ade", "square");
    }
    if (s.eventLatestNews) {
      const items = news?.items || [];
      addRows(items.filter((e) => e.time), "NEWS", "#53a8d8");
      const newest = items.find((e) => e.time && Date.now() - e.time < 5 * 60e3);
      if (s.eventNewsNotification && newest && "Notification" in window && Notification.permission === "granted") {
        const id = `${symbol}:${newest.time}`;
        if (localStorage.getItem("qt-event-news-last") !== id) {
          new Notification(`${ticker(symbol)} news`, { body: newest.title || "New market headline" });
          localStorage.setItem("qt-event-news-last", id);
        }
      }
    }
    if (s.eventEarningsBreaks && s.eventEarnings) rows.filter((m) => m.text === "ERN").forEach((m) => rows.push({ ...m, color: "#e0a83e", text: "E" }));
    if (s.eventSessionBreaks && parseTf(this.cfg.tf).unit !== "d" && parseTf(this.cfg.tf).unit !== "w" && parseTf(this.cfg.tf).unit !== "M") {
      const color = s.eventSessionColor || "#4b87e8";
      const glyph = s.eventSessionStyle === "solid" ? "│" : s.eventSessionStyle === "dotted" ? "⋮" : "┆";
      for (let i = 1; i < this.bars.length; i++) if (this.bars[i].time - this.bars[i - 1].time > this.step * 1.75)
        rows.push({ time: this.bars[i].time, position: "aboveBar", color, shape: "square", text: glyph, size: 1 });
    }
    this.eventMarkers = rows.map(({ _detail, ...m }) => m);
    this.updateMarkerLayer();
  }

  async refreshAlertLines() {
    if (!this.main || !this.bars?.length) return;
    const s = this.chartSettings();
    const key = JSON.stringify([this.cfg.symbol, s.alertLines, s.alertOnlyActive, s.alertLineColor]);
    if (key === this._alertLineKey) return;
    this._alertLineKey = key;
    for (const line of this.alertLines) { try { this.main.removePriceLine(line); } catch { /* series was replaced */ } }
    this.alertLines = [];
    if (!s.alertLines) return;
    let alerts;
    try { alerts = await api.get("/api/alerts"); } catch { return; }
    if (key !== JSON.stringify([this.cfg.symbol, this.chartSettings().alertLines, this.chartSettings().alertOnlyActive, this.chartSettings().alertLineColor])) return;
    const color = s.alertLineColor || "#1cae9b";
    for (const alert of alerts || []) {
      if (alert.symbol !== this.cfg.symbol || (s.alertOnlyActive && !alert.active)) continue;
      const conditions = alert.conditions?.length ? alert.conditions : [{ left: alert.left, right: alert.right }];
      for (const condition of conditions) {
        const isPrice = ["close", "open", "high", "low", "volume"].includes(condition.left);
        const price = typeof condition.right === "number" ? condition.right : null;
        if (!isPrice || !Number.isFinite(price) || price <= 0) continue;
        try {
          this.alertLines.push(this.main.createPriceLine({ price, color, lineWidth: 1, lineStyle: LW.LineStyle.Dashed, axisLabelVisible: true, title: "Alert" }));
        } catch { /* ignore conditions that cannot be represented on the price scale */ }
      }
    }
  }

  // "14 on RSI 14 (1D)": the numeric inputs, what it's built on, and its timeframe.
  indicatorParamsLabel(ind) {
    const def = BY_ID[ind.id];
    if (!def) return "";
    const nums = (def.inputs || [])
      .filter((x) => x.type !== "source")
      .map((x) => {
        const v = ind.params?.[x.key] ?? x.default;
        if (x.type !== "time") return v;
        return v ? new Date(v * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "pick a bar";
      })
      .join(" ");
    const src = String(ind.params?.source || "");
    let on = "";
    if (src.startsWith("ind:")) {
      const parent = this.cfg.indicators.find((x) => x.uid === src.split(":")[1]);
      const pd = parent && BY_ID[parent.id];
      on = pd ? ` on ${(/\(([^)]+)\)$/.exec(pd.name)?.[1].split(" / ")[0] || pd.name)} ${this.indicatorParamsLabel(parent)}` : " on (missing)";
    }
    return `${nums}${on}${ind.tf && ind.tf !== this.cfg.tf ? ` (${ind.tf})` : ""}`;
  }

  // ---------- legend ----------
  onCrosshair(p) {
    this._pendingCrosshair = p;
    if (this._crosshairFrame) return;
    this._crosshairFrame = requestAnimationFrame(() => {
      this._crosshairFrame = 0;
      const latest = this._pendingCrosshair; this._pendingCrosshair = null;
      if (latest) this.updateCrosshair(latest);
    });
  }

  updateCrosshair(p) {
    if (this.cfg.lockedCursor && this.contextPoint?.time != null) {
      const price = p.point ? this.main.coordinateToPrice(p.point.y) : this.contextPoint.price;
      if (Number.isFinite(price)) this.chart.setCrosshairPosition(price, this.toChart(this.contextPoint.time), this.main);
      this.updateLegend(Math.max(0, Math.min(this.shown.length - 1, Math.round(this.contextPoint.logical ?? this.shown.length - 1))));
      return;
    }
    if (this.app.tool !== "cursor" && this.drawings.temp && p.point) {
      const pt = this.pointAt(p);
      if (pt) {
        this.drawings.temp.points[this.drawings.temp.points.length - 1] = pt;
        this.drawings.update();
      }
    }
    const i =
      p.logical != null && p.point
        ? Math.max(0, Math.min(this.shown.length - 1, Math.round(p.logical)))
        : null;
    this.updateLegend(i);
    if (this.app.settings.syncCrosshair && p.time && p.point)
      this.app.syncCrosshair(this, p);
  }

  updateLegend(index = null) {
    const settings = this.chartSettings();
    const n = this.shown.length;
    const i = index ?? n - 1;
    const b = this.shown[i],
      prev = this.shown[i - 1];
    const chg = b && prev ? ((b.close - prev.close) / prev.close) * 100 : null;
    const absoluteChange = b && prev ? b.close - prev.close : null;
    const cls = chg == null ? "" : chg >= 0 ? "up" : "down";
    const sym = ticker(this.cfg.symbol);
    const venue = displayExchange(this.cfg.symbol);
    const description = this.cfg.description || this.cfg.name || sym;
    const titleFormat = settings.statusTitleFormat || "name";
    const instrumentTitle = titleFormat === "ticker" ? sym : titleFormat === "ticker-description" ? `${sym} · ${description}` : description;
    const name = `${instrumentTitle} · ${this.cfg.tf}`;
    const badge = settings.statusLogo ? `<span class="legend-exchange">${esc(venue)}</span>` : "";
    const title = settings.statusTitle !== false && settings.labelSymbol !== false ? name : "";
    let previousDayChange = null;
    if (b && settings.statusLastDay !== false) {
      const day = periodKey(b.time, "day");
      for (let j = i - 1; j >= 0; j--) if (periodKey(this.shown[j].time, "day") !== day) { previousDayChange = (b.close - this.shown[j].close) / this.shown[j].close * 100; break; }
    }
    const market = this.marketStatus();
    let html = settings.statusLine === false ? "" : `<div class="row status-line">${badge}${settings.statusMarket ? `<span class="status-dot ${market.open ? "market-open" : "market-closed"}" title="${esc(market.label)}"></span>` : ""}${title ? `<span class="title" data-act="symbol">${esc(title)}</span>` : ""}`;
    if (settings.statusLine !== false && b) html += `<span class="chart-quote"><b>${this.formatPrice(b.close)}</b>${settings.statusChange !== false && absoluteChange != null ? `<span class="${cls}">${absoluteChange >= 0 ? "+" : ""}${this.formatPrice(absoluteChange)} · ${fmtPct(chg)}</span>` : ""}</span>`;
    if (settings.statusLine !== false && b && settings.statusOhlc !== false)
      html += `<span class="ohlc ${cls}"><span><b>O</b>${this.formatPrice(b.open)}</span><span><b>H</b>${this.formatPrice(b.high)}</span><span><b>L</b>${this.formatPrice(b.low)}</span><span><b>C</b>${this.formatPrice(b.close)}</span><span>${fmtPct(chg)}</span></span>`;
    if (settings.statusLine !== false && b && settings.statusVolume !== false) html += `<span class="status-volume">Vol ${fmtPrice(b.volume || 0)}</span>`;
    if (settings.statusLine !== false && b && settings.statusLastDay !== false && previousDayChange != null) html += `<span class="status-change ${previousDayChange >= 0 ? "up" : "down"}">Day ${fmtPct(previousDayChange)}</span>`;
    if (settings.statusLine !== false) html += "</div>";
    for (const sym of this.cfg.compare) {
      html += `<div class="row ind" data-compare="${esc(sym)}"><span class="name">${esc(ticker(sym))} (compare)</span><span class="acts"><button data-act="rmcompare" title="Remove">${ICON.x}</button></span></div>`;
    }
    for (const ind of this.cfg.indicators) {
      const def = BY_ID[ind.id];
      if (!def) continue;
      const res = this.indResults[ind.uid] || {};
      const params = settings.statusIndArguments === false ? "" : this.indicatorParamsLabel(ind);
      const vals = settings.statusIndValues === false ? "" : res.error
        ? `<span class="down">${esc(res.error)}</span>`
        : res.pending
          ? '<span class="muted">loading…</span>'
          : def.outputs
            .map((o) => {
              const v = res[o.key]?.[i];
              return Number.isFinite(v)
                ? `<span style="color:${ind.colors?.[o.key] || o.color}">${this.formatPrice(v)}</span>`
                : "";
            })
            .join(" ");
      const short =
        /\(([^)]+)\)$/.exec(def.name)?.[1].split(" / ")[0] || def.name;
      html += `<div class="row ind" data-uid="${ind.uid}" style="${ind.hidden ? "opacity:.45" : ""};${settings.statusIndBackground === false ? "" : `background:color-mix(in srgb,var(--panel) ${Math.max(0,Math.min(100,Number(settings.statusIndOpacity ?? 85)))}%,transparent)`}"><span class="name">${settings.statusIndTitles !== false && settings.labelIndicators !== false ? esc(short) : ""}${params ? ` <small class="muted">${esc(params)}</small>` : ""}</span><span class="vals">${settings.statusIndValues !== false && settings.labelValues !== false ? vals : ""}</span><span class="acts"><button data-act="settings" title="Settings">${ICON.gear}</button><button data-act="hide" title="Show/hide">${ICON.eye}</button><button data-act="remove" title="Remove">${ICON.x}</button></span></div>`;
    }
    for (const note of this.notes || [])
      html += `<div class="row note">${esc(note)}</div>`;
    this.legendEl.innerHTML = html;
    this.legendEl.onclick = (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === "symbol") return this.app.openSymbolSearch();
      if (act === "rmcompare") {
        this.cfg.compare = this.cfg.compare.filter(
          (s) => s !== btn.closest("[data-compare]").dataset.compare,
        );
        if (!this.cfg.compare.length && !this.cfg.scale) this.cfg.scale = "normal";
        this.app.persist();
        return this.load({ keepView: true });
      }
      const uid = btn.closest("[data-uid]")?.dataset.uid;
      const ind = this.cfg.indicators.find((x) => x.uid === uid);
      if (!ind) return;
      if (act === "remove") this.removeIndicator(uid);
      if (act === "hide") {
        ind.hidden = !ind.hidden;
        this.render(false);
        this.app.persist();
      }
      if (act === "settings") this.app.openIndicatorSettings(this, ind);
    };
  }

  marketStatus() {
    const sym = String(this.cfg.symbol || "").toUpperCase();
    if (/^(BINANCE|COINBASE|KRAKEN|CRYPTO):/.test(sym)) return { open: true, label: "Crypto markets trade 24/7" };
    if (/\.NS$|\.BO$|\^NSEI|\^BSESN/.test(sym)) {
      const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
      const part = (type) => parts.find((p) => p.type === type)?.value;
      const weekday = !["Sat", "Sun"].includes(part("weekday"));
      const minute = Number(part("hour")) * 60 + Number(part("minute"));
      const open = weekday && minute >= 555 && minute < 930;
      return { open, label: `${open ? "Open" : "Closed"} · NSE/BSE regular hours 09:15–15:30 IST (holiday calendar not included)` };
    }
    return { open: true, label: "Market data connected; exchange session status unavailable" };
  }

  // ---------- indicators ----------
  addIndicator(id, params = {}) {
    const uid = newUid();
    this.cfg.indicators.push({ uid, id, params });
    this.render(false);
    this.app.persist();
    return uid;
  }
  removeIndicator(uid) {
    this.cfg.indicators = this.cfg.indicators.filter((x) => x.uid !== uid);
    this.render(false);
    this.app.persist();
  }

  // ---------- drawing tools ----------
  pointAt(p) {
    if (p.paneIndex) return null; // drawings live on the price pane only
    if (!p.point || p.logical == null) return null;
    const logical =
      this.chart.timeScale().coordinateToLogical(p.point.x) ?? p.logical;
    const price = this.main.coordinateToPrice(p.point.y);
    const time = this.timeOfLogical(logical);
    return price == null || time == null ? null : { time, price };
  }

  onClick(p) {
    const tool = this.app.tool;
    if (tool === "anchor-pick") {
      const pick = this.app.pendingAnchor;
      const ind = pick?.pane === this && this.cfg.indicators.find((x) => x.uid === pick.uid);
      const pt = this.pointAt(p);
      if (!ind || !pt) return;
      // Snap to the raw bar under the click (works on Renko/Heikin Ashi too).
      let i = this.bars.findIndex((b) => b.time > pt.time) - 1;
      if (i < 0) i = this.bars.length - 1;
      ind.params = { ...ind.params, [pick.key]: this.bars[i].time };
      this.app.pendingAnchor = null;
      this.app.setTool("cursor");
      this.render(false);
      this.app.persist();
      this.app.toast("Anchored.");
      return;
    }
    if (tool === "replay-pick") {
      const pt = this.pointAt(p);
      if (!pt) return;
      // map the clicked time back to the raw bars (works for Renko/Heikin Ashi too)
      let i = this.bars.findIndex((b) => b.time > pt.time) - 1;
      if (i < 0) i = this.bars.length - 1;
      this.app.setTool("cursor");
      this.startReplay(Math.max(1, i));
      return;
    }
    if (tool === "cursor") {
      if (!p.point) return;
      this.drawings.selected = this.drawings.hitTest(p.point.x, p.point.y);
      this.drawings.update();
      return;
    }
    const def = TOOL_BY_ID[tool];
    const pt = this.pointAt(p);
    if (!def || !pt) return;
    const d = this.drawings;
    if (!d.temp) {
      d.temp = { id: newUid(), type: tool, points: [pt], color: this.app.drawingColor || this.app.settings.drawingColor };
      if (def.points > 1) d.temp.points.push({ ...pt });
    } else {
      d.temp.points[d.temp.points.length - 1] = pt;
      if (d.temp.points.length < def.points) d.temp.points.push({ ...pt });
      else d.temp.done = true;
    }
    if (def.points === 1) d.temp.done = true;
    if (d.temp.done) {
      const item = d.temp;
      delete item.done;
      d.temp = null;
      if (item.type === "text") {
        const text = prompt("Note text:", "");
        if (!text) {
          d.update();
          this.app.setTool("cursor");
          return;
        }
        item.text = text;
      }
      d.items.push(item);
      d.selected = item;
      this.commitDrawings();
      if (!this.app.settings.stayInDrawMode) this.app.setTool("cursor");
    }
    d.update();
  }

  deleteSelectedDrawing() {
    const d = this.drawings;
    if (!d.selected) return false;
    d.items = d.items.filter((x) => x !== d.selected);
    d.selected = null;
    d.update();
    this.commitDrawings();
    return true;
  }

  commitDrawings() {
    this.drawings.commit();
    this.app.saveDrawings(this.cfg.symbol, this.cfg.tf, this.drawings.items);
  }

  undoDrawing() {
    if (!this.drawings.undo()) return false;
    this.app.saveDrawings(this.cfg.symbol, this.cfg.tf, this.drawings.items);
    return true;
  }

  redoDrawing() {
    if (!this.drawings.redo()) return false;
    this.app.saveDrawings(this.cfg.symbol, this.cfg.tf, this.drawings.items);
    return true;
  }

  setSelectedDrawingColor(color) {
    const d = this.drawings.selected;
    if (!d) return;
    d.color = color;
    this.drawings.update();
    this.commitDrawings();
  }

  toggleDrawingLock() {
    const d = this.drawings.selected;
    if (!d) return this.app.toast("Select a drawing to lock it.");
    d.locked = !d.locked;
    this.drawings.update();
    this.commitDrawings();
    this.app.toast(d.locked ? "Drawing locked." : "Drawing unlocked.");
  }

  clearDrawings() {
    this.drawings.items = [];
    this.drawings.selected = null;
    this.drawings.temp = null;
    this.drawings.update();
    this.commitDrawings();
  }

  setInteractive(on) {
    this.chart.applyOptions({ handleScroll: on, handleScale: on });
    if (on && this.drawings.temp) {
      this.drawings.temp = null;
      this.drawings.update();
    }
  }

  // ---------- live updates ----------
  startLive() {
    this.stopLive();
    if (this.replay || !this.bars.length) return;
    const ex = exchange(this.cfg.symbol);
    const wsTf = BINANCE_WS_TF[this.cfg.tf];
    if (ex === "BINANCE" && this.provider === "Binance" && wsTf)
      this.openSocket(ticker(this.cfg.symbol).toLowerCase(), wsTf, 0);
    else this.poll();
  }

  openSocket(sym, interval, hostIdx) {
    const hosts = [
      "wss://stream.binance.com:9443/ws/",
      "wss://data-stream.binance.vision/ws/",
    ];
    if (hostIdx >= hosts.length) return this.poll();
    let opened = false;
    const ws = new WebSocket(`${hosts[hostIdx]}${sym}@kline_${interval}`);
    this.ws = ws;
    ws.onopen = () => {
      opened = true;
      this.app.setStatus("ok");
    };
    ws.onmessage = (m) => {
      const k = JSON.parse(m.data).k;
      if (k)
        this.merge([
          {
            time: k.t / 1000,
            open: +k.o,
            high: +k.h,
            low: +k.l,
            close: +k.c,
            volume: +k.v,
          },
        ]);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (!opened) this.openSocket(sym, interval, hostIdx + 1);
      else this.liveTimer = setTimeout(() => this.startLive(), 3000);
    };
  }

  poll() {
    const kind = ["BINANCE", "COINBASE", "KRAKEN"].includes(
      exchange(this.cfg.symbol),
    )
      ? 3000
      : 10000;
    const tick = async () => {
      try {
        const r = await api.candles(this.cfg.symbol, this.cfg.tf, 5);
        this.merge(r.candles);
      } catch {
        /* keep trying */
      }
      this.liveTimer = setTimeout(tick, kind);
    };
    this.liveTimer = setTimeout(tick, kind);
  }

  stopLive() {
    clearTimeout(this.liveTimer);
    this.liveTimer = null;
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.close();
    }
  }

  merge(newBars) {
    if (!this.bars.length || this.replay) return;
    let changed = false;
    for (const b of newBars) {
      const last = this.bars.at(-1);
      if (b.time === last.time) {
        this.bars[this.bars.length - 1] = b;
        changed = true;
      } else if (b.time > last.time) {
        this.bars.push(b);
        changed = true;
      }
    }
    if (!changed) return;
    const last = this.bars.at(-1);
    this.app.onPrice(this.cfg.symbol, last.close);
    const simple = [
      "candles",
      "hollow",
      "bars",
      "line",
      "linemarkers",
      "step",
      "area",
      "baseline",
      "columns",
    ].includes(this.cfg.type);
    if (simple) {
      this.shown = this.bars;
      if (this.times.at(-1) !== this.toChart(last.time))
        this.times.push(this.toChart(last.time));
      this.main.update(this.pointFor(last));
      this.volume?.update(this.volPoint(last));
    }
    const now = Date.now();
    if (now - (this.mtfCheckedAt || 0) > 60000) {
      this.mtfCheckedAt = now;
      for (const [tf, h] of Object.entries(this.mtf || {})) if (now - h.at > 60000) this.loadMtf(tf);
    }
    if (!simple || now - (this.lastFull || 0) > 1500) {
      this.lastFull = now;
      if (simple) {
        this.renderIndicators();
        this.updateLegend();
      } else this.render(false);
    }
  }

  // ---------- bar replay ----------
  startReplay(index) {
    this.stopLive();
    this.replay = {
      index: Math.max(1, Math.min(index, this.bars.length - 1)),
      playing: false,
      speed: 2,
    };
    let bar = this.el.querySelector(".replay-bar");
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "replay-bar";
      bar.innerHTML = `<span class="hint">Replay</span>
        <button data-r="back" title="Step back">&#9664;&#9664;</button>
        <button data-r="play" title="Play / pause">&#9654;</button>
        <button data-r="fwd" title="Step forward">&#9654;&#9654;</button>
        <select data-r="speed" title="Speed"><option value="0.5">0.5x</option><option value="1">1x</option><option value="2" selected>2x</option><option value="5">5x</option><option value="10">10x</option></select>
        <button data-r="pick" title="Pick a new start bar">Jump to…</button>
        ${this.app.panes.length > 1 ? `<label class="hint" title="Replay every chart in the layout to the same moment"><input type="checkbox" data-r="sync" ${this.app.settings.syncReplay ? "checked" : ""}> All charts</label>` : ""}
        <button data-r="exit" title="Back to live">Exit</button>`;
      this.el.appendChild(bar);
      bar.addEventListener("click", (e) => {
        const r = e.target.closest("[data-r]")?.dataset.r;
        if (r === "back") this.replayStep(-1);
        if (r === "fwd") this.replayStep(1);
        if (r === "play") this.toggleReplay();
        if (r === "pick") this.app.setTool("replay-pick");
        if (r === "exit") this.stopReplay();
      });
      const sync = bar.querySelector('[data-r="sync"]');
      if (sync)
        sync.onchange = (e) => {
          this.app.settings.syncReplay = e.target.checked;
          this.app.persist();
          if (e.target.checked) this.app.onReplayStart?.(this);
          else this.app.onReplayStop?.(this, { keepSelf: true });
        };
      bar.querySelector('[data-r="speed"]').onchange = (e) => {
        this.replay.speed = Number(e.target.value);
        if (this.replay.playing) {
          this.toggleReplay();
          this.toggleReplay();
        }
      };
    }
    this.render(false);
    this.app.onReplayStart?.(this);
  }

  // Follow another chart's replay: show only the bars that had finished by `endTime`.
  replayTo(endTime) {
    const sec = parseTf(this.cfg.tf).seconds;
    let i = this.bars.length - 1;
    while (i > 0 && this.bars[i].time + sec > endTime) i--;
    if (!this.replay) {
      this.stopLive();
      this.replay = { index: i, playing: false, speed: 2, follower: true };
      this.el.querySelector(".replay-bar")?.remove();
      const tag = document.createElement("div");
      tag.className = "replay-bar follower";
      tag.innerHTML = '<span class="hint">Synced replay</span>';
      this.el.appendChild(tag);
    } else this.replay.index = i;
    this.render(false);
  }

  replayStep(dir) {
    if (!this.replay) return;
    const next = this.replay.index + dir;
    if (next < 1 || next >= this.bars.length) {
      if (this.replay.playing) this.toggleReplay();
      return;
    }
    this.replay.index = next;
    this.render(false);
    this.app.onReplayBar?.(this, this.bars[next]);
  }

  toggleReplay() {
    if (!this.replay) return;
    this.replay.playing = !this.replay.playing;
    clearInterval(this.replayTimer);
    clearInterval(this.eventRefreshTimer);
    clearInterval(this.alertLineRefreshTimer);
    if (this.replay.playing)
      this.replayTimer = setInterval(
        () => this.replayStep(1),
        1000 / this.replay.speed,
      );
    const btn = this.el.querySelector('[data-r="play"]');
    if (btn)
      btn.innerHTML = this.replay.playing ? "&#10074;&#10074;" : "&#9654;";
  }

  stopReplay() {
    clearInterval(this.replayTimer);
    const wasFollower = this.replay?.follower;
    this.replay = null;
    this.el.querySelector(".replay-bar")?.remove();
    this.render(true);
    this.startLive();
    if (!wasFollower) this.app.onReplayStop?.(this);
  }

  // ---------- export ----------
  screenshot() {
    const canvas = this.chart.takeScreenshot(true);
    const ctx = canvas.getContext("2d");
    ctx.font = "600 14px -apple-system, Segoe UI, Roboto, sans-serif";
    ctx.fillStyle = css("--text");
    ctx.fillText(`${ticker(this.cfg.symbol)} · ${this.cfg.tf}`, 12, 22);
    return canvas;
  }

  destroy() {
    document.removeEventListener("pointerdown", this.dismissContextMenu);
    this.contextMenu?.remove();
    this.stopLive();
    clearInterval(this.replayTimer);
    this.resizeObserver?.disconnect();
    if (this.resizeFrame) cancelAnimationFrame(this.resizeFrame);
    this.chart.remove();
  }
}
