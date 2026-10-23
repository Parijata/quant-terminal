import { api, download, esc, ticker, displayExchange } from "./api.js";
import { ChartPane, CHART_TYPES, newUid } from "./chart.js";
import { TOOLS } from "./drawings.js";
import {
  INDICATORS,
  BY_ID,
  registerIndicator,
  compute,
} from "../lib/indicators.js";
import { parseTf, toCsv } from "../lib/series.js";
import { initPanels } from "./panels.js";

const $ = (s, el = document) => el.querySelector(s);
const normalizeSymbolType = (raw) => {
  const t = String(raw || "").toLowerCase().replace(/[^a-z]/g, "");
  if (/crypto|cryptocurrency/.test(t)) return "crypto";
  if (/future|futures/.test(t)) return "futures";
  if (/forex|currency/.test(t)) return "forex";
  if (/option/.test(t)) return "option";
  if (/bond|fixedincome/.test(t)) return "bond";
  if (/econom/.test(t)) return "economy";
  if (/index|indices/.test(t)) return "index";
  if (/etf|fund|mutualfund/.test(t)) return "fund";
  return "stock";
};
const formatSymbolType = (raw) => ({ stock:"Stock", fund:"Fund / ETF", futures:"Future", forex:"Forex", crypto:"Crypto", index:"Index", bond:"Bond", economy:"Economy", option:"Option" })[normalizeSymbolType(raw)] || String(raw || "Market");
const symbolLogo = (r) => {
  const ex = displayExchange(r.symbol, r.exchange);
  const type = normalizeSymbolType(r.type);
  const label = ({ NSE:"N", BSE:"B", US:"US", BINANCE:"₿", COINBASE:"C", KRAKEN:"K", CME:"C", NASDAQ:"N", NYSE:"N", FX:"FX" })[ex] || (type === "crypto" ? "₿" : type === "forex" ? "$" : type === "index" ? "IDX" : type === "bond" ? "B" : type === "option" ? "O" : "•");
  const color = ({ NSE:"nse", BSE:"bse", US:"us", BINANCE:"binance", COINBASE:"coinbase", KRAKEN:"kraken", CME:"cme", NASDAQ:"nasdaq", NYSE:"nyse", FX:"fx" })[ex] || type;
  return `<span class="symbol-logo logo-${color}" aria-hidden="true">${label}</span>`;
};
const TF_QUICK = ["1m", "5m", "15m", "1h", "4h", "1D", "1W", "1M"];
const LAYOUTS = { 1: 1, "2v": 2, "2h": 2, 3: 3, 4: 4, 6: 6, 8: 8, 16: 16 };
const DEFAULT_WATCHLISTS = {
  Main: [
    "BINANCE:BTCUSDT",
    "BINANCE:ETHUSDT",
    "BINANCE:SOLUSDT",
    "US:AAPL",
    "US:NVDA",
    "US:SPY",
    "US:QQQ",
    "FX:EURUSD",
  ],
  "Indian stocks": [
    "YAHOO:^NSEI", "YAHOO:^BSESN", "YAHOO:RELIANCE.NS", "YAHOO:TCS.NS",
    "YAHOO:INFY.NS", "YAHOO:HDFCBANK.NS", "YAHOO:SBIN.NS", "YAHOO:ICICIBANK.NS",
    "YAHOO:BHARTIARTL.NS", "YAHOO:ITC.NS", "YAHOO:LT.NS", "YAHOO:BAJFINANCE.NS",
  ],
};

class App {
  constructor() {
    this.panes = [];
    this.active = null;
    this.tool = "cursor";
    this.prices = {};
    this.priceListeners = new Set();
    this.saveTimer = null;
    this.drawingColor = "#0EC7A3";
  }

  async init() {
    let state = {};
    try {
      state = await api.get("/api/state");
    } catch {
      /* first run */
    }
    this.state = {
      layout: "1",
      panes: [
        {
          symbol: "BINANCE:BTCUSDT",
          tf: "1D",
          type: "candles",
          indicators: [
            { uid: newUid(), id: "ema", params: { length: 21 } },
            { uid: newUid(), id: "rsi", params: {} },
          ],
        },
      ],
      watchlists: DEFAULT_WATCHLISTS,
      activeWatchlist: "Main",
      drawings: {},
      settings: {},
      paper: null,
      strategies: {},
      ...state,
    };
    this.state.drawings ||= {};
    this.state.watchlists = { ...DEFAULT_WATCHLISTS, ...(state.watchlists || {}) };
    this.state.templates ||= [];
    if (!Object.hasOwn(LAYOUTS, this.state.layout)) this.state.layout = "1";
    if (!this.state.watchlists[this.state.activeWatchlist])
      this.state.activeWatchlist = Object.keys(this.state.watchlists)[0];
    this.settings = {
      theme: "dark",
      volume: true,
      bars: 3000,
      utc: false,
      stayInDrawMode: false,
      syncCrosshair: false,
      syncTf: false,
      drawingColor: this.drawingColor,
      ...this.state.settings,
    };
    if (String(this.settings.drawingColor).toLowerCase() === "#39ff14") this.settings.drawingColor = "#0EC7A3";
    this.state.settings = this.settings;
    this.drawingColor = this.settings.drawingColor;
    document.documentElement.dataset.theme = this.settings.theme;
    await this.loadCustomIndicators();
    this.buildToolbar();
    this.buildDrawbar();
    this.setLayout(this.state.layout, false);
    this.panels = initPanels(this);
    this.initSidePanel();
    this.bindKeys();
    this.listenAlerts();
    this.checkHealth();
    setInterval(() => this.checkHealth(), 60000);
  }

