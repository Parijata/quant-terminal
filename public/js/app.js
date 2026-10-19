import { api, download, esc, ticker, exchange } from "./api.js";
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
  const ex = String(r.exchange || r.symbol.split(":")[0] || "").toUpperCase();
  const type = normalizeSymbolType(r.type);
  const label = ({ NSE:"N", BSE:"B", BINANCE:"₿", COINBASE:"C", KRAKEN:"K", CME:"C", NASDAQ:"N", NYSE:"N", FX:"FX", YAHOO:"Y" })[ex] || (type === "crypto" ? "₿" : type === "forex" ? "$" : type === "index" ? "IDX" : type === "bond" ? "B" : type === "option" ? "O" : "•");
  const color = ({ NSE:"nse", BSE:"bse", BINANCE:"binance", COINBASE:"coinbase", KRAKEN:"kraken", CME:"cme", NASDAQ:"nasdaq", NYSE:"nyse", FX:"fx", YAHOO:"yahoo" })[ex] || type;
  return `<span class="symbol-logo logo-${color}" aria-hidden="true">${label}</span>`;
};
const TF_QUICK = ["1m", "5m", "15m", "1h", "4h", "1D", "1W"];
const LAYOUTS = { 1: 1, "2v": 2, "2h": 2, 4: 4, 6: 6 };
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
    this.drawingColor = "#39ff14";
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
    if (!Object.hasOwn(LAYOUTS, this.state.layout))
      this.state.layout = this.state.layout === "3" ? "4" : ["8", "16"].includes(this.state.layout) ? "6" : "1";
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
    this.state.settings = this.settings;
    this.drawingColor = this.settings.drawingColor;
    document.documentElement.dataset.theme = this.settings.theme;
    await this.loadCustomIndicators();
    this.buildToolbar();
    this.buildDrawbar();
    this.setLayout(this.state.layout, false);
    this.panels = initPanels(this);
    this.bindKeys();
    this.listenAlerts();
    this.checkHealth();
    setInterval(() => this.checkHealth(), 60000);
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
    tfBox.innerHTML = TF_QUICK.map(
      (t) => `<button data-tf="${t}">${t}</button>`,
    ).join("");
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
    bar.innerHTML =
      TOOLS.map(
        (t, i) =>
          `${i === 1 ? "<hr>" : ""}<button data-tool="${t.id}" title="${t.label}"><svg viewBox="0 0 24 24">${t.icon}</svg></button>`,
      ).join("") +
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
      if (b.dataset.tool)
        this.setTool(this.tool === b.dataset.tool ? "cursor" : b.dataset.tool);
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
    this.setTool("cursor");
  }

  setTool(tool) {
    this.tool = tool;
    document
      .querySelectorAll("#drawbar [data-tool]")
      .forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
    for (const p of this.panes) p.setInteractive(tool === "cursor");
    document.body.style.cursor = tool === "cursor" ? "" : "crosshair";
  }

  // ---------- modals ----------
  modal(title, bodyHtml, { foot = "", wide = false } = {}) {
    const card = $("#modalCard");
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
              `<div class="item ${i === sel ? "sel" : ""}" data-i="${results.indexOf(r)}"><span><b>${esc(ticker(r.symbol))}</b> <span class="muted">${esc(r.name || "")}</span></span><span class="meta">${esc(formatSymbolType(r.type))} · ${esc(r.exchange || "")}</span></div>`,
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
        return `<div class="add-symbol-result ${i === selected ? "selected" : ""}" data-result="${i}" role="option" aria-selected="${i === selected}">${symbolLogo(r)}<span class="add-symbol-ticker">${esc(ticker(r.symbol))}</span><span class="add-symbol-name">${esc(r.name || "")}</span><span class="add-symbol-meta">${esc(formatSymbolType(r.type))} · ${esc(r.exchange || "")}</span><button type="button" class="add-symbol-action ${added ? "added" : ""}" data-add="${i}" ${added ? "disabled" : ""} title="${added ? "Already on watchlist" : "Add symbol"}">${added ? "✓" : "＋"}</button></div>`;
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
        settings: { syncCrosshair: this.settings.syncCrosshair, syncTf: this.settings.syncTf },
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
        $("#syncTf").checked = !!this.settings.syncTf;
        $("#crosshairSync").checked = !!this.settings.syncCrosshair;
        this.closeModal();
        this.setLayout(this.state.layout, false);
        this.persist();
      }
    };
  }

  openSettings() {
    const s = this.settings;
    const card = this.modal(
      "Settings",
      `<div class="form-grid">
      <label class="field">Bars to load per chart<input id="sBars" type="number" min="200" max="20000" step="100" value="${s.bars}"></label>
      <label class="field">Time axis<select id="sUtc"><option value="0" ${!s.utc ? "selected" : ""}>My local time</option><option value="1" ${s.utc ? "selected" : ""}>UTC</option></select></label>
      <label class="field">Volume on the price chart<select id="sVol"><option value="1" ${s.volume ? "selected" : ""}>Show</option><option value="0" ${!s.volume ? "selected" : ""}>Hide</option></select></label>
      <label class="field">After placing a drawing<select id="sStay"><option value="0" ${!s.stayInDrawMode ? "selected" : ""}>Back to cursor</option><option value="1" ${s.stayInDrawMode ? "selected" : ""}>Keep the tool</option></select></label>
      <label class="field">Crosshair across charts<select id="sSync"><option value="0" ${!s.syncCrosshair ? "selected" : ""}>Independent</option><option value="1" ${s.syncCrosshair ? "selected" : ""}>Synced</option></select></label>
    </div><h4>Indian market data</h4><div class="row-flex"><span class="hint-text">Optional broker connection for live quotes and longer intraday history.</span><button class="btn" id="brokerSettings">Broker API settings</button></div><p class="hint-text">Broker credentials are stored locally in <code>data/broker.json</code> and are never returned to the browser or written to logs. Leave it unconfigured to use public sources.</p><p class="hint-text">Everything you save lives in the <code>data</code> folder next to the app, on your machine.</p>`,
      { foot: '<button class="btn primary" data-ok>Save</button>' },
    );
    card.querySelector("[data-ok]").onclick = () => {
      Object.assign(s, {
        bars: Math.max(200, Math.min(20000, Number($("#sBars").value) || 3000)),
        utc: $("#sUtc").value === "1",
        volume: $("#sVol").value === "1",
        stayInDrawMode: $("#sStay").value === "1",
        syncCrosshair: $("#sSync").value === "1",
      });
      $("#crosshairSync").checked = this.settings.syncCrosshair;
      this.closeModal();
      this.persist();
      this.panes.forEach((p) => p.load({ keepView: true }));
    };
    card.querySelector("#brokerSettings").onclick = () => this.openBrokerSettings();
  }

  async openBrokerSettings() {
    let current = { broker: "none", configured: false };
    try { current = await api.get("/api/broker-settings"); } catch { /* server may be updating */ }
    const body = `<p class="hint-text">Optional. This computer sends credentials only to your local Quant Terminal server, which uses them with the selected broker. Credentials are stored in the ignored <code>data/broker.json</code>; they are never displayed again or logged. Realtime access and history limits depend on your broker plan.</p><div class="form-grid"><label class="field">Provider<select id="brProvider"><option value="none">Public data only</option><option value="kite">Zerodha Kite Connect</option><option value="upstox">Upstox</option><option value="angel">Angel One SmartAPI</option><option value="dhan">Dhan</option></select></label><label class="field">API key<input id="brKey" type="password" autocomplete="new-password"></label><label class="field">API secret<input id="brSecret" type="password" autocomplete="new-password"></label><label class="field">Access token<input id="brToken" type="password" autocomplete="new-password"></label><label class="field">Client ID (Angel/Dhan)<input id="brClient" type="password" autocomplete="new-password"></label><label class="field">Client secret (optional)<input id="brClientSecret" type="password" autocomplete="new-password"></label><label class="field">Angel JWT token (if using Angel)<input id="brJwt" type="password" autocomplete="new-password"></label></div><label class="field">Instrument mappings (JSON)<textarea class="in" id="brMap" rows="5" placeholder='{"YAHOO:RELIANCE.NS":{"instrumentToken":"738561","exchange":"NSE","tradingsymbol":"RELIANCE"}}'></textarea></label><p class="hint-text">Kite: instrumentToken, exchange, tradingsymbol. Upstox: instrumentKey. Angel: exchange, symbolToken, tradingsymbol. Dhan: securityId, exchangeSegment, instrument. Key each mapping by the chart symbol (for example YAHOO:RELIANCE.NS). Use your broker’s current instrument master to find IDs.</p><p class="hint-text">Current: ${current.configured ? `${esc(current.broker)} configured; ${current.instrumentMappings} symbol mappings` : "no credentials configured"}. Leave credential boxes blank to keep saved values.</p>`;
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
        if (!$("#modal").classList.contains("hidden")) return this.closeModal();
        if (this.tool !== "cursor") return this.setTool("cursor");
        if (this.active?.drawings.selected) {
          this.active.drawings.selected = null;
          this.active.drawings.update();
        }
        return;
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
      this.toast(`<b>Alert</b><br>${esc(e.text)}`, "alert", 12000);
      this.beep();
      if ("Notification" in window && Notification.permission === "granted")
        new Notification("Quant Terminal alert", { body: e.text });
      this.panels?.onAlertFired?.(e);
    });
  }

  beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(),
        g = ctx.createGain();
      o.connect(g);
      g.connect(ctx.destination);
      o.frequency.value = 880;
      g.gain.value = 0.08;
      o.start();
      o.stop(ctx.currentTime + 0.25);
    } catch {
      /* no audio */
    }
  }

  async checkHealth() {
    try {
      const h = await api.get("/api/health");
      const failing = Object.entries(h.providers || {})
        .filter(([, v]) => !v.ok)
        .map(([k]) => k);
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
    $("#toasts").appendChild(el);
    setTimeout(() => el.remove(), ms);
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