  initSidePanel() {
    const main = $(".main"), side = $(".side"), grip = $("#sideResize"), toggle = $("#sideToggle");
    let width = Math.min(520, Math.max(220, Number(this.settings.sideWidth) || 300));
    const setWidth = (value) => {
      width = Math.min(520, Math.max(220, value));
      side.style.setProperty("--side-width", `${width}px`);
    };
    const setCollapsed = (collapsed, save = true) => {
      main.classList.toggle("side-collapsed", collapsed);
      toggle.textContent = collapsed ? "‹" : "›";
      toggle.title = collapsed ? "Expand side panel" : "Collapse side panel";
      toggle.setAttribute("aria-label", toggle.title);
      if (save) {
        this.settings.sideCollapsed = collapsed;
        this.persist();
      }
    };
    setWidth(width);
    setCollapsed(!!this.settings.sideCollapsed, false);
    toggle.onclick = () => setCollapsed(!main.classList.contains("side-collapsed"));
    grip.addEventListener("pointerdown", (e) => {
      if (main.classList.contains("side-collapsed")) return;
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      const startX = e.clientX, startWidth = width;
      const move = (ev) => setWidth(startWidth + startX - ev.clientX);
      const finish = () => {
        grip.removeEventListener("pointermove", move);
        this.settings.sideWidth = width;
        this.persist();
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", finish, { once: true });
      grip.addEventListener("pointercancel", finish, { once: true });
    });
  }

  // ---------- persistence ----------
  persist() {
    this.state.panes = this.panes.map((p) => p.cfg);
    this.state.active = this.panes.indexOf(this.active);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(
      () =>
        api
          .put("/api/state", this.state)
          .catch((e) => this.toast(`Couldn't save: ${e.message}`, "err")),
      400,
    );
  }
  drawingKey(symbol, tf) {
    return JSON.stringify([symbol, tf]);
  }
  getDrawings(symbol, tf) {
    return structuredClone(
      this.state.drawings[this.drawingKey(symbol, tf)] || this.state.drawings[symbol] || [],
    );
  }
  saveDrawings(symbol, tf, items) {
    const key = this.drawingKey(symbol, tf);
    this.state.drawings[key] = items.map(
      ({ id, type, points, text, color, rr, locked }) => ({
        id,
        type,
        points: structuredClone(points),
        text,
        color,
        rr,
        locked: !!locked,
      }),
    );
    for (const p of this.panes)
      if (p.cfg.symbol === symbol && p.cfg.tf === tf && p.drawings.items !== items)
        p.drawings.setItems(this.getDrawings(symbol, tf));
    this.persist();
  }

  // ---------- custom indicators ----------
  async loadCustomIndicators() {
    try {
      const list = await api.get("/api/custom");
      for (const c of list) await this.importCustom(c.file, c.mtime);
    } catch {
      /* none */
    }
  }
  async importCustom(file, v = Date.now()) {
    try {
      const mod = await import(`/custom/${encodeURIComponent(file)}?v=${v}`);
      return registerIndicator({
        ...mod.default,
        id: `custom:${file.replace(/\.js$/, "")}`,
      });
    } catch (e) {
      this.toast(
        `Custom indicator ${file} failed to load: ${e.message}`,
        "err",
      );
      return null;
    }
  }

  // ---------- layout ----------
  setLayout(layout, save = true) {
    const count = LAYOUTS[layout] || 1;
    this.state.layout = String(layout);
    const grid = $("#grid");
    grid.dataset.count = count;
    const cols = {
      1: "1fr",
      2: layout === "2h" ? "1fr" : "1fr 1fr",
      3: "2fr 1fr",
      4: "1fr 1fr",
      6: "1fr 1fr 1fr",
      8: "1fr 1fr 1fr 1fr",
      16: "repeat(4, 1fr)",
    }[count];
    const rows = {
      1: "1fr",
      2: layout === "2h" ? "1fr 1fr" : "1fr",
      3: "1fr 1fr",
      4: "1fr 1fr",
      6: "1fr 1fr",
      8: "1fr 1fr",
      16: "repeat(4, 1fr)",
    }[count];
    grid.style.gridTemplateColumns = cols;
    grid.style.gridTemplateRows = rows;
    const cfgs = this.panes.length
      ? this.panes.map((p) => p.cfg)
      : this.state.panes;
    while (this.panes.length > count) this.panes.pop().destroy();
    const tfs = ["1D", "4h", "1h", "15m", "1W", "5m", "30m", "2h"];
    for (let i = 0; i < count; i++) {
      if (this.panes[i]) continue;
      const el = document.createElement("div");
      el.className = "pane";
      grid.appendChild(el);
      const base = cfgs[i] || {
        ...structuredClone(cfgs[0] || {}),
        tf: tfs[i % tfs.length],
        indicators: [],
      };
      const pane = new ChartPane(this, el, base);
      this.panes.push(pane);
      pane.load();
    }
    [...grid.children].forEach((el) => {
      if (!this.panes.some((p) => p.el === el)) el.remove();
    });
    if (count === 3) this.panes[0].el.style.gridRow = "span 2";
    else if (this.panes[0]) this.panes[0].el.style.gridRow = "";
    this.setActive(
      this.panes[Math.min(this.state.active ?? 0, count - 1)] || this.panes[0],
    );
    $("#layoutSel").value = this.state.layout;
    if (save) this.persist();
  }

  setActive(pane) {
    if (!pane || this.active === pane) return;
    this.active?.el.classList.remove("active");
    this.active = pane;
    pane.el.classList.add("active");
    this.syncToolbar();
    this.panels?.onActiveChange?.();
  }

  onPaneLoaded(pane) {
    if (pane === this.active) {
      this.syncToolbar();
      this.panels?.onActiveChange?.();
    }
  }

  // ---------- toolbar ----------
  buildToolbar() {
    const tfBox = $("#tfButtons");
    const renderTfButtons = () => { const tfs = [...new Set([...TF_QUICK, ...(this.settings.tfFavorites || [])])]; tfBox.innerHTML = tfs.map(
      (t) => `<button data-tf="${t}">${t}</button>`,
    ).join(""); };
    renderTfButtons();
    $("#tfPreset").onchange = (e) => {
      const tf = e.target.value;
      if (!tf) return;
      this.setTf(tf);
    };
    tfBox.onclick = (e) => {
      const tf = e.target.dataset.tf;
      if (tf) this.setTf(tf);
    };
    $("#tfCustom").onkeydown = (e) => {
      if (e.key !== "Enter") return;
      const v = e.target.value
        .trim()
        .replace(/^(\d+)d$/i, "$1D")
        .replace(/^(\d+)w$/i, "$1W");
      try {
        parseTf(v);
        this.setTf(v);
        e.target.value = "";
        e.target.blur();
      } catch (err) {
        this.toast(err.message, "err");
      }
    };
    $("#tfFav").onclick = () => {
      const tf = this.active?.cfg.tf;
      if (!tf) return;
      const favorites = new Set(this.settings.tfFavorites || []);
      if (favorites.has(tf)) favorites.delete(tf); else favorites.add(tf);
      this.settings.tfFavorites = [...favorites];
      renderTfButtons();
      this.syncToolbar();
      this.persist();
    };
    $("#chartType").innerHTML = CHART_TYPES.map(
      ([v, l]) => `<option value="${v}">${l}</option>`,
    ).join("");
    $("#chartType").onchange = (e) => {
      this.active.cfg.type = e.target.value;
      this.active.render(true);
      this.persist();
    };
    $("#symbolBtn").onclick = () => this.openSymbolSearch();
    $("#indicatorsBtn").onclick = () => this.openIndicatorPicker();
    $("#compareBtn").onclick = () =>
      this.openSymbolSearch(
        "",
        (sym) => {
          this.active.cfg.compare.push(sym);
          this.active.cfg.scale ||= "percentage";
          this.persist();
          this.active.load({ keepView: true });
        },
        "Compare with…",
      );
    $("#layoutSel").onchange = (e) => this.setLayout(e.target.value);
    $("#scaleSel").onchange = (e) => {
      this.active.cfg.scale = e.target.value;
      this.active.cfg.log = e.target.value === "log";
      this.active.render(false);
      this.syncToolbar();
      this.persist();
    };
    $("#templateBtn").onclick = () => this.openTemplates();
    $("#syncSymbol").checked = !!this.settings.syncSymbol;
    $("#syncSymbol").onchange = (e) => {
      this.settings.syncSymbol = e.target.checked;
      this.persist();
    };
    $("#syncTf").checked = !!this.settings.syncTf;
    $("#syncTf").onchange = (e) => {
      this.settings.syncTf = e.target.checked;
      this.persist();
    };
    $("#crosshairSync").checked = !!this.settings.syncCrosshair;
    $("#crosshairSync").onchange = (e) => {
      this.settings.syncCrosshair = e.target.checked;
      this.persist();
    };
    $("#replayBtn").onclick = () => {
      if (this.active.replay) return this.active.stopReplay();
      this.setTool("replay-pick");
      this.toast("Click the bar you want replay to start from.");
    };
    $("#alertBtn").onclick = () => this.panels.openAlertDialog();
    $("#snapBtn").onclick = () =>
      this.active
        .screenshot()
        .toBlob((b) =>
          download(
            `${ticker(this.active.cfg.symbol)}-${this.active.cfg.tf}.png`,
            b,
          ),
        );
    $("#csvBtn").onclick = () => this.exportCsv();
    $("#themeBtn").onclick = () => {
      this.settings.theme = this.settings.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = this.settings.theme;
      this.panes.forEach((p) => p.applyTheme());
      this.panels.onTheme?.();
      this.persist();
    };
    $("#settingsBtn").onclick = () => this.openSettings();
  }

  syncToolbar() {
    const p = this.active;
    if (!p) return;
    $("#symbolLabel").textContent = ticker(p.cfg.symbol);
    $("#symbolBtn").title =
      `${p.cfg.symbol} — change symbol (or just start typing)`;
    document
      .querySelectorAll("#tfButtons button")
      .forEach((b) => b.classList.toggle("active", b.dataset.tf === p.cfg.tf));
    $("#tfCustom").placeholder = TF_QUICK.includes(p.cfg.tf) ? "7m" : p.cfg.tf;
    $("#tfCustom").classList.toggle("on", !TF_QUICK.includes(p.cfg.tf));
    const preset = $("#tfPreset");
    preset.value = [...preset.options].some((o) => o.value === p.cfg.tf) ? p.cfg.tf : "";
    const favorites = this.settings.tfFavorites || [];
    $("#tfFav").textContent = favorites.includes(p.cfg.tf) ? "★" : "☆";
    $("#tfFav").classList.toggle("on", favorites.includes(p.cfg.tf));
    $("#chartType").value = p.cfg.type;
    $("#scaleSel").value = p.cfg.scale || (p.cfg.compare?.length ? "percentage" : p.cfg.log ? "log" : "normal");
    $("#replayBtn").classList.toggle("on", !!p.replay);
  }

  setTf(tf) {
    const targets = this.settings.syncTf ? this.panes : [this.active];
    for (const pane of targets) {
      pane.cfg.tf = tf;
      pane.load();
    }
    this.syncToolbar();
    this.persist();
  }

  setSymbol(sym, pane = this.active) {
    const targets = this.settings.syncSymbol ? this.panes : [pane];
    for (const p of targets) {
      p.cfg.symbol = sym;
      p.cfg.compare = p.cfg.compare.filter((s) => s !== sym);
      p.load();
    }
    this.syncToolbar();
    this.persist();
  }

  buildDrawbar() {
    const bar = $("#drawbar");
    const groups = [
      { name: "Cursor", ids: ["cursor"] },
      { name: "Measure", ids: ["measure"] },
      { name: "Lines", ids: ["trend", "ray", "extended", "hline", "hray", "vline", "arrow"] },
      { name: "Channels", ids: ["channel"] },
      { name: "Fibonacci", ids: ["fib", "fibext"] },
      { name: "Shapes and notes", ids: ["rect", "text"] },
      { name: "Positions", ids: ["long", "short"] },
    ];
    const byId = new Map(TOOLS.map((tool) => [tool.id, tool]));
    const button = (tool, group) => `<button data-tool="${tool.id}" data-tool-group="${esc(group)}" title="${esc(tool.label)}" aria-label="${esc(tool.label)}"><svg viewBox="0 0 24 24">${tool.icon}</svg></button>`;
    bar.innerHTML = groups.map((group) => {
      const tools = group.ids.map((id) => byId.get(id)).filter(Boolean);
      if (tools.length === 1) return `<div class="draw-group">${button(tools[0], group.name)}</div>`;
      return `<div class="draw-group" data-draw-group="${esc(group.name)}"><div class="draw-group-head">${button(tools[0], group.name)}<button class="draw-group-toggle" data-group-toggle title="${esc(group.name)} tools" aria-label="Show ${esc(group.name)} tools">⌄</button></div><div class="draw-submenu" role="menu" aria-label="${esc(group.name)}">${tools.map((tool) => `<div class="draw-subtool">${button(tool, group.name)}<span>${esc(tool.label)}</span></div>`).join("")}</div></div>`;
    }).join("") +
      '<hr><button data-act="alert" title="Alert when price crosses the selected line"><svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 20h4"/></svg></button>' +
      '<button data-act="delete" title="Delete selected drawing (Delete key)"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>' +
      '<button data-act="clear" title="Remove drawings on this symbol and timeframe"><svg viewBox="0 0 24 24"><path d="M5 5l14 14M19 5L5 19"/></svg></button>' +
      '<hr><button data-act="undo" title="Undo drawing change (Ctrl+Z)">↶</button>' +
      '<button data-act="redo" title="Redo drawing change (Ctrl+Y)">↷</button>' +
      '<button data-act="lock" title="Lock or unlock selected drawing">🔒</button>' +
      `<label class="draw-color" title="Drawing colour"><input type="color" id="drawColor" value="${this.drawingColor}"></label>`;
    bar.onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.groupToggle !== undefined) {
        const group = b.closest(".draw-group");
        const wasOpen = group.classList.contains("open");
        bar.querySelectorAll(".draw-group.open").forEach((item) => item.classList.remove("open"));
        if (!wasOpen) {
          group.classList.add("open");
          const rect = group.getBoundingClientRect();
          const menu = group.querySelector(".draw-submenu");
          menu.style.top = `${Math.max(8, Math.min(innerHeight - menu.offsetHeight - 8, rect.top))}px`;
          menu.style.left = `${rect.right + 4}px`;
        }
        return;
      }
      if (b.dataset.tool)
        this.setTool(this.tool === b.dataset.tool ? "cursor" : b.dataset.tool);
      if (b.dataset.tool) bar.querySelectorAll(".draw-group.open").forEach((item) => item.classList.remove("open"));
      if (b.dataset.act === "alert") this.alertOnSelectedDrawing();
      if (b.dataset.act === "delete" && !this.active.deleteSelectedDrawing())
        this.toast("Click a drawing first to select it.");
      if (b.dataset.act === "undo") this.active?.undoDrawing();
      if (b.dataset.act === "redo") this.active?.redoDrawing();
      if (b.dataset.act === "lock") this.active?.toggleDrawingLock();
      if (
        b.dataset.act === "clear" &&
        confirm(`Remove drawings on ${ticker(this.active.cfg.symbol)} · ${this.active.cfg.tf}?`)
      )
        this.active.clearDrawings();
    };
    bar.querySelector("#drawColor").onchange = (e) => {
      this.drawingColor = e.target.value;
      this.settings.drawingColor = e.target.value;
      this.active?.setSelectedDrawingColor(e.target.value);
      this.persist();
    };
    document.addEventListener("pointerdown", (e) => {
      if (!bar.contains(e.target)) bar.querySelectorAll(".draw-group.open").forEach((item) => item.classList.remove("open"));
    });
    bar.addEventListener("keydown", (e) => {
      if (e.key === "Escape") bar.querySelectorAll(".draw-group.open").forEach((item) => item.classList.remove("open"));
    });
    this.setTool("cursor");
  }

  setTool(tool) {
    this.tool = tool;
    document
      .querySelectorAll("#drawbar [data-tool]")
      .forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
    document.querySelectorAll("#drawbar [data-draw-group]").forEach((group) => {
      const selected = !!group.querySelector("[data-tool].active");
      group.querySelector(".draw-group-head > [data-tool]")?.classList.toggle("active", selected);
    });
    for (const p of this.panes) p.setInteractive(tool === "cursor");
    document.body.style.cursor = tool === "cursor" ? "" : "crosshair";
  }

  // ---------- modals ----------
  modal(title, bodyHtml, { foot = "", wide = false } = {}) {
    const card = $("#modalCard");
    card.classList.remove("chart-settings-card");
    card.style.width = wide ? "min(780px, 96vw)" : "";
    card.innerHTML = `<div class="modal-head"><span>${esc(title)}</span><button data-close title="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div><div class="modal-body">${bodyHtml}</div>${foot ? `<div class="modal-foot">${foot}</div>` : ""}`;
    $("#modal").classList.remove("hidden");
    card.querySelector("[data-close]").onclick = () => this.closeModal();
    $("#modal").onmousedown = (e) => {
      if (e.target.id === "modal") this.closeModal();
    };
    return card;
  }
  closeModal() {
    $("#modal").classList.add("hidden");
    $("#modalCard").innerHTML = "";
  }

  openSymbolSearch(initial = "", onPick = null, title = "Symbol search") {
    const card = this.modal(
      title,
      `<div class="row-flex" style="margin-bottom:8px"><label class="field">Asset type<select class="in" id="symType"><option value="all">All markets</option><option value="stock">Stocks</option><option value="fund">Funds / ETFs</option><option value="futures">Futures</option><option value="forex">Forex</option><option value="crypto">Crypto</option><option value="index">Indices</option><option value="bond">Bonds</option><option value="economy">Economy</option><option value="option">Options</option></select></label><input class="search-in" id="symQ" placeholder="Ticker, company, currency pair, contract…" autocomplete="off" value="${esc(initial)}" style="flex:1"></div><div class="list" id="symList"></div><div class="hint-text" style="margin-top:8px">Search results come from the connected public feeds. Stock, fund, futures, forex, crypto, index, bond and option availability depends on the symbol source; options and economic series may have limited public coverage.</div>`,
    );
    const q = card.querySelector("#symQ"),
      list = card.querySelector("#symList"), typeSelect = card.querySelector("#symType");
    let sel = 0,
      results = [],
      timer;
    const pick = (sym) => {
      this.closeModal();
      if (onPick) onPick(sym);
      else this.setSymbol(sym);
    };
    const draw = () => {
      const category = typeSelect.value;
      const visible = visibleResults();
      list.innerHTML =
        visible
          .map(
            (r, i) =>
              `<div class="item ${i === sel ? "sel" : ""}" data-i="${results.indexOf(r)}"><span><b>${esc(ticker(r.symbol))}</b> <span class="muted">${esc(r.name || "")}</span></span><span class="meta">${esc(formatSymbolType(r.type))} · ${esc(displayExchange(r.symbol, r.exchange))}</span></div>`,
          )
          .join("") ||
        (q.value.trim()
          ? `<div class="item" data-raw="1"><span>Open <b>${esc(q.value.trim().toUpperCase())}</b></span><span class="meta">press Enter</span></div>`
          : "");
    };
    const visibleResults = () => results.filter((r) => typeSelect.value === "all" || normalizeSymbolType(r.type) === typeSelect.value);
    const run = async () => {
      const v = q.value.trim();
      if (!v) {
        results = [];
        draw();
        return;
      }
      try {
        results = await api.search(v);
      } catch {
        results = [];
      }
      if (q.value.trim() === v) {
        sel = 0;
        draw();
      }
    };
    q.oninput = () => {
      clearTimeout(timer);
      timer = setTimeout(run, 180);
    };
    typeSelect.onchange = () => {
      sel = 0;
      if (typeSelect.value === "economy" && !q.value.trim()) { q.value = "economy"; run(); }
      else draw();
    };
    q.onkeydown = (e) => {
      if (e.key === "ArrowDown") {
        sel = Math.min(sel + 1, visibleResults().length - 1);
        draw();
        e.preventDefault();
      }
      if (e.key === "ArrowUp") {
        sel = Math.max(sel - 1, 0);
        draw();
        e.preventDefault();
      }
      if (e.key === "Enter") pick(visibleResults()[sel]?.symbol || q.value.trim());
    };
    list.onclick = (e) => {
      const it = e.target.closest(".item");
      if (!it) return;
      pick(
        it.dataset.raw ? q.value.trim() : results[Number(it.dataset.i)].symbol,
      );
    };
    q.focus();
    q.setSelectionRange(q.value.length, q.value.length);
    if (initial) run();
  }

  openAddSymbolSearch(onAdd, isAdded = () => false) {
    const categories = ["All", "Stocks", "Funds", "Futures", "Forex", "Crypto", "Indices", "Bonds", "Economy", "Options"];
    const categoryKey = (label) => label === "All" ? "all" : ({ Stocks:"stock", Funds:"fund", Futures:"futures", Forex:"forex", Crypto:"crypto", Indices:"index", Bonds:"bond", Economy:"economy", Options:"option" })[label];
    const card = this.modal("Add symbol", `<input class="search-in add-symbol-query" id="addSymQ" placeholder="Search symbol, name, or identifier…" autocomplete="off"><div class="symbol-categories">${categories.map((c, i) => `<button class="symbol-category ${i === 0 ? "active" : ""}" type="button" data-category="${categoryKey(c)}">${c}</button>`).join("")}</div><div class="symbol-results" id="addSymResults"><div class="symbol-search-empty">Search for a symbol to see matching markets.</div></div><div class="hint-text symbol-search-hint">Choose a result and press ＋ to add it to the selected watchlist.</div>`, { wide: true });
    const q = card.querySelector("#addSymQ"), resultsBox = card.querySelector("#addSymResults");
    let category = "all", results = [], selected = 0, timer, seq = 0;
    const visible = () => results.filter((r) => category === "all" || normalizeSymbolType(r.type) === category);
    const draw = () => {
      const rows = visible();
      resultsBox.innerHTML = rows.map((r, i) => {
        const added = isAdded(r.symbol);
        return `<div class="add-symbol-result ${i === selected ? "selected" : ""}" data-result="${i}" role="option" aria-selected="${i === selected}">${symbolLogo(r)}<span class="add-symbol-ticker">${esc(ticker(r.symbol))}</span><span class="add-symbol-name">${esc(r.name || "")}</span><span class="add-symbol-meta">${esc(formatSymbolType(r.type))} · ${esc(displayExchange(r.symbol, r.exchange))}</span><button type="button" class="add-symbol-action ${added ? "added" : ""}" data-add="${i}" ${added ? "disabled" : ""} title="${added ? "Already on watchlist" : "Add symbol"}">${added ? "✓" : "＋"}</button></div>`;
      }).join("") || `<div class="symbol-search-empty">${q.value.trim() ? "No matches for this category. Try another category or search term." : "Search for a symbol to see matching markets."}</div>`;
    };
    const run = async () => {
      const term = q.value.trim();
      const request = ++seq;
      if (!term) { results = []; selected = 0; draw(); return; }
      resultsBox.innerHTML = `<div class="symbol-search-empty">Searching…</div>`;
      try { results = await api.search(term, category); } catch { results = []; }
      if (request !== seq || q.value.trim() !== term) return;
      selected = 0;
      draw();
    };
    q.oninput = () => { clearTimeout(timer); timer = setTimeout(run, 180); };
    card.querySelector(".symbol-categories").onclick = (e) => {
      const button = e.target.closest("[data-category]");
      if (!button) return;
      category = button.dataset.category;
      selected = 0;
      card.querySelectorAll(".symbol-category").forEach((b) => b.classList.toggle("active", b === button));
      if (category === "economy" && !q.value.trim()) q.value = "economy";
      if (q.value.trim()) run(); else draw();
    };
    const addResult = async (index, button) => {
      const row = visible()[index];
      if (!row || isAdded(row.symbol) || button?.disabled) return;
      if (button) { button.disabled = true; button.textContent = "…"; }
      await onAdd(row.symbol);
      draw();
    };
    resultsBox.onclick = async (e) => {
      const result = e.target.closest("[data-result]");
      if (!result) return;
      const button = e.target.closest("[data-add]") || result.querySelector("[data-add]");
      await addResult(Number(result.dataset.result), button);
    };
    q.onkeydown = async (e) => {
      const rows = visible();
      if (e.key === "ArrowDown" && rows.length) { selected = Math.min(selected + 1, rows.length - 1); draw(); e.preventDefault(); }
      if (e.key === "ArrowUp" && rows.length) { selected = Math.max(selected - 1, 0); draw(); e.preventDefault(); }
      if (e.key === "Enter" && rows[selected]) { await addResult(selected, resultsBox.querySelector(`[data-add="${selected}"]`)); e.preventDefault(); }
    };
    q.focus();
  }

  openIndicatorPicker() {
    const card = this.modal(
      "Indicators",
      `<div class="row-flex"><input class="search-in" id="indQ" placeholder="Search ${INDICATORS.length} indicators…" autocomplete="off" style="flex:1"><select class="in" id="indCategory"><option value="">All categories</option>${[...new Set(INDICATORS.map(d => d.group || "Other"))].sort().map(g => `<option>${esc(g)}</option>`).join("")}</select><label class="tb check"><input type="checkbox" id="indFavOnly"> Favorites</label></div><div class="list" id="indList"></div>`,
      {
        foot: '<span class="hint-text" style="margin-right:auto">No limit per chart. Write your own in the Indicator editor tab.</span><button class="btn" data-new>New custom indicator</button>',
      },
    );
    const q = card.querySelector("#indQ"),
      list = card.querySelector("#indList");
    const category = card.querySelector("#indCategory"), favOnly = card.querySelector("#indFavOnly");
    this.state.indicatorFavorites ||= [];
    const draw = () => {
      const term = q.value.trim().toLowerCase();
      const groups = {};
      for (const d of INDICATORS) {
        const group = d.group || "Other";
        const favorite = this.state.indicatorFavorites.includes(d.id);
        if (category.value && group !== category.value) continue;
        if (favOnly.checked && !favorite) continue;
        if (
          term &&
          !`${d.name} ${d.id} ${group}`.toLowerCase().includes(term)
        )
          continue;
        (groups[group] ||= []).push(d);
      }
      list.innerHTML = Object.entries(groups)
        .sort(([g1], [g2]) => (g2 === "Quant (bonus)") - (g1 === "Quant (bonus)"))
        .map(
          ([g, ds]) =>
            `<div class="group">${esc(g)}</div>${ds.map((d) => `<div class="item indicator-result" data-id="${esc(d.id)}"><span><button class="indicator-star ${this.state.indicatorFavorites.includes(d.id) ? "on" : ""}" data-fav="${esc(d.id)}" title="Toggle favorite">${this.state.indicatorFavorites.includes(d.id) ? "★" : "☆"}</button> ${esc(d.name)}</span><span class="meta">${d.overlay ? "on price" : "own pane"}</span></div>`).join("")}`,
        )
        .join("") || '<div class="hint-text pad">No indicators match these filters.</div>';
    };
    q.oninput = draw;
    category.onchange = draw;
    favOnly.onchange = draw;
    list.onclick = (e) => {
      const star = e.target.closest("[data-fav]");
      if (star) {
        const id = star.dataset.fav;
        this.state.indicatorFavorites = this.state.indicatorFavorites.includes(id)
          ? this.state.indicatorFavorites.filter((x) => x !== id)
          : [...this.state.indicatorFavorites, id];
        this.persist();
        draw();
        e.stopPropagation();
        return;
      }
      const it = e.target.closest("[data-id]");
      if (!it) return;
      const uid = this.active.addIndicator(it.dataset.id);
      const anchor = (BY_ID[it.dataset.id].inputs || []).find((i) => i.type === "time");
      if (anchor) {
        this.closeModal();
        this.pickAnchor(this.active, uid, anchor.key);
      } else this.toast(`Added ${BY_ID[it.dataset.id].name}`);
    };
    card.querySelector("[data-new]").onclick = () => {
      this.closeModal();
      this.panels.showBottom("editor");
    };
    draw();
    q.focus();
  }

  /** Wait for a click on the chart and anchor indicator `uid` there (Anchored VWAP). Escape keeps the current anchor. */
  pickAnchor(pane, uid, key) {
    this.pendingAnchor = { pane, uid, key };
    this.setTool("anchor-pick");
    this.toast("Click the bar to anchor it to.");
  }

  openIndicatorSettings(pane, ind) {
    const def = BY_ID[ind.id];
    const fields = (def.inputs || [])
      .map((i) => {
        const v = ind.params?.[i.key] ?? i.default;
        if (i.type === "source") {
          // Indicators on indicators: any output of another indicator on this chart can be the source.
          const others = pane.cfg.indicators
            .filter((x) => x.uid !== ind.uid && !String(x.params?.source || "").includes(ind.uid) && BY_ID[x.id]?.outputs.length)
            .flatMap((x) => BY_ID[x.id].outputs.map((o) => [`ind:${x.uid}:${o.key}`, `${(/\(([^)]+)\)$/.exec(BY_ID[x.id].name)?.[1].split(" / ")[0] || BY_ID[x.id].name)} ${pane.indicatorParamsLabel(x)}: ${o.label}`]));
          const price = ["close", "open", "high", "low", "hl2", "hlc3", "ohlc4", "hlcc4"].map((s) => `<option ${s === v ? "selected" : ""}>${s}</option>`).join("");
          const inds = others.map(([val, label]) => `<option value="${esc(val)}" ${val === v ? "selected" : ""}>${esc(label)}</option>`).join("");
          return `<label class="field">${esc(i.label)}<select data-k="${i.key}"><optgroup label="Price">${price}</optgroup>${inds ? `<optgroup label="Another indicator">${inds}</optgroup>` : ""}</select></label>`;
        }
        if (i.type === "select")
          return `<label class="field">${esc(i.label)}<select data-k="${i.key}">${i.options.map((s) => `<option ${s === v ? "selected" : ""}>${s}</option>`).join("")}</select></label>`;
        if (i.type === "time") {
          const local = v ? new Date((v - new Date(v * 1000).getTimezoneOffset() * 60) * 1000).toISOString().slice(0, 16) : "";
          return `<label class="field">${esc(i.label)}<input data-k="${i.key}" data-type="time" type="datetime-local" value="${local}"><button class="btn small" type="button" data-pick="${i.key}">Pick on chart</button></label>`;
        }
        return `<label class="field">${esc(i.label)}<input data-k="${i.key}" data-type="${i.type}" type="number" step="${i.type === "int" ? 1 : "any"}" ${Number.isFinite(i.min) ? `min="${i.min}"` : ""} ${Number.isFinite(i.max) ? `max="${i.max}"` : ""} value="${v}"></label>`;
      })
      .join("");
    const colors = def.outputs
      .map(
        (o) =>
          `<label class="field">${esc(o.label)}<input data-c="${o.key}" type="color" value="${(ind.colors?.[o.key] || o.color).slice(0, 7)}"></label>`,
      )
      .join("");
    const card = this.modal(
      def.name,
      `<div class="form-grid">${fields || '<span class="hint-text">No inputs.</span>'}<label class="field">Timeframe<select data-tf>${["", "5m", "15m", "1h", "4h", "1D", "1W", "1M"].map((t) => `<option value="${t}" ${(ind.tf || "") === t ? "selected" : ""}>${t || `Same as chart (${pane.cfg.tf})`}</option>`).join("")}</select></label></div><p class="hint-text">A higher timeframe shows its value once each of its bars has closed, so history never peeks ahead.</p>${colors ? `<h4>Colours</h4><div class="form-grid">${colors}</div>` : ""}`,
      {
        foot: '<button class="btn" data-reset>Defaults</button><button class="btn primary" data-ok>Apply</button>',
      },
    );
    card.querySelector("[data-ok]").onclick = () => {
      ind.params = {};
      card.querySelectorAll("[data-k]").forEach((el) => {
        ind.params[el.dataset.k] =
          el.dataset.type === "time"
            ? el.value
              ? Math.floor(new Date(el.value).getTime() / 1000)
              : 0
            : el.dataset.type
              ? Number(el.value)
              : el.value;
      });
      ind.colors = {};
      card.querySelectorAll("[data-c]").forEach((el) => {
        ind.colors[el.dataset.c] = el.value;
      });
      ind.tf = card.querySelector("[data-tf]").value || undefined;
      this.closeModal();
      pane.render(false);
      this.persist();
    };
    card.querySelectorAll("[data-pick]").forEach((b) => {
      b.onclick = () => {
        this.closeModal();
        this.pickAnchor(pane, ind.uid, b.dataset.pick);
      };
    });
    card.querySelector("[data-reset]").onclick = () => {
      ind.params = {};
      ind.colors = {};
      this.closeModal();
      pane.render(false);
      this.persist();
    };
  }

  openTemplates() {
    const card = this.modal(
      "Chart templates",
      '<div class="row-flex"><input class="in" id="templateName" placeholder="Template name" style="flex:1"><button class="btn primary" id="templateSave">Save current setup</button></div><div class="pad" id="templateList"></div><p class="hint-text">Templates save the chart layout, symbols, timeframes, chart types, comparisons and indicators in your local data folder.</p>',
      { wide: true },
    );
    const list = card.querySelector("#templateList");
    const draw = () => {
      list.innerHTML = (this.state.templates || []).map((t, i) =>
        `<div class="card row-flex"><b>${esc(t.name)}</b><span class="spacer"></span><button class="btn small" data-load="${i}">Load</button><button class="btn small danger" data-delete="${i}">Delete</button></div>`,
      ).join("") || '<p class="hint-text">No saved templates yet.</p>';
    };
    draw();
    card.querySelector("#templateSave").onclick = () => {
      const name = card.querySelector("#templateName").value.trim();
      if (!name) return this.toast("Enter a name for this template.", "err");
      const template = {
        name,
        layout: this.state.layout,
        panes: this.panes.map((p) => structuredClone(p.cfg)),
        settings: structuredClone(this.settings),
        chartSettingsDefault: structuredClone(this.state.chartSettingsDefault || {}),
      };
      this.state.templates = (this.state.templates || []).filter((t) => t.name !== name);
      this.state.templates.push(template);
      this.persist();
      card.querySelector("#templateName").value = "";
      draw();
    };
    list.onclick = (e) => {
      const load = e.target.closest("[data-load]");
      const del = e.target.closest("[data-delete]");
      if (del) {
        this.state.templates.splice(Number(del.dataset.delete), 1);
        this.persist();
        draw();
      }
      if (load) {
        const template = this.state.templates[Number(load.dataset.load)];
        if (!template) return;
        this.panes.forEach((p) => p.destroy());
        this.panes = [];
        $("#grid").innerHTML = "";
        this.state.panes = structuredClone(template.panes);
        this.state.layout = template.layout;
        this.state.active = 0;
        Object.assign(this.settings, template.settings || {});
        this.state.chartSettingsDefault = structuredClone(template.chartSettingsDefault || this.state.chartSettingsDefault || {});
        $("#syncTf").checked = !!this.settings.syncTf;
        $("#crosshairSync").checked = !!this.settings.syncCrosshair;
        this.closeModal();
        this.setLayout(this.state.layout, false);
        this.persist();
      }
    };
  }

  openSettings() {
    return this.openChartSettings(this.active);
  }

  openChartSettings(pane = this.active) {
    if (!pane) return;
    const prior = structuredClone(pane.cfg.chartSettings || {}), priorType = pane.cfg.type, priorScale = pane.cfg.scale, priorLog = pane.cfg.log;
    const priorRange = pane.chart.timeScale().getVisibleLogicalRange(), priorDefault = structuredClone(this.state.chartSettingsDefault || {});
    const priorIndicators = structuredClone(pane.cfg.indicators);
    const base = { chartType: "candles", precision: "default", timezone: "Asia/Kolkata", themePreset: "auto", upColor: "#0EC7A3", downColor: "#CC3958", upBorder: "#0EC7A3", downBorder: "#CC3958", upWick: "#0EC7A3", downWick: "#CC3958", upBody: true, downBody: true, upBorderVisible: true, downBorderVisible: true, upWickVisible: true, downWickVisible: true, colorBarsPreviousClose: false, statusLogo: true, statusTitle: true, statusTitleFormat: "name", statusMarket: false, statusOhlc: true, statusChange: true, statusVolume: true, statusLastDay: true, statusIndTitles: true, statusIndArguments: true, statusIndValues: true, statusIndBackground: true, statusIndOpacity: 85, scaleMode: "normal", scalePlacement: "right", scaleAuto: true, scaleInvert: false, scaleLockRatio: false, labelSymbol: true, labelLastPrice: true, labelPreviousClose: false, labelIndicators: true, labelValues: true, previousDayLines: false, previousCloseColor: "#087f68", highLowLines: false, highLowColor: "#087f68", averagePriceLine: false, averagePriceColor: "#087f68", backgroundMode: "solid", backgroundColor: "#10151b", backgroundBottom: "#171e27", canvasGrid: true, verticalGrid: true, horizontalGrid: true, gridColor: "#303c49", gridVStyle: "solid", gridHStyle: "solid", crosshairMode: "normal", crosshairColor: "#96a3b2", scaleFontColor: "#e5ebf2", scaleFontSize: 11, scaleLineColor: "#303c49", paneSeparatorColor: "#303c49", watermarkMode: "off", watermarkColor: "#8995a3", watermarkOpacity: 16, navigationButtons: "hover", paneButtons: "hover", marginTop: 8, marginBottom: 8, rightOffset: 8, tradeButtons: false, lastPriceLine: "solid", lastPriceLineWidth: 1, lastLineColor: "#087f68", alertLines: true, alertOnlyActive: true, alertLineColor: "#1cae9b", alertSound: true, alertVolume: 55, alertAutoHide: true, eventIdeas: false, eventDividends: true, eventSplits: true, eventEarnings: true, eventEarningsBreaks: false, eventSessionBreaks: true, eventSessionColor: "#4b87e8", eventSessionStyle: "dashed", eventLatestNews: true, eventNewsNotification: false, eventEconomic: false, eventEconomicImportance: "all" };
    let draft = { ...base, ...(this.state.chartSettingsDefault || {}), scaleMode: priorScale === "percentage" ? "percent" : priorScale || "normal", ...prior };
    const row = (label, control) => `<div class="settings-row"><span class="settings-label">${esc(label)}</span><span class="settings-control">${control}</span></div>`;
    const pick = (key, label, options) => row(label, `<select data-cs="${key}" aria-label="${esc(label)}">${options.map(([v,t])=>`<option value="${v}" ${String(draft[key])===String(v)?"selected":""}>${esc(t)}</option>`).join("")}</select>`);
    const check = (key, label) => row(label, `<input type="checkbox" data-cs="${key}" aria-label="${esc(label)}" ${draft[key]?"checked":""}>`);
    const color = (key, label, fallback) => row(label, `<input class="color-swatch" type="color" data-cs="${key}" aria-label="${esc(label)}" value="${draft[key] || fallback}">`);
    const candleGroup = (label, upColor, downColor, upVisible, downVisible, upFallback, downFallback) => row(label, `<span class="candle-pair"><span>Up</span><input class="color-swatch" type="color" data-cs="${upColor}" aria-label="${label} Up color" value="${draft[upColor] || upFallback}"><input type="checkbox" data-cs="${upVisible}" aria-label="${label} Up" title="${label} Up" ${draft[upVisible] ? "checked" : ""}><span>Down</span><input class="color-swatch" type="color" data-cs="${downColor}" aria-label="${label} Down color" value="${draft[downColor] || downFallback}"><input type="checkbox" data-cs="${downVisible}" aria-label="${label} Down" title="${label} Down" ${draft[downVisible] ? "checked" : ""}></span>`);
    const num = (key, label, value, min, max, step = 1) => row(label, `<input type="number" data-cs="${key}" aria-label="${esc(label)}" value="${draft[key] ?? value}" min="${min}" max="${max}" step="${step}">`);
    const range = (key, label, value) => row(label, `<input type="range" data-cs="${key}" aria-label="${esc(label)}" value="${draft[key] ?? value}" min="0" max="100"><output data-range-value="${key}">${draft[key] ?? value}%</output>`);
    const section = (title, html) => `<h3 class="settings-heading">${esc(title)}</h3>${html}`;
    const tabs = ["Symbol", "Status line", "Scales and lines", "Canvas", "Trading", "Alerts", "Events"];
    const contents = {
      "Symbol": `<div class="settings-section">${section("Style",pick("chartType","Chart type",CHART_TYPES))}${check("colorBarsPreviousClose","Color bars based on previous close")}${candleGroup("Body","upColor","downColor","upBody","downBody","#39ff14","#f23645")}${candleGroup("Borders","upBorder","downBorder","upBorderVisible","downBorderVisible","#39ff14","#f23645")}${candleGroup("Wick","upWick","downWick","upWickVisible","downWickVisible","#39ff14","#f23645")}${section("Data modification",`${pick("precision","Precision",[["default","Default"],...Array.from({length:9},(_,i)=>[i,String(i)])])}${pick("timezone","Timezone",[["exchange","Exchange"],["Asia/Kolkata","Asia/Kolkata"],["local","Computer local time"],["UTC","UTC"],["America/New_York","New York"],["Europe/London","London"],["Asia/Tokyo","Tokyo"],["Australia/Sydney","Sydney"]])}`)}<p class="hint-text">Session selection and dividend adjustment require adjusted or extended-hours data from the selected market-data source.</p></div>`,
      "Status line": `<div class="settings-section">${section("Instrument",[check("statusLogo","Logo"),row("Title",`<span class="status-title-control"><input type="checkbox" data-cs="statusTitle" aria-label="Title" ${draft.statusTitle?"checked":""}><select data-cs="statusTitleFormat" aria-label="Title format"><option value="name" ${draft.statusTitleFormat==="name"?"selected":""}>Name</option><option value="ticker" ${draft.statusTitleFormat==="ticker"?"selected":""}>Ticker</option><option value="ticker-description" ${draft.statusTitleFormat==="ticker-description"?"selected":""}>Ticker and description</option></select></span>`),check("statusOhlc","Chart values"),check("statusChange","Bar change values"),check("statusVolume","Volume"),check("statusLastDay","Last day change values"),check("tradeButtons","Buy/sell buttons"),`<p class="settings-note">Displays buy and sell buttons directly on the chart.</p>`,check("statusMarket","Open market status")].join(""))}${section("Indicators",[check("statusIndTitles","Titles"),row("Inputs",`<input type="checkbox" data-cs="statusIndArguments" aria-label="Inputs" ${draft.statusIndArguments?"checked":""}>`),check("statusIndValues","Values"),row("Background",`<span class="status-background-control"><input type="checkbox" data-cs="statusIndBackground" aria-label="Background" ${draft.statusIndBackground?"checked":""}><input type="range" data-cs="statusIndOpacity" aria-label="Background opacity" value="${draft.statusIndOpacity}" min="0" max="100"><output data-range-value="statusIndOpacity">${draft.statusIndOpacity}%</output></span>`)].join(""))}</div>`,
      "Scales and lines": `<div class="settings-section">${section("Scale modes",`${pick("scaleMode","Scale modes",[["normal","Auto"],["log","Log"],["percent","Percent"],["indexed","Indexed to 100"]])}${check("scaleInvert","Invert scale")}${check("scaleLockRatio","Lock price to bar ratio")}`)}${section("Scales placement",pick("scalePlacement","Scales placement",[["auto","Auto"],["left","Left"],["right","Right"]]))}${section("Labels",`${check("labelSymbol","Symbol name label")}${check("labelLastPrice","Symbol last price label")}${check("labelPreviousClose","Symbol previous close label")}${check("labelIndicators","Indicators and financials name labels")}${check("labelValues","Indicators and financials value labels")}`)}${section("Lines",`${pick("lastPriceLine","Last-price line",[["solid","Solid"],["dashed","Dashed"],["dotted","Dotted"],["hidden","Hidden"]])}${color("lastLineColor","Last-price line color","#39ff14")}${num("lastPriceLineWidth","Last-price line width",1,1,4)}${check("previousDayLines","Previous day close price")}${color("previousCloseColor","Previous close color","#087f68")}${check("highLowLines","High and low of visible range")}${color("highLowColor","High and low line color","#087f68")}${check("averagePriceLine","Average close price")}${color("averagePriceColor","Average close price color","#087f68")}`)}<p class="hint-text">Bid and ask and pre/post-market lines need quote/session data that this data feed does not provide. Countdown and axis hover buttons are not supported by the chart engine.</p></div>`,
      "Canvas": `<div class="settings-section">${section("Background",`${pick("themePreset","Theme",[["auto","Follow app theme"],["light","Light"],["dark","Dark"],["custom","Custom"]])}${pick("backgroundMode","Background",[["solid","Solid"],["gradient","Gradient"]])}${color("backgroundColor","Background color","#10151b")}${color("backgroundBottom","Gradient bottom","#171e27")}`)}${section("Grid lines",`${check("canvasGrid","Grid lines")}${check("verticalGrid","Vertical")}${pick("gridVStyle","Vertical line type",[["solid","Solid"],["dashed","Dashed"],["dotted","Dotted"],["none","None"]])}${color("gridVColor","Vertical line color","#303c49")}${check("horizontalGrid","Horizontal")}${pick("gridHStyle","Horizontal line type",[["solid","Solid"],["dashed","Dashed"],["dotted","Dotted"],["none","None"]])}${color("gridHColor","Horizontal line color","#303c49")}`)}${section("Crosshair",`${pick("crosshairMode","Crosshair",[["normal","Normal"],["magnet","Magnet"]])}${color("crosshairColor","Crosshair color","#96a3b2")}`)}${section("Watermark",`${pick("watermarkMode","Watermark",[["off","Off"],["symbol","Symbol"],["symbol-timeframe","Symbol and timeframe"]])}${color("watermarkColor","Watermark color","#8995a3")}${range("watermarkOpacity","Watermark opacity",16)}`)}${section("Scales text",`${color("scaleFontColor","Scales text color","#e5ebf2")}${num("scaleFontSize","Scales text size",11,8,24)}`)}${section("Scales lines",`${color("scaleLineColor","Scales lines color","#303c49")}${color("paneSeparatorColor","Pane separators color","#303c49")}`)}${section("Navigation buttons",pick("navigationButtons","Navigation buttons",[["hover","On hover"],["always","Always"],["never","Never"]]))}${section("Pane buttons",pick("paneButtons","Pane buttons",[["hover","On hover"],["always","Always"],["never","Never"]]))}${section("Margins",`${num("marginTop","Top",8,0,40)}${num("marginBottom","Bottom",8,0,40)}${num("rightOffset","Right",8,0,100)}`)}</div>`,
      "Trading": `<div class="settings-section">${section("Trading","<p class=\"hint-text\">Buy/sell buttons are controlled from Status line. Positions, Orders, Executions, Reverse position button, Profit and loss and Bracket orders are not available in this chart view.</p>")}</div>`,
      "Alerts": `<div class="settings-section">${section("CHART LINE VISIBILITY",`${row("Alert lines",`<input type="checkbox" data-cs="alertLines" aria-label="Alert lines" ${draft.alertLines?"checked":""}><input class="color-swatch" type="color" data-cs="alertLineColor" aria-label="Alert line color" value="${draft.alertLineColor}">`)}${check("alertOnlyActive","Only active alerts")}`)}${section("NOTIFICATIONS",`${row("Alert volume",`<input type="checkbox" data-cs="alertSound" aria-label="Alert volume" ${draft.alertSound?"checked":""}><span class="alert-volume-control"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4zm12.5-1.5a6 6 0 0 1 0 9M15 10a3 3 0 0 1 0 4"/></svg><input type="range" data-cs="alertVolume" aria-label="Alert volume level" min="0" max="100" value="${draft.alertVolume}"></span>`)}${check("alertAutoHide","Automatically hide toasts")}`)}</div>`,
      "Events": `<div class="settings-section">${section("Events",`${row("Ideas",`<input type="checkbox" disabled aria-label="Ideas"><select disabled aria-label="Ideas filter"><option>All ideas</option></select>`)}<p class="hint-text">Ideas are not available because this app has no ideas feed.</p>${check("eventDividends","Dividends")}${check("eventSplits","Splits")}${check("eventEarnings","Earnings")}${check("eventEarningsBreaks","Earnings breaks")}${row("Session breaks",`<input type="checkbox" data-cs="eventSessionBreaks" aria-label="Session breaks" ${draft.eventSessionBreaks?"checked":""}><input class="color-swatch" type="color" data-cs="eventSessionColor" aria-label="Session breaks color" value="${draft.eventSessionColor}"><select data-cs="eventSessionStyle" aria-label="Session breaks style"><option value="solid" ${draft.eventSessionStyle==="solid"?"selected":""}>Solid</option><option value="dashed" ${draft.eventSessionStyle==="dashed"?"selected":""}>Dashed</option><option value="dotted" ${draft.eventSessionStyle==="dotted"?"selected":""}>Dotted</option></select>`)}${check("eventLatestNews","Latest news")}${check("eventNewsNotification","News notification")}${check("eventEconomic","Economic events")}${pick("eventEconomicImportance","Importance",[["all","All"],["high","High"],["medium","Medium"],["low","Low"]])}`)}</div>`,
    };
    const body = `<div class="chart-settings"><nav class="chart-settings-tabs" aria-label="Chart settings">${tabs.map((t,i)=>`<button type="button" data-settings-tab="${esc(t)}" class="${i===0?"active":""}">${esc(t)}</button>`).join("")}</nav><div class="chart-settings-pages">${tabs.map((t,i)=>`<section data-settings-page="${esc(t)}" class="${i===0?"active":""}">${contents[t]}</section>`).join("")}</div></div>`;
    const foot = `<select id="settingsTemplate" class="in" aria-label="Template"><option value="">Template</option><option value="save">Save as default</option><option value="reset">Reset settings</option></select><span class="spacer"></span><button class="btn" data-cancel>Cancel</button><button class="btn primary" data-ok>Ok</button>`;
    const card = this.modal("Chart Settings", body, { wide: true, foot });
    card.classList.add("chart-settings-card");
    pane._settingsPreview = true;
    const tabsBox = card.querySelector(".chart-settings-tabs");
    const showTab = (name) => {
      tabsBox.querySelectorAll("[data-settings-tab]").forEach((b) => b.classList.toggle("active", b.dataset.settingsTab === name));
      card.querySelectorAll("[data-settings-page]").forEach((p) => p.classList.toggle("active", p.dataset.settingsPage === name));
    };
    tabsBox.onclick = (e) => { const b=e.target.closest("[data-settings-tab]"); if(b) showTab(b.dataset.settingsTab); };
    let frame = 0;
    const applyLive = () => {
      pane.cfg.chartSettings = structuredClone(draft);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { pane.applyChartSettings(); });
    };
    const updateControls = () => card.querySelectorAll("[data-cs]").forEach((el) => {
      const key=el.dataset.cs, value=draft[key];
      if (el.type === "checkbox") el.checked = !!value;
      else if (value != null) el.value = value;
      const output=card.querySelector(`[data-range-value="${key}"]`); if(output) output.textContent=`${value ?? el.value}%`;
    });
    card.querySelectorAll("[data-cs]").forEach((el) => el.addEventListener("input", () => {
      let value = el.type === "checkbox" ? el.checked : el.type === "number" || el.type === "range" ? Number(el.value) : el.value;
      draft[el.dataset.cs]=value;
      if (el.dataset.cs === "eventNewsNotification" && value && "Notification" in window && Notification.permission === "default") Notification.requestPermission();
      if (["backgroundColor", "backgroundBottom", "gridColor", "gridVColor", "gridHColor", "scaleFontColor", "scaleLineColor", "paneSeparatorColor"].includes(el.dataset.cs)) {
        draft.themePreset = "custom";
        card.querySelector('[data-cs="themePreset"]').value = "custom";
      }
      const output=card.querySelector(`[data-range-value="${el.dataset.cs}"]`); if(output) output.textContent=`${value}%`;
      applyLive();
    }));
    card.querySelector("#settingsTemplate").onchange = (e) => {
      if(e.target.value === "save") { draft.saveAsDefault = true; this.toast("Current settings will become the default when you select Ok."); }
      if(e.target.value === "reset") { draft={...base}; updateControls(); applyLive(); }
      e.target.value="";
    };
    const cancel = () => { if (!this.chartSettingsCancel) return; this.chartSettingsCancel = null; pane._settingsPreview = false; cancelAnimationFrame(frame); pane.cfg.chartSettings=prior; pane.cfg.type=priorType; pane.cfg.scale=priorScale; pane.cfg.log=priorLog; pane.cfg.indicators=priorIndicators; pane.applyChartSettings(); if(priorRange) pane.chart.timeScale().setVisibleLogicalRange(priorRange); this.state.chartSettingsDefault=priorDefault; this.closeModal(); };
    this.chartSettingsCancel = cancel;
    card.querySelector("[data-close]").onclick = cancel;
    $("#modal").onmousedown = (e) => { if (e.target.id === "modal") cancel(); };
    card.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.target.closest("button")) { e.preventDefault(); card.querySelector("[data-ok]").click(); } });
    card.querySelector("[data-cancel]").onclick = cancel;
    card.querySelector("[data-ok]").onclick = () => { this.chartSettingsCancel = null; pane._settingsPreview = false; cancelAnimationFrame(frame); if(draft.saveAsDefault) this.state.chartSettingsDefault=Object.fromEntries(Object.entries(draft).filter(([k])=>k!=="saveAsDefault")); delete draft.saveAsDefault; pane.cfg.chartSettings=structuredClone(draft); this.persist(); this.closeModal(); };
    tabsBox.querySelector("[data-settings-tab]")?.focus();
    return card;
  }

  async openBrokerSettings() {
    let current = { broker: "none", configured: false };
    try { current = await api.get("/api/broker-settings"); } catch { /* server may be updating */ }
    const body = `<p class="hint-text">Optional. This computer sends credentials only to your local Quant Terminal server, which uses them with the selected broker. Credentials are stored in the ignored <code>data/broker.json</code>; they are never displayed again or logged. Realtime access and history limits depend on your broker plan.</p><div class="form-grid"><label class="field">Provider<select id="brProvider"><option value="none">Public data only</option><option value="kite">Zerodha Kite Connect</option><option value="upstox">Upstox</option><option value="angel">Angel One SmartAPI</option><option value="dhan">Dhan</option></select></label><label class="field">API key<input id="brKey" type="password" autocomplete="new-password"></label><label class="field">API secret<input id="brSecret" type="password" autocomplete="new-password"></label><label class="field">Access token<input id="brToken" type="password" autocomplete="new-password"></label><label class="field">Client ID (Angel/Dhan)<input id="brClient" type="password" autocomplete="new-password"></label><label class="field">Client secret (optional)<input id="brClientSecret" type="password" autocomplete="new-password"></label><label class="field">Angel JWT token (if using Angel)<input id="brJwt" type="password" autocomplete="new-password"></label></div><label class="field">Instrument mappings (JSON)<textarea class="in" id="brMap" rows="5" placeholder='{"RELIANCE.NS":{"instrumentToken":"738561","exchange":"NSE","tradingsymbol":"RELIANCE"}}'></textarea></label><p class="hint-text">Kite: instrumentToken, exchange, tradingsymbol. Upstox: instrumentKey. Angel: exchange, symbolToken, tradingsymbol. Dhan: securityId, exchangeSegment, instrument. Key each mapping by the chart symbol, such as RELIANCE.NS. Use your broker’s current instrument master to find IDs.</p><p class="hint-text">Current: ${current.configured ? `${esc(current.broker)} configured; ${current.instrumentMappings} symbol mappings` : "no credentials configured"}. Leave credential boxes blank to keep saved values.</p>`;
    const modal = this.modal("Broker data provider", body, { wide: true, foot: '<button class="btn danger" id="brClear">Remove credentials</button><button class="btn primary" id="brSave">Save on this computer</button>' });
    modal.querySelector("#brProvider").value = current.broker || "none";
    modal.querySelector("#brSave").onclick = async () => {
      try {
        let instruments;
        if (modal.querySelector("#brMap").value.trim()) instruments = JSON.parse(modal.querySelector("#brMap").value);
        const response = await api.put("/api/broker-settings", { broker: modal.querySelector("#brProvider").value, apiKey: modal.querySelector("#brKey").value, apiSecret: modal.querySelector("#brSecret").value, accessToken: modal.querySelector("#brToken").value, clientId: modal.querySelector("#brClient").value, clientSecret: modal.querySelector("#brClientSecret").value, jwtToken: modal.querySelector("#brJwt").value, ...(instruments ? { instruments } : {}) });
        this.closeModal();
        this.toast(response.configured ? `${response.broker} saved locally (${response.instrumentMappings} mappings).` : "Public market data selected.");
        this.panes.forEach((p) => p.load({ keepView: true }));
      } catch (e) { this.toast(e.message, "err"); }
    };
    modal.querySelector("#brClear").onclick = async () => {
      try { await api.put("/api/broker-settings", { broker: "none", clear: true }); this.closeModal(); this.toast("Broker credentials removed."); } catch (e) { this.toast(e.message, "err"); }
    };
  }

  syncCrosshair(src, p) {
    const utc = src.timeOfLogical(p.logical);
    for (const pane of this.panes) {
      if (pane === src || !pane.shown.length) continue;
      const l = pane.logicalOf(utc);
      const i = Math.max(0, Math.min(pane.shown.length - 1, Math.round(l)));
      const b = pane.shown[i];
      if (b) pane.chart.setCrosshairPosition(b.close, pane.times[i], pane.main);
    }
  }

  exportCsv() {
    const p = this.active;
    const extra = {};
    for (const ind of p.cfg.indicators) {
      const def = BY_ID[ind.id];
      const res = p.indResults[ind.uid] || {};
      for (const o of def?.outputs || [])
        if (Array.isArray(res[o.key])) extra[`${ind.id}_${o.key}`] = res[o.key];
    }
    download(`${ticker(p.cfg.symbol)}-${p.cfg.tf}.csv`, toCsv(p.shown, extra));
  }

  // ---------- keys ----------
  bindKeys() {
    document.addEventListener("keydown", (e) => {
      const typing = /INPUT|TEXTAREA|SELECT/.test(
        document.activeElement?.tagName,
      );
      if (e.key === "Escape") {
        if (!$("#modal").classList.contains("hidden")) return this.chartSettingsCancel ? this.chartSettingsCancel() : this.closeModal();
        if (this.tool !== "cursor") return this.setTool("cursor");
        if (this.active?.drawings.selected) {
          this.active.drawings.selected = null;
          this.active.drawings.update();
        }
        return;
      }
      if (e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        return this.openChartSettings(this.active);
      }
      if (e.altKey && e.key.toLowerCase() === "r") {
        e.preventDefault();
        return this.active?.navAction("reset");
      }
      if (e.altKey && e.key.toLowerCase() === "g") {
        e.preventDefault();
        return this.active?.openGoToDate();
      }
      if ((e.ctrlKey || e.metaKey) && !typing && $("#modal").classList.contains("hidden")) {
        const key = e.key.toLowerCase();
        if (key === "z") {
          e.preventDefault();
          return e.shiftKey ? this.active?.redoDrawing() : this.active?.undoDrawing();
        }
        if (key === "y") {
          e.preventDefault();
          return this.active?.redoDrawing();
        }
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        this.active?.deleteSelectedDrawing()
      ) {
        e.preventDefault();
        return;
      }
      if (!$("#modal").classList.contains("hidden")) return;
      if (this.active && ["+", "=", "-", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        if (e.key === "+" || e.key === "=") this.active.navAction("in");
        else if (e.key === "-") this.active.navAction("out");
        else if (e.key === "ArrowLeft") this.active.navAction("left");
        else if (e.key === "ArrowRight") this.active.navAction("right");
        else if (e.key === "Home") this.active.chart.timeScale().setVisibleLogicalRange({ from: 0, to: Math.min(this.active.shown.length, 160) });
        else this.active.navAction("latest");
        return;
      }
      if (/^[a-z0-9^]$/i.test(e.key)) {
        e.preventDefault();
        this.openSymbolSearch(e.key.toUpperCase());
      }
    });
  }

  // A drawn line as an alert condition: trend lines and rays are checked at the line's price on
  // each bar, on the server, so they fire with this tab closed.
  lineOperandFor(d) {
    const [a, b] = d.points;
    const line = (extend, label) => ({ kind: "line", label, line: { t1: a.time, p1: a.price, t2: b.time, p2: b.price, extend } });
    switch (d.type) {
      case "hline": return { kind: "value", v: Number(a.price.toPrecision(8)) };
      case "hray": return { kind: "line", label: "Horizontal ray", line: { t1: a.time, p1: a.price, t2: a.time + 1, p2: a.price, extend: "right" } };
      case "trend": return line("none", "Trend line (between its two points)");
      case "ray": return line("right", "Ray");
      case "extended": return line("both", "Extended line");
      case "channel": return line("none", "Channel's first line");
      default: return null;
    }
  }

  alertOnSelectedDrawing() {
    const d = this.active?.drawings.selected;
    if (!d) return this.toast("Click a line on the chart first to select it.");
    const right = this.lineOperandFor(d);
    if (!right) return this.toast("Alerts work on trend lines, rays, extended and horizontal lines.");
    this.panels.openAlertDialog({ rules: [{ left: { kind: "price", field: "close" }, op: "crosses", right }] });
  }

  // ---------- replay across charts ----------
  syncReplayFrom(pane, bar) {
    if (!bar) return;
    const end = bar.time + parseTf(pane.cfg.tf).seconds;
    for (const p of this.panes) if (p !== pane && p.bars.length && !(p.replay && !p.replay.follower)) p.replayTo(end);
  }
  onReplayStart(pane) {
    if (this.settings.syncReplay && !pane.replay?.follower) this.syncReplayFrom(pane, pane.bars[pane.replay.index]);
    this.syncToolbar();
    this.panels?.onReplayChange?.();
  }
  onReplayBar(pane, bar) {
    if (this.settings.syncReplay && !pane.replay?.follower) this.syncReplayFrom(pane, bar);
    this.panels?.onReplayBar?.(pane, bar);
  }
  onReplayStop(pane) {
    for (const p of this.panes) if (p !== pane && p.replay?.follower) p.stopReplay();
    this.syncToolbar();
    this.panels?.onReplayChange?.();
  }

  // ---------- prices, alerts, status ----------
  onPrice(symbol, price) {
    this.prices[symbol] = price;
    for (const fn of this.priceListeners) fn(symbol, price);
  }

  listenAlerts() {
    const es = new EventSource("/api/events");
    es.addEventListener("alert", (m) => {
      const e = JSON.parse(m.data);
      const prefs = this.active?.chartSettings?.() || this.state.chartSettingsDefault || {};
      this.toast(`<b>Alert</b><br>${esc(e.text)}`, "alert", prefs.alertAutoHide === false ? 0 : 12000);
      this.beep(prefs);
      if ("Notification" in window && Notification.permission === "granted")
        new Notification("Quant Terminal alert", { body: e.text });
      this.panels?.onAlertFired?.(e);
    });
  }

  beep(prefs = {}) {
    if (prefs.alertSound === false) return;
    const volume = Math.max(0, Math.min(100, Number(prefs.alertVolume ?? 55))) / 100;
    if (!volume) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(),
        g = ctx.createGain();
      o.connect(g);
      g.connect(ctx.destination);
      o.frequency.value = 880;
      g.gain.value = 0.08 * volume;
      o.start();
      o.stop(ctx.currentTime + 0.25);
      o.onended = () => ctx.close();
    } catch {
      /* no audio */
    }
  }

  async checkHealth() {
    try {
      const h = await api.get("/api/health");
      const failing = Object.entries(h.providers || {})
        .filter(([, v]) => !v.ok)
        .map(([k]) => k.replace(/yahoo(?: finance)?/ig, "public market data"));
      this.setStatus(
        failing.length ? "warn" : "ok",
        failing.length
          ? `Some sources are failing (${failing.join(", ")}); fallbacks are in use.`
          : "All data sources responding",
      );
    } catch {
      this.setStatus(
        "bad",
        "The local server is not responding. Is it still running?",
      );
    }
  }
  setStatus(level, title) {
    const el = $("#status");
    el.className = `status ${level}`;
    if (title) el.title = title;
  }

  toast(html, kind = "", ms = 3500) {
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.innerHTML = html;
    if (ms <= 0) {
      const close = document.createElement("button");
      close.className = "toast-close";
      close.type = "button";
      close.setAttribute("aria-label", "Dismiss notification");
      close.textContent = "×";
      close.onclick = () => el.remove();
      el.append(close);
    }
    $("#toasts").appendChild(el);
    if (ms > 0) setTimeout(() => el.remove(), ms);
  }
}

const app = new App();
window.app = app;
app.init().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML(
    "beforeend",
    `<div class="toast err" style="position:fixed;left:20px;bottom:20px">Startup failed: ${esc(e.message)}</div>`,
  );
});
