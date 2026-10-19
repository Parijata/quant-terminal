// Side panel (watchlist, alerts, calendar) and bottom panel (tester, screener, heatmap, paper, editor).
import {
  api,
  download,
  esc,
  fmtPrice,
  formatSymbolPrice,
  fmtPct,
  fmtNum,
  ticker,
  exchange,
} from "./api.js";
import { INDICATORS, BY_ID, registerIndicator } from "../lib/indicators.js";
import { renderNews, renderSeasonals, renderFinancials, renderCorrelation } from "./research.js";
import { mountQuantChecks } from "./quantui.js";
import {
  backtest,
  tradesCsv,
  EXAMPLE_STRATEGIES,
  OPS,
  magnifierTf,
} from "../lib/backtest.js";
import { parseTf } from "../lib/series.js";

const $ = (s, el = document) => el.querySelector(s);
const LW = window.LightweightCharts;
const isIndianSymbol = (sym) =>
  exchange(sym) === "YAHOO" &&
  (/\.(NS|BO)$/i.test(ticker(sym)) || ["^NSEI", "^BSESN"].includes(ticker(sym).toUpperCase()));
const css = (n) =>
  getComputedStyle(document.documentElement).getPropertyValue(n).trim();


// ---------- operand picker (shared by tester, alerts, screener scans) ----------
const PRICE = [
  "close",
  "open",
  "high",
  "low",
  "volume",
  "hl2",
  "hlc3",
  "ohlc4",
];
const OP_LABEL = {
  ">": "is above",
  "<": "is below",
  ">=": "is at or above",
  "<=": "is at or below",
  crossesAbove: "crosses above",
  crossesBelow: "crosses below",
  crosses: "crosses",
};
const outputsOf = (def) => [
  ...def.outputs.map((o) => o.key),
  ...(def.id === "supertrend" ? ["direction"] : []),
];
const mainInput = (def) =>
  (def.inputs || []).find((i) => i.type === "int" || i.type === "float");

function operandHtml(o) {
  const val =
    o.kind === "line"
      ? "l"
      : o.kind === "value"
        ? "v"
        : o.kind === "price"
          ? `p:${o.field}`
          : `i:${o.id}`;
  const opts = [
    o.kind === "line" ? `<option value="l" selected>${esc(o.label || "Drawn line")}</option>` : "",
    `<optgroup label="Price">${PRICE.map((f) => `<option value="p:${f}" ${val === `p:${f}` ? "selected" : ""}>${f === "close" ? "Price (close)" : f}</option>`).join("")}</optgroup>`,
    `<option value="v" ${val === "v" ? "selected" : ""}>Value</option>`,
    `<optgroup label="Indicators">${INDICATORS.filter((d) => d.outputs.length)
      .map(
        (d) =>
          `<option value="i:${esc(d.id)}" ${val === `i:${d.id}` ? "selected" : ""}>${esc(d.name)}</option>`,
      )
      .join("")}</optgroup>`,
  ].join("");
  let extra = "";
  if (o.kind === "value")
    extra = `<input class="num" data-v type="number" step="any" value="${o.v ?? 0}">`;
  if (o.kind === "ind") {
    const def = BY_ID[o.id];
    const mi = def && mainInput(def);
    if (mi)
      extra += `<input class="num" data-p="${mi.key}" type="number" step="any" title="${esc(mi.label)}" value="${o.params?.[mi.key] ?? mi.default}">`;
    const outs = def ? outputsOf(def) : [];
    if (outs.length > 1)
      extra += `<select data-out>${outs.map((k) => `<option ${k === o.output ? "selected" : ""}>${k}</option>`).join("")}</select>`;
  }
  const lineData = o.kind === "line" ? ` data-line="${esc(JSON.stringify(o.line))}" data-label="${esc(o.label || "Drawn line")}"` : "";
  return `<span class="operand"${lineData}><select data-kind>${opts}</select>${extra}</span>`;
}

function readOperand(span) {
  const k = span.querySelector("[data-kind]").value;
  if (k === "l") return { kind: "line", line: JSON.parse(span.dataset.line), label: span.dataset.label };
  if (k === "v")
    return {
      kind: "value",
      v: Number(span.querySelector("[data-v]")?.value || 0),
    };
  if (k.startsWith("p:")) return { kind: "price", field: k.slice(2) };
  const id = k.slice(2),
    def = BY_ID[id];
  const params = {};
  const p = span.querySelector("[data-p]");
  if (p) params[p.dataset.p] = Number(p.value);
  return {
    kind: "ind",
    id,
    params,
    output: span.querySelector("[data-out]")?.value || outputsOf(def)[0],
  };
}

function ruleHtml(r) {
  return `<div class="rule">${operandHtml(r.left)}<select data-op>${OPS.map((o) => `<option value="${o}" ${o === r.op ? "selected" : ""}>${OP_LABEL[o]}</option>`).join("")}</select>${operandHtml(r.right)}<button class="x" title="Remove">&times;</button></div>`;
}

function bindRules(container, onChange = () => {}) {
  container.addEventListener("change", (e) => {
    const span = e.target.closest(".operand");
    if (span && e.target.matches("[data-kind]")) {
      const k = e.target.value;
      const o =
        k === "v"
          ? { kind: "value", v: 0 }
          : k.startsWith("p:")
            ? { kind: "price", field: k.slice(2) }
            : {
                kind: "ind",
                id: k.slice(2),
                params: {},
                output: outputsOf(BY_ID[k.slice(2)])[0],
              };
      span.outerHTML = operandHtml(o);
    }
    onChange();
  });
  container.addEventListener("click", (e) => {
    if (e.target.matches(".rule .x")) {
      e.target.closest(".rule").remove();
      onChange();
    }
  });
}

const readRules = (container) =>
  [...container.querySelectorAll(".rule")].map((r) => {
    const ops = r.querySelectorAll(".operand");
    return {
      left: readOperand(ops[0]),
      op: r.querySelector("[data-op]").value,
      right: readOperand(ops[1]),
    };
  });

function compileRules(groups) {
  const indicators = {};
  const ref = (o) => {
    if (o.kind === "line") return { line: o.line };
    if (o.kind === "value") return Number(o.v);
    if (o.kind === "price") return o.field;
    const key = `${o.id}_${Object.values(o.params || {}).join("_")}`.replace(
      /[^a-z0-9_]/gi,
      "_",
    );
    indicators[key] = { id: o.id, params: o.params || {} };
    return `${key}.${o.output}`;
  };
  const out = { indicators };
  for (const [name, rules] of Object.entries(groups))
    out[name] = rules.map((r) => ({
      left: ref(r.left),
      op: r.op,
      right: ref(r.right),
    }));
  return out;
}

function toOperand(x, indicators) {
  if (x && typeof x === "object" && x.line) return { kind: "line", line: x.line, label: "Drawn line" };
  if (typeof x === "number") return { kind: "value", v: x };
  if (PRICE.includes(x)) return { kind: "price", field: x };
  const [k, out] = String(x).split(".");
  const s = indicators[k];
  const def = BY_ID[s?.id];
  if (!def) return { kind: "value", v: 0 };
  return {
    kind: "ind",
    id: s.id,
    params: { ...(s.params || {}) },
    output: out || s.output || outputsOf(def)[0],
  };
}

const defaultRule = () => ({
  left: { kind: "price", field: "close" },
  op: "crossesAbove",
  right: { kind: "ind", id: "ema", params: { length: 50 }, output: "value" },
});

// ==========================================================================================
export function initPanels(app) {
  const side = $("#sideBody"),
    bottom = $("#bottomBody"),
    bottomEl = $("#bottom");
  let sideTab = "watchlist",
    bottomTab = "tester";
  const P = {};

  // ---------- tabs ----------
  $("#sideTabs").onclick = (e) => {
    const t = e.target.dataset.tab;
    if (t) showSide(t);
  };
  $("#bottomTabs").onclick = (e) => {
    const t = e.target.closest("[data-tab]")?.dataset.tab;
    if (t) showBottom(t, true);
  };
  $("#bottomToggle").onclick = () => {
    bottomEl.classList.toggle("collapsed");
    if (!bottomEl.classList.contains("collapsed")) renderBottom();
  };

  function showSide(t) {
    sideTab = t;
    document
      .querySelectorAll("#sideTabs button")
      .forEach((b) => b.classList.toggle("active", b.dataset.tab === t));
    renderSide();
  }
  function showBottom(t, toggle = false) {
    if (
      toggle &&
      t === bottomTab &&
      !bottomEl.classList.contains("collapsed")
    ) {
      bottomEl.classList.add("collapsed");
      return;
    }
    bottomTab = t;
    bottomEl.classList.remove("collapsed");
    document
      .querySelectorAll("#bottomTabs [data-tab]")
      .forEach((b) => b.classList.toggle("active", b.dataset.tab === t));
    renderBottom();
  }
  const renderSide = () =>
    ({
      watchlist: renderWatchlist,
      alerts: renderAlerts,
      calendar: renderCalendar,
      news: () => renderNews(side, app),
    })[sideTab]();
  const renderBottom = () => {
    if (!bottomEl.classList.contains("collapsed"))
      ({
        tester: renderTester,
        screener: renderScreener,
        heatmap: renderHeatmap,
        seasonals: () => renderSeasonals(bottom, app),
        correlation: () => renderCorrelation(bottom, app),
        financials: () => renderFinancials(bottom, app),
        optionchain: renderOptionChain,
        indiaflows: renderIndiaFlows,
        paper: renderPaper,
        editor: renderEditor,
      })[bottomTab]();
  };

  // ======================= WATCHLIST =======================
  let quotes = {};
  function wlSymbols() {
    return app.state.watchlists[app.state.activeWatchlist] || [];
  }
  function renderWatchlist() {
    const names = Object.keys(app.state.watchlists);
    side.innerHTML = `<div class="wl-head"><select class="in" id="wlSel">${names.map((n) => `<option ${n === app.state.activeWatchlist ? "selected" : ""}>${esc(n)}</option>`).join("")}</select><button class="btn small wl-add-symbol" id="wlAddOpen" title="Browse all symbols" aria-label="Browse all symbols">＋</button><button class="btn small" id="wlNew" title="New list">+ List</button><button class="btn small" id="wlDel" title="Delete this list">Delete</button></div><div class="wl-search"><input class="in" id="wlAdd" placeholder="Search or add a symbol" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="wlSuggestions"><div id="wlSuggestions" class="wl-suggestions hidden" role="listbox"></div></div><div id="wlRows"></div>`;
    $("#wlSel").onchange = (e) => {
      app.state.activeWatchlist = e.target.value;
      app.persist();
      renderWatchlist();
      refreshQuotes();
    };
    $("#wlNew").onclick = () => {
      const n = prompt("Name for the new list:");
      if (!n || app.state.watchlists[n]) return;
      app.state.watchlists[n] = [];
      app.state.activeWatchlist = n;
      app.persist();
      renderWatchlist();
    };
    $("#wlDel").onclick = () => {
      if (names.length < 2) return app.toast("Keep at least one list.");
      if (!confirm(`Delete the list "${app.state.activeWatchlist}"?`)) return;
      delete app.state.watchlists[app.state.activeWatchlist];
      app.state.activeWatchlist = Object.keys(app.state.watchlists)[0];
      app.persist();
      renderWatchlist();
    };
    const addInput = $("#wlAdd"), suggestions = $("#wlSuggestions");
    let matches = [], activeMatch = 0, searchTimer, searchSeq = 0;
    const hideSuggestions = () => { suggestions.classList.add("hidden"); addInput.setAttribute("aria-expanded", "false"); };
    const showMatches = (rows) => {
      matches = rows || [];
      if (!matches.length) {
        suggestions.innerHTML = addInput.value.trim() ? '<div class="wl-no-suggestions">No matches. Press Enter to try this symbol.</div>' : "";
      } else {
        suggestions.innerHTML = matches.map((r, i) => `<button type="button" class="wl-suggestion ${i === activeMatch ? "active" : ""}" role="option" data-index="${i}"><b>${esc(ticker(r.symbol))}</b><span>${esc(r.name || "")} · ${esc(r.exchange || "")}</span><small>＋ Add</small></button>`).join("");
      }
      suggestions.classList.toggle("hidden", !addInput.value.trim());
      addInput.setAttribute("aria-expanded", String(Boolean(addInput.value.trim())));
    };
    const searchSymbols = async () => {
      const term = addInput.value.trim(), request = ++searchSeq;
      if (!term) { showMatches([]); return; }
      suggestions.innerHTML = '<div class="wl-no-suggestions">Searching…</div>';
      suggestions.classList.remove("hidden");
      addInput.setAttribute("aria-expanded", "true");
      try {
        const rows = await api.search(term);
        if (request !== searchSeq || addInput.value.trim() !== term) return;
        activeMatch = 0;
        showMatches(rows);
      } catch {
        if (request === searchSeq) showMatches([]);
      }
    };
    addInput.oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(searchSymbols, 180); };
    addInput.onkeydown = async (e) => {
      if (e.key === "ArrowDown" && matches.length) { activeMatch = Math.min(activeMatch + 1, matches.length - 1); showMatches(matches); e.preventDefault(); }
      else if (e.key === "ArrowUp" && matches.length) { activeMatch = Math.max(activeMatch - 1, 0); showMatches(matches); e.preventDefault(); }
      else if (e.key === "Escape") hideSuggestions();
      else if (e.key === "Enter") { e.preventDefault(); await addSymbol(matches[activeMatch]?.symbol || addInput.value); }
    };
    suggestions.onclick = async (e) => {
      const option = e.target.closest("[data-index]");
      if (option) await addSymbol(matches[Number(option.dataset.index)]?.symbol);
    };
    const addSymbol = async (raw) => {
      if (!raw?.trim()) return;
      try {
        const r = await api.get(`/api/resolve?symbol=${encodeURIComponent(raw.trim())}`);
        if (!r?.id) throw new Error("That symbol could not be resolved. Choose a search result or check the ticker.");
        const list = wlSymbols();
        const alreadyAdded = list.includes(r.id);
        if (alreadyAdded) { app.toast(`${ticker(r.id)} is already on this list.`); return false; }
        list.push(r.id);
        app.persist();
        drawRows();
        refreshQuotes();
        app.toast(`${ticker(r.id)} added to ${app.state.activeWatchlist}.`);
        addInput.value = "";
        matches = [];
        suggestions.innerHTML = "";
        hideSuggestions();
        return true;
      } catch (err) {
        app.toast(err.message, "err");
        return false;
      }
    };
    $("#wlAddOpen").onclick = () => app.openAddSymbolSearch(addSymbol, (symbol) => wlSymbols().includes(symbol));
    $("#wlRows").onclick = (e) => {
      const row = e.target.closest(".wl-row");
      if (!row) return;
      if (e.target.closest(".x")) {
        app.state.watchlists[app.state.activeWatchlist] = wlSymbols().filter(
          (s) => s !== row.dataset.sym,
        );
        app.persist();
        return drawRows();
      }
      app.setSymbol(row.dataset.sym);
    };
    drawRows();
  }
  function drawRows() {
    const box = $("#wlRows");
    if (!box) return;
    const cur = app.active?.cfg.symbol;
    box.innerHTML =
      wlSymbols()
        .map((s) => {
          const q = quotes[s] || {};
          const live = app.prices[s] ?? q.price;
          return `<div class="wl-row ${s === cur ? "current" : ""}" data-sym="${esc(s)}"><span class="sym">${esc(ticker(s))} <span class="ex">${esc(exchange(s))}</span></span><span class="px">${formatSymbolPrice(s, live)}</span><span class="chg ${q.changePct >= 0 ? "up" : "down"}">${fmtPct(q.changePct)}</span><button class="x" title="Remove"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>`;
        })
        .join("") ||
      '<div class="pad hint-text">Empty list. Add a symbol above.</div>';
  }
  async function refreshQuotes() {
    const syms = [...new Set([...wlSymbols(), ...paperSymbols()])];
    if (!syms.length) return;
    try {
      const q = await api.quotes(syms);
      Object.assign(quotes, q);
      for (const [s, v] of Object.entries(q))
        if (v.price) app.onPrice(s, v.price);
      if (sideTab === "watchlist") drawRows();
    } catch {
      /* offline */
    }
  }
  setInterval(refreshQuotes, 5000);
  refreshQuotes();

  // ======================= ALERTS =======================
  async function renderAlerts() {
    side.innerHTML =
      '<div class="pad row-flex"><button class="btn primary" id="alNew">New alert</button><button class="btn" id="alPerm">Desktop notifications</button></div><div id="alList"></div><h4 class="pad" style="margin:0;padding-bottom:0">Recent</h4><div id="alLog"></div>';
    $("#alNew").onclick = () => openAlertDialog();
    const perm = $("#alPerm");
    if (!("Notification" in window) || Notification.permission === "granted")
      perm.remove();
    else
      perm.onclick = () =>
        Notification.requestPermission().then(() => renderAlerts());
    let list = [],
      log = [];
    try {
      [list, log] = await Promise.all([
        api.get("/api/alerts"),
        api.get("/api/alerts/log"),
      ]);
    } catch {
      /* server down */
    }
    $("#alList").innerHTML =
      list
        .map(
          (a) =>
            `<div class="card" data-id="${a.id}"><div class="top"><div><b>${esc(ticker(a.symbol))}</b> <span class="muted">${esc(a.tf)}</span><div>${esc(describeAlert(a))}</div><div class="sub">${a.active ? "Active" : "Stopped"} · ${{ once: "only once", oncePerBar: "once per bar", oncePerBarClose: "once per bar close" }[a.trigger] || a.trigger}${a.webhook ? " · webhook" : ""}${a.fired ? ` · fired ${a.fired}x` : ""}</div></div><div class="row-flex" style="flex-wrap:nowrap"><button class="btn small" data-act="toggle">${a.active ? "Stop" : "Restart"}</button><button class="btn small danger" data-act="del">Delete</button></div></div></div>`,
        )
        .join("") ||
      '<div class="pad hint-text">No alerts yet. They run inside the app, so they keep firing with this tab closed as long as the app is running.</div>';
    $("#alLog").innerHTML =
      log
        .slice(0, 30)
        .map(
          (e) =>
            `<div class="card"><div>${esc(e.text)}</div><div class="sub">${new Date(e.at).toLocaleString()}${e.webhook ? ` · webhook ${esc(e.webhook)}` : ""}</div></div>`,
        )
        .join("") || '<div class="pad hint-text">Nothing has fired yet.</div>';
    $("#alList").onclick = async (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      const id = btn.closest("[data-id]").dataset.id;
      const a = list.find((x) => x.id === id);
      if (btn.dataset.act === "del") await api.del(`/api/alerts/${id}`);
      if (btn.dataset.act === "toggle")
        await api.patch(`/api/alerts/${id}`, {
          active: !a.active,
          lastBar: null,
        });
      renderAlerts();
    };
  }
  function describeAlert(a) {
    if (a.message) return a.message;
    const name = (x) => {
      if (typeof x === "number") return fmtPrice(x);
      if (PRICE.includes(x)) return x === "close" ? "Price" : x;
      const [k, out] = String(x).split(".");
      const s = a.indicators?.[k];
      const def = BY_ID[s?.id];
      return def
        ? `${def.name.replace(/ \(.*\)$/, "")} ${Object.values(s.params || {}).join(" ")}${out && outputsOf(def).length > 1 ? ` ${out}` : ""}`
        : x;
    };
    const conds = a.conditions?.length ? a.conditions : [{ left: a.left, op: a.op, right: a.right }];
    const nm = (x) => (x && typeof x === "object" && x.line ? "your drawn line" : name(x));
    return conds.map((c) => `${nm(c.left)} ${OP_LABEL[c.op] || c.op} ${nm(c.right)}`).join(a.match === "any" ? " or " : " and ");
  }
  function openAlertDialog(preset = {}) {
    const p = app.active;
    const price = p?.shown.at(-1)?.close ?? 0;
    const rules = preset.rules || [preset.rule || {
      left: { kind: "price", field: "close" },
      op: "crossesAbove",
      right: { kind: "value", v: Number(price.toPrecision(6)) },
    }];
    const card = app.modal(
      "Create alert",
      `<div class="form-grid"><label class="field">Symbol<input id="aSym" value="${esc(preset.symbol || p?.cfg.symbol || "")}"></label><label class="field">Timeframe<input id="aTf" value="${esc(p?.cfg.tf || "1h")}"></label></div>
      <h4>Conditions</h4><div class="rules" id="aRule">${rules.map(ruleHtml).join("")}</div>
      <div class="row-flex"><button class="btn small" id="aAdd">+ Condition</button><label class="field" style="flex-direction:row;align-items:center;gap:6px">Fire when<select id="aMatch"><option value="all">all are true</option><option value="any">any is true</option></select></label><span class="hint-text">Up to 5.</span></div>
      <div class="form-grid"><label class="field">Trigger<select id="aTrig"><option value="once">Only once</option><option value="oncePerBar">Once per bar</option><option value="oncePerBarClose">Once per bar close</option></select></label><label class="field">Message (optional)<input id="aMsg" placeholder="BTC broke out"></label></div>
      <h4>Also send to (optional)</h4><div class="row-flex"><input class="in" id="aHook" placeholder="Discord, Slack or Telegram webhook URL" style="flex:1"><button class="btn" id="aTest">Test</button></div>
      <p class="hint-text">Telegram: https://api.telegram.org/bot&lt;token&gt;/sendMessage?chat_id=&lt;your id&gt;. Alerts are checked every 15 seconds while the app runs.</p>`,
      {
        foot: '<button class="btn primary" id="aOk">Create alert</button>',
        wide: true,
      },
    );
    bindRules(card.querySelector("#aRule"));
    card.querySelector("#aAdd").onclick = () => {
      const box = card.querySelector("#aRule");
      if (box.querySelectorAll(".rule").length >= 5) return app.toast("An alert can have up to 5 conditions.");
      box.insertAdjacentHTML("beforeend", ruleHtml({ left: { kind: "price", field: "close" }, op: ">", right: { kind: "value", v: Number(price.toPrecision(6)) } }));
    };
    card.querySelector("#aTest").onclick = async () => {
      try {
        const r = await api.post("/api/webhook-test", {
          url: card.querySelector("#aHook").value.trim(),
        });
        app.toast(
          r.ok ? "Test message sent." : `Webhook replied HTTP ${r.status}`,
          r.ok ? "" : "err",
        );
      } catch (e) {
        app.toast(e.message, "err");
      }
    };
    card.querySelector("#aOk").onclick = async () => {
      const rs = readRules(card.querySelector("#aRule"));
      if (!rs.length) return app.toast("Add a condition.", "err");
      const c = compileRules({ rules: rs });
      try {
        await api.post("/api/alerts", {
          symbol: card.querySelector("#aSym").value.trim(),
          tf: card.querySelector("#aTf").value.trim(),
          left: c.rules[0].left,
          op: c.rules[0].op,
          right: c.rules[0].right,
          conditions: c.rules,
          match: card.querySelector("#aMatch").value,
          indicators: c.indicators,
          trigger: card.querySelector("#aTrig").value,
          message: card.querySelector("#aMsg").value.trim(),
          webhook: card.querySelector("#aHook").value.trim(),
        });
        app.closeModal();
        app.toast("Alert created.");
        if ("Notification" in window && Notification.permission === "default")
          Notification.requestPermission();
        showSide("alerts");
      } catch (e) {
        app.toast(e.message, "err");
      }
    };
  }

  // ======================= CALENDAR =======================
  let calFilter = "High", calView = "economic", calMine = false;
  async function renderCalendar() {
    side.innerHTML = `<div class="pad row-flex"><select class="in" id="calV"><option value="economic">Economic</option><option value="earnings">Earnings</option><option value="dividends">Dividends</option></select><span class="spacer"></span>${
      calView === "economic"
        ? '<select class="in" id="calF"><option value="all">All</option><option value="Medium">Medium + high</option><option value="High">High impact</option></select>'
        : `<label class="hint-text"><input type="checkbox" id="calMine" ${calMine ? "checked" : ""}> My watchlists</label>`
    }</div><div id="calList" class="pad hint-text">Loading…</div>`;
    $("#calV").value = calView;
    $("#calV").onchange = (e) => { calView = e.target.value; renderCalendar(); };
    if ($("#calF")) { $("#calF").value = calFilter; $("#calF").onchange = (e) => { calFilter = e.target.value; renderCalendar(); }; }
    if ($("#calMine")) $("#calMine").onchange = (e) => { calMine = e.target.checked; renderCalendar(); };
    const list = $("#calList");
    const dayHead = (label) => `<h4 class="pad" style="margin:0;padding-bottom:0">${esc(label)}</h4>`;
    const fmtDay = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
    const mine = new Set(Object.values(app.state.watchlists || {}).flat());
    try {
      if (calView === "economic") {
        const rows = await api.get("/api/calendar");
        const keep = (r) => calFilter === "all" || r.impact === "High" || (calFilter === "Medium" && r.impact === "Medium");
        let day = "";
        list.className = "";
        list.innerHTML = rows.filter(keep).map((r) => {
          const d = new Date(r.date);
          const label = d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
          const head = label !== day ? dayHead((day = label)) : "";
          return `${head}<div class="card"><div class="top"><span><b>${esc(r.country)}</b> ${esc(r.title)}</span><span class="impact-${esc(r.impact)}">${esc(r.impact)}</span></div><div class="sub">${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}${r.forecast ? ` · forecast ${esc(r.forecast)}` : ""}${r.previous ? ` · previous ${esc(r.previous)}` : ""}</div></div>`;
        }).join("") || '<div class="pad hint-text">Nothing at this impact level this week.</div>';
        return;
      }
      let rows = await api.get(`/api/${calView}?days=5`);
      if (calView === "earnings") {
        const india = await api.get("/api/india-earnings").catch(() => []);
        rows = [...rows, ...india];
      }
      rows = rows.filter((r) => !calMine || mine.has(r.symbol));
      rows.sort((x, y) => x.date.localeCompare(y.date) || (mine.has(y.symbol) - mine.has(x.symbol)) || (y.marketCap || 0) - (x.marketCap || 0));
      let day = "";
      list.className = "";
      list.innerHTML = rows.slice(0, 250).map((r) => {
        const head = r.date !== day ? dayHead(fmtDay((day = r.date))) : "";
        const star = mine.has(r.symbol) ? ' <span class="up" title="On your watchlist">●</span>' : "";
        const sub = calView === "earnings"
          ? `${esc(r.when)}${r.epsForecast ? ` · EPS forecast ${esc(r.epsForecast)}` : ""}${r.lastYearEps ? ` · last year ${esc(r.lastYearEps)}` : ""}${r.marketCap ? ` · cap ${fmtNum(r.marketCap)}` : ""}${r.description ? ` · ${esc(r.description)}` : ""}`
          : `${r.amount != null ? `${fmtPrice(r.amount)} a share` : ""}${r.payDate ? ` · paid ${esc(r.payDate)}` : ""}${r.annual ? ` · ${fmtPrice(r.annual)} a year` : ""}`;
        return `${head}<div class="card cal-row" data-sym="${esc(r.symbol)}" style="cursor:pointer"><div class="top"><span><b>${esc(r.ticker)}</b>${star} <span class="muted">${esc((r.name || "").slice(0, 34))}</span></span></div><div class="sub">${sub}</div></div>`;
      }).join("") || `<div class="pad hint-text">${calMine ? "None of your watchlist symbols in the next five trading days." : "Nothing listed for the next five trading days."}</div>`;
      list.onclick = (e) => { const row = e.target.closest(".cal-row"); if (row) app.setSymbol(row.dataset.sym); };
    } catch (e) {
      list.textContent = `Calendar unavailable: ${e.message}`;
    }
  }

  // ======================= STRATEGY TESTER =======================
  let lastResult = null,
    equityChart = null;
  const tState = {
    groups: null,
    settings: {
      direction: "long",
      stopLossPct: 0,
      takeProfitPct: 0,
      trailingStopPct: 0,
      exitMatch: "all",
      maxBarsInTrade: 0,
      initialCapital: 10000,
      positionPct: 100,
      feePct: 0.1,
      slippagePct: 0.05,
      spreadPct: 0,
      intrabar: "worst",
    },
  };
  function strategyToUi(s) {
    const ind = s.indicators || {};
    const g = (k) =>
      (s[k] || []).map((r) => ({
        left: toOperand(r.left, ind),
        op: r.op,
        right: toOperand(r.right, ind),
      }));
    tState.groups = {
      entryLong: g("entryLong"),
      exitLong: g("exitLong"),
      entryShort: g("entryShort"),
      exitShort: g("exitShort"),
    };
    for (const k of ["stopLossPct", "takeProfitPct", "trailingStopPct", "maxBarsInTrade"])
      tState.settings[k] = s[k] || 0;
    tState.settings.exitMatch = s.exitMatch === "any" ? "any" : "all";
  }
  if (!tState.groups) strategyToUi(EXAMPLE_STRATEGIES["EMA cross (9/21)"]);

  function readTester() {
    const groups = {};
    for (const k of ["entryLong", "exitLong", "entryShort", "exitShort"])
      groups[k] = readRules(bottom.querySelector(`[data-g="${k}"]`));
    tState.groups = groups;
    bottom.querySelectorAll("[data-s]").forEach((el) => {
      tState.settings[el.dataset.s] =
        el.type === "number" ? Number(el.value) : el.value;
    });
    return { ...compileRules(groups), ...tState.settings };
  }

  function renderTester() {
    const group = (k, title) =>
      `<h4>${title}</h4><div class="rules" data-g="${k}">${(tState.groups[k] || []).map(ruleHtml).join("")}</div><button class="btn small" data-add="${k}">+ Condition</button>`;
    const num = (k, label, step = "any") =>
      `<label class="field">${label}<input data-s="${k}" type="number" step="${step}" value="${tState.settings[k]}"></label>`;
    const saved = Object.keys(app.state.strategies || {});
    bottom.innerHTML = `<div class="tester"><div class="left">
      <div class="row-flex"><select class="in" id="tPreset"><option value="">Load a strategy…</option><optgroup label="Examples">${Object.keys(
        EXAMPLE_STRATEGIES,
      )
        .map((n) => `<option value="ex:${esc(n)}">${esc(n)}</option>`)
        .join(
          "",
        )}</optgroup>${saved.length ? `<optgroup label="Saved">${saved.map((n) => `<option value="sv:${esc(n)}">${esc(n)}</option>`).join("")}</optgroup>` : ""}</select><button class="btn primary" id="tRun">Run on chart</button></div>
      <p class="hint-text">Entry conditions must all be true. Exits can need all of theirs or just one. Leave a section empty to skip it. Signals use the bar's close and fill at the next bar's open.</p>
      ${group("entryLong", "Buy (enter long) when")}${group("exitLong", "Sell (exit long) when")}${group("entryShort", "Enter short when")}${group("exitShort", "Exit short when")}
      <h4>Exits</h4><div class="row-flex"><label class="field">Exit when<select class="in" data-s="exitMatch"><option value="all"${tState.settings.exitMatch === "any" ? "" : " selected"}>all exit conditions are true</option><option value="any"${tState.settings.exitMatch === "any" ? " selected" : ""}>any one exit condition is true</option></select></label>${num("maxBarsInTrade", "Exit after this many bars (0 = off)", 1)}</div>
      <h4>Risk</h4><div class="row-flex">${num("stopLossPct", "Stop loss %")}${num("takeProfitPct", "Take profit %")}${num("trailingStopPct", "Trailing stop %")}</div>
      <h4>Money</h4><div class="row-flex">${num("initialCapital", `Starting capital (${isIndianSymbol(app.active?.cfg.symbol) ? "₹" : "$"})`)}${num("positionPct", "Position size %")}${num("feePct", "Fee % per side")}${num("slippagePct", "Slippage % per side")}${num("spreadPct", "Spread % (bid to ask)")}<button class="btn small" id="tSpread" title="Read the live bid and ask (crypto)">Live spread</button></div>
      <h4>Fills inside a bar</h4><div class="row-flex"><label class="field">Stops and targets<select class="in" data-s="intrabar">${[
        ["worst", "Stop first when a bar touches both (cautious)"],
        ["ohlc", "TradingView's path: open, nearer extreme, far extreme, close"],
        ["magnifier", "Bar magnifier: real lower-timeframe bars inside each bar"],
      ]
        .map(([v, t]) => `<option value="${v}"${tState.settings.intrabar === v ? " selected" : ""}>${t}</option>`)
        .join("")}</select></label></div>
      <h4>Your own data</h4><div class="row-flex"><button class="btn small" id="tImpBars">Import bars (CSV)</button><button class="btn small" id="tImpSig">Import signal (CSV)</button><input type="file" id="tImpFile" accept=".csv,.txt,text/csv" hidden></div>
      <p class="hint-text">Bars: time, open, high, low, close and volume, one symbol per file (an Alpaca export works as it is). They chart as CSV:NAME on their own timeframe and longer. Signal: time and position, 1 long, 0 flat, -1 short, from that bar's close. It loads here as rules, so Run on chart and the quant checks test your strategy as written.</p>
      <div class="row-flex" style="margin-top:12px"><button class="btn" id="tSave">Save strategy</button><button class="btn" id="tJson">Edit as JSON</button></div>
    </div><div class="right" id="tOut"><div class="hint-text">Pick or build a strategy, then press <b>Run on chart</b>. It runs on the active chart's symbol and timeframe.</div></div></div>`;
    for (const k of ["entryLong", "exitLong", "entryShort", "exitShort"])
      bindRules(bottom.querySelector(`[data-g="${k}"]`));
    bottom.querySelectorAll("[data-add]").forEach((b) => {
      b.onclick = () => {
        bottom
          .querySelector(`[data-g="${b.dataset.add}"]`)
          .insertAdjacentHTML("beforeend", ruleHtml(defaultRule()));
      };
    });
    $("#tPreset").onchange = (e) => {
      const v = e.target.value;
      if (!v) return;
      const s = v.startsWith("ex:")
        ? EXAMPLE_STRATEGIES[v.slice(3)]
        : app.state.strategies[v.slice(3)];
      strategyToUi(s);
      tState.name = v.slice(3);
      for (const k of [
        "initialCapital",
        "positionPct",
        "feePct",
        "slippagePct",
        "spreadPct",
        "intrabar",
      ])
        if (s[k] != null) tState.settings[k] = s[k];
      renderTester();
    };
    $("#tRun").onclick = runTester;
    let impKind = "bars";
    const pickFile = (kind) => {
      impKind = kind;
      $("#tImpFile").value = "";
      $("#tImpFile").click();
    };
    $("#tImpBars").onclick = () => pickFile("bars");
    $("#tImpSig").onclick = () => pickFile("signal");
    $("#tImpFile").onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        app.toast(`Reading ${f.name}…`);
        const res = await fetch(`/api/import/${impKind}?name=${encodeURIComponent(f.name)}`, {
          method: "POST",
          headers: { "x-qt": "1", "Content-Type": "text/csv" },
          body: await f.text(),
        });
        const r = await res.json();
        if (!res.ok) throw new Error(r.error || `HTTP ${res.status}`);
        if (impKind === "bars") {
          const pane = app.active;
          if (pane && parseTf(pane.cfg.tf).seconds < parseTf(r.tf).seconds) pane.cfg.tf = r.tf;
          app.setSymbol(r.symbol);
          app.toast(`Imported ${r.bars.toLocaleString()} ${r.tf} bars as ${r.symbol}${r.skipped ? ` (skipped ${r.skipped} rows with no price)` : ""}. Pick any timeframe from ${r.tf} up.`);
        } else {
          if (!(await app.importCustom(r.file))) return;
          strategyToUi(r.strategy);
          tState.name = `Signal ${r.name}`;
          renderTester();
          app.toast(`Loaded your signal ${r.name}: ${r.changes.toLocaleString()} position changes. Open the bars it was made on, then press Run on chart.`);
        }
      } catch (err) {
        app.toast(err.message, "err");
      }
    };
    $("#tSpread").onclick = async () => {
      const sym = app.active?.cfg.symbol;
      try {
        const r = await api.get(`/api/spread?symbol=${encodeURIComponent(sym)}`);
        bottom.querySelector('[data-s="spreadPct"]').value = Number(r.spreadPct.toPrecision(2));
        app.toast(`${ticker(r.symbol)} on ${r.source}: bid ${fmtPrice(r.bid)}, ask ${fmtPrice(r.ask)}. Spread set to ${Number(r.spreadPct.toPrecision(2))}%.`);
      } catch (e) {
        app.toast(e.message, "err");
      }
    };
    $("#tSave").onclick = () => {
      const name = prompt("Name this strategy:");
      if (!name) return;
      app.state.strategies = {
        ...(app.state.strategies || {}),
        [name]: readTester(),
      };
      app.persist();
      app.toast(`Saved "${name}".`);
    };
    $("#tJson").onclick = () => {
      const card = app.modal(
        "Strategy JSON",
        `<p class="hint-text">The same format your AI agent can write. Operands: numbers, price fields, indicator keys, or key.output.</p><textarea class="in" id="tJ" rows="22">${esc(JSON.stringify(readTester(), null, 2))}</textarea>`,
        {
          foot: '<button class="btn primary" id="tJOk">Apply</button>',
          wide: true,
        },
      );
      card.querySelector("#tJOk").onclick = () => {
        try {
          const s = JSON.parse(card.querySelector("#tJ").value);
          strategyToUi(s);
          for (const k of [
            "initialCapital",
            "positionPct",
            "feePct",
            "slippagePct",
            "spreadPct",
            "intrabar",
          ])
            if (s[k] != null) tState.settings[k] = s[k];
          app.closeModal();
          renderTester();
        } catch (e) {
          app.toast(`Invalid JSON: ${e.message}`, "err");
        }
      };
    };
    if (lastResult) showResult(lastResult);
  }

  async function runTester() {
    const p = app.active;
    if (!p?.bars.length)
      return app.toast("The active chart has no data yet.", "err");
    let strat;
    try {
      strat = readTester();
    } catch (e) {
      return app.toast(e.message, "err");
    }
    if (!strat.entryLong.length && !strat.entryShort.length)
      return app.toast("Add at least one entry condition.", "err");
    try {
      const bars = p.replay ? p.bars.slice(0, p.replay.index + 1) : p.bars;
      let subBars = null;
      if (strat.intrabar === "magnifier") {
        const sec = parseTf(p.cfg.tf).seconds;
        const m = magnifierTf(sec, bars.at(-1).time - bars[0].time + sec);
        if (!m) app.toast("This chart is already as fine as the bar magnifier goes, so it uses the OHLC path.");
        else {
          app.toast(`Loading ${m.tf} bars for the bar magnifier…`);
          const span = bars.at(-1).time - bars[0].time + sec;
          const r = await api.candles(p.cfg.symbol, m.tf, Math.ceil(span / m.seconds) + 10);
          subBars = r.candles.filter((c) => c.time >= bars[0].time && c.time < bars.at(-1).time + sec);
        }
      }
      const r = backtest(bars, strat, { subBars });
      lastResult = { ...r, symbol: p.cfg.symbol, tf: p.cfg.tf, bars, strat, subBars };
      p.extraMarkers = r.trades.flatMap((t) => [
        {
          time: t.entryTime,
          position: t.side === "long" ? "belowBar" : "aboveBar",
          shape: t.side === "long" ? "arrowUp" : "arrowDown",
          color: t.side === "long" ? "#2962ff" : "#ff6d00",
          text: t.side === "long" ? "Buy" : "Short",
        },
        {
          time: t.exitTime,
          position: t.side === "long" ? "aboveBar" : "belowBar",
          shape: "circle",
          color: t.pnl >= 0 ? "#089981" : "#f23645",
          text: `${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct.toFixed(1)}%`,
        },
      ]);
      p.render(false);
      showResult(lastResult);
    } catch (e) {
      app.toast(e.message, "err");
    }
  }

  function showResult(r) {
    const out = $("#tOut");
    if (!out) return;
    const s = r.stats;
    const stat = (k, v, cls = "") =>
      `<div class="stat"><div class="k">${k}</div><div class="v ${cls}">${v ?? "—"}</div></div>`;
    const pc = (v) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v}%`);
    out.innerHTML = `<div class="row-flex"><b>${esc(ticker(r.symbol))} ${esc(r.tf)}</b><span class="hint-text">${r.bars.length} bars · ${new Date(r.bars[0].time * 1000).toLocaleDateString()} to ${new Date(r.bars.at(-1).time * 1000).toLocaleDateString()} · ${esc(s.feesAndSlippage)} · ${esc(s.fills)}</span><span class="spacer"></span><button class="btn small" id="tCsv">Export trades (CSV)</button><button class="btn small" id="tClear">Clear chart marks</button></div>
      <div class="stats">${stat("Net profit", pc(s.netProfitPct), s.netProfitPct >= 0 ? "up" : "down")}${stat("CAGR", pc(s.cagrPct))}${stat("Buy and hold", pc(s.buyHoldPct), s.buyHoldPct >= 0 ? "up" : "down")}${stat("Max drawdown", s.maxDrawdownPct == null ? "—" : `-${s.maxDrawdownPct}%`, "down")}${stat("Trades", s.totalTrades)}${stat("Win rate", s.winRatePct == null ? "—" : `${s.winRatePct}%`)}${stat("Profit factor", s.profitFactor)}${stat("Sharpe", s.sharpe)}${stat("Sortino", s.sortino)}${stat("Avg trade", pc(s.avgTradePct))}${stat("Time in market", s.exposurePct == null ? "—" : `${s.exposurePct}%`)}</div>
      <div class="equity" id="tEq"></div>
      <div id="tQuant"></div>
      <div id="tPtq"></div>
      <table class="t"><thead><tr><th>Side</th><th>Entry</th><th>Exit</th><th>Entry price</th><th>Exit price</th><th>P&amp;L %</th><th>Bars</th><th class="l">Exit reason</th></tr></thead><tbody>${r.trades
        .slice()
        .reverse()
        .slice(0, 300)
        .map(
          (t) =>
            `<tr data-t="${t.entryTime}"><td>${t.side}</td><td>${new Date(t.entryTime * 1000).toLocaleString()}</td><td>${new Date(t.exitTime * 1000).toLocaleString()}</td><td>${formatSymbolPrice(r.symbol, t.entryPrice)}</td><td>${formatSymbolPrice(r.symbol, t.exitPrice)}</td><td class="${t.pnl >= 0 ? "up" : "down"}">${t.pnlPct.toFixed(2)}%</td><td>${t.bars}</td><td class="l">${esc(t.exitReason)}</td></tr>`,
        )
        .join("")}</tbody></table>`;
    $("#tCsv").onclick = () =>
      download(`${ticker(r.symbol)}-${r.tf}-trades.csv`, tradesCsv(r.trades));
    $("#tClear").onclick = () => {
      app.active.extraMarkers = [];
      app.active.render(false);
    };
    equityChart?.remove();
    const el = $("#tEq");
    equityChart = LW.createChart(el, {
      autoSize: true,
      layout: {
        background: { type: "solid", color: css("--bg") },
        textColor: css("--text"),
        fontSize: 10,
        attributionLogo: false,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: css("--grid") },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false },
    });
    const eq = equityChart.addSeries(LW.AreaSeries, {
      lineColor: "#2962ff",
      topColor: "rgba(41,98,255,.3)",
      bottomColor: "rgba(41,98,255,0)",
      lineWidth: 2,
      title: "Strategy",
    });
    eq.setData(r.equity.map((e) => ({ time: e.time, value: e.value })));
    const bh = equityChart.addSeries(LW.LineSeries, {
      color: "#787b86",
      lineWidth: 1,
      title: "Buy & hold",
      priceLineVisible: false,
    });
    const c0 = r.bars[0].close;
    bh.setData(
      r.bars.map((b) => ({
        time: b.time,
        value: (r.strat.initialCapital * b.close) / c0,
      })),
    );
    equityChart.timeScale().fitContent();
    mountQuantChecks($("#tQuant"), r);
  }

  // ======================= SCREENER =======================
  const sc = {
    universe: "nifty50",
    rows: [],
    sort: "volume",
    dir: -1,
    visible: 500,
    filters: {},
    scan: null,
    rule: {
      left: { kind: "ind", id: "rsi", params: { length: 14 }, output: "value" },
      op: "<",
      right: { kind: "value", v: 30 },
    },
    tf: "1D",
    tech: {},
  };
  app.state.savedScans ||= [];
  async function loadScreener() {
    $("#scTable").innerHTML = '<div class="pad hint-text">Loading…</div>';
    try {
      sc.rows = await api.get(`/api/screener?universe=${sc.universe}`);
      sc.scan = null;
    } catch (e) {
      sc.rows = [];
      app.toast(e.message, "err");
    }
    drawScreener();
  }
  function filtered() {
    const f = sc.filters;
    const term = (f.q || "").toLowerCase();
    return sc.rows
      .filter(
        (r) =>
          (!term || `${r.ticker} ${r.name}`.toLowerCase().includes(term)) &&
          (f.minPrice == null || r.price >= f.minPrice) &&
          (f.maxPrice == null || r.price <= f.maxPrice) &&
          (f.minChg == null || r.changePct >= f.minChg) &&
          (f.maxChg == null || r.changePct <= f.maxChg) &&
          (f.minVol == null || r.volume >= f.minVol) &&
          (f.minCap == null || (r.marketCap || 0) >= f.minCap) &&
          (!f.sector || r.sector === f.sector) &&
          (!sc.scan || sc.scan[r.symbol]?.pass),
      )
      .sort(
        (a, b) =>
          sc.dir *
          (typeof a[sc.sort] === "string"
            ? a[sc.sort].localeCompare(b[sc.sort])
            : (a[sc.sort] || 0) - (b[sc.sort] || 0)),
      );
  }
  function renderScreener() {
    const sectors = [
      ...new Set(sc.rows.map((r) => r.sector).filter(Boolean)),
    ].sort();
    const n = (k, label, w = 80) =>
      `<label class="field">${label}<input data-f="${k}" type="number" step="any" style="width:${w}px" value="${sc.filters[k] ?? ""}"></label>`;
    bottom.innerHTML = `<div class="pad"><div class="row-flex">
      <label class="field">Market<select id="scU"><option value="crypto">Crypto (USDT pairs)</option><option value="us">US stocks</option><option value="etf">US ETFs</option><option value="india">All Indian stocks</option><option value="nifty50">Nifty 50</option><option value="nifty100">Nifty 100</option><option value="nifty500">Nifty 500</option><option value="sensex">Sensex</option></select></label>
      <label class="field">Search<input data-f="q" value="${esc(sc.filters.q || "")}" style="width:120px"></label>
      ${n("minPrice", sc.universe === "india" ? "Price from (₹)" : "Price from")}${n("maxPrice", sc.universe === "india" ? "Price to (₹)" : "Price to")}${n("minChg", "Change % from", 70)}${n("maxChg", "Change % to", 70)}${n("minVol", "Min volume", 100)}${sc.universe !== "crypto" ? n("minCap", sc.universe === "india" ? "Min market cap (₹)" : "Min market cap", 110) : ""}
      ${sectors.length > 1 ? `<label class="field">Sector<select data-f="sector"><option value="">All</option>${sectors.map((s) => `<option ${s === sc.filters.sector ? "selected" : ""}>${esc(s)}</option>`).join("")}</select></label>` : ""}
      <button class="btn" id="scRefresh" style="align-self:end">Refresh</button></div>
      <div class="row-flex" style="margin-top:8px"><span class="hint-text">Technical rule:</span><div class="rules" id="scRule" style="margin:0">${ruleHtml(sc.rule)}</div><label class="field">Timeframe<select id="scTf">${["1h", "4h", "1D", "1W"].map((t) => `<option ${t === sc.tf ? "selected" : ""}>${t}</option>`).join("")}</select></label><button class="btn primary" id="scScan" style="align-self:end">Scan up to 500</button>${sc.scan ? '<button class="btn" id="scClear" style="align-self:end">Clear scan</button>' : ""}<button class="btn" id="scBreadth" style="align-self:end">Market breadth</button></div>
      <div class="row-flex" style="margin-top:8px"><span class="hint-text">Quick filters:</span><label class="field">RSI min<input data-tech="rsiMin" type="number" min="0" max="100" value="${sc.tech.rsiMin ?? ""}" style="width:70px"></label><label class="field">RSI max<input data-tech="rsiMax" type="number" min="0" max="100" value="${sc.tech.rsiMax ?? ""}" style="width:70px"></label><label class="field">Price vs EMA<select data-tech="ema"><option value="">Any</option><option value="above50" ${sc.tech.ema === "above50" ? "selected" : ""}>Above 50</option><option value="below50" ${sc.tech.ema === "below50" ? "selected" : ""}>Below 50</option><option value="above200" ${sc.tech.ema === "above200" ? "selected" : ""}>Above 200</option><option value="below200" ${sc.tech.ema === "below200" ? "selected" : ""}>Below 200</option></select></label><label class="field">Volume spike x<input data-tech="volumeSpike" type="number" min="1" step="0.1" value="${sc.tech.volumeSpike ?? ""}" style="width:70px"></label><label class="field">52-week<select data-tech="week52"><option value="">Any</option><option value="high" ${sc.tech.week52 === "high" ? "selected" : ""}>Within 5% high</option><option value="low" ${sc.tech.week52 === "low" ? "selected" : ""}>Within 5% low</option></select></label><label class="field">Supertrend flip<select data-tech="supertrendFlip"><option value="">Any</option><option value="up" ${sc.tech.supertrendFlip === "up" ? "selected" : ""}>Bullish</option><option value="down" ${sc.tech.supertrendFlip === "down" ? "selected" : ""}>Bearish</option></select></label><label class="field">MACD cross<select data-tech="macdCross"><option value="">Any</option><option value="bullish" ${sc.tech.macdCross === "bullish" ? "selected" : ""}>Bullish</option><option value="bearish" ${sc.tech.macdCross === "bearish" ? "selected" : ""}>Bearish</option></select></label></div>
      <div class="row-flex" style="margin-top:8px"><input class="in" id="scSaveName" placeholder="Name this scan" style="width:160px"><button class="btn" id="scSave">Save scan</button><select class="in" id="scSaved"><option value="">Saved scans…</option>${app.state.savedScans.map((s,i)=>`<option value="${i}">${esc(s.name)}</option>`).join("")}</select><button class="btn" id="scGainers">Top gainers</button><button class="btn" id="scLosers">Top losers</button><button class="btn" id="scActive">Most active</button></div><div id="scBreadthResult" class="hint-text" style="margin-top:6px"></div></div>
      <div id="scTable"></div>`;
    $("#scU").value = sc.universe;
    $("#scU").onchange = (e) => {
      sc.universe = e.target.value;
      sc.filters = {};
      sc.visible = 500;
      renderScreener();
      loadScreener();
    };
    bottom.querySelectorAll("[data-f]").forEach((el) => {
      el.oninput = () => {
        const v = el.value.trim();
        sc.filters[el.dataset.f] =
          v === "" ? null : el.type === "number" ? Number(v) : v;
        drawScreener();
      };
    });
    bottom.querySelectorAll("[data-tech]").forEach((el) => {
      el.onchange = () => {
        const v = el.value.trim();
        sc.tech[el.dataset.tech] = v === "" ? null : el.type === "number" ? Number(v) : v;
      };
    });
    bindRules($("#scRule"));
    $("#scRule .x")?.remove();
    $("#scRefresh").onclick = loadScreener;
    $("#scGainers").onclick = () => { sc.sort = "changePct"; sc.dir = -1; drawScreener(); };
    $("#scLosers").onclick = () => { sc.sort = "changePct"; sc.dir = 1; drawScreener(); };
    $("#scActive").onclick = () => { sc.sort = "volume"; sc.dir = -1; drawScreener(); };
    $("#scSave").onclick = () => {
      const name = $("#scSaveName").value.trim();
      if (!name) return app.toast("Enter a name for the scan.", "err");
      app.state.savedScans = app.state.savedScans.filter((s) => s.name !== name);
      app.state.savedScans.push({ name, universe: sc.universe, filters: structuredClone(sc.filters), tech: structuredClone(sc.tech), rule: structuredClone(sc.rule), tf: sc.tf });
      app.persist(); renderScreener();
    };
    $("#scSaved").onchange = (e) => {
      const s = app.state.savedScans[Number(e.target.value)]; if (!s) return;
      sc.universe = s.universe; sc.filters = structuredClone(s.filters || {}); sc.tech = structuredClone(s.tech || {}); sc.rule = structuredClone(s.rule || sc.rule); sc.tf = s.tf || "1D"; sc.scan = null;
      renderScreener(); loadScreener();
    };
    $("#scBreadth").onclick = async () => {
      const out = $("#scBreadthResult"); out.textContent = `Calculating breadth for ${Math.min(sc.rows.length, 500)} stocks…`;
      try {
        const r = await api.post("/api/scan", { symbols: sc.rows.slice(0,500).map(x=>x.symbol), tf: "1D", metrics: true, rules: [] });
        const good = r.filter(x=>x.metrics), adv = good.filter(x=>x.metrics.changePct>0).length, dec = good.filter(x=>x.metrics.changePct<0).length;
        const e50 = good.filter(x=>x.metrics.aboveEMA50).length, e200 = good.filter(x=>x.metrics.aboveEMA200).length;
        out.textContent = `Market breadth · ${good.length} stocks: advances ${adv}, declines ${dec} (A/D ${dec ? (adv/dec).toFixed(2) : "∞"}) · above EMA 50: ${e50} (${good.length ? (100*e50/good.length).toFixed(1) : 0}%) · above EMA 200: ${e200} (${good.length ? (100*e200/good.length).toFixed(1) : 0}%).`;
      } catch(err) { out.textContent = `Breadth unavailable: ${err.message}`; }
    };
    $("#scClear") &&
      ($("#scClear").onclick = () => {
        sc.scan = null;
        renderScreener();
      });
    $("#scScan").onclick = async () => {
      const [rule] = readRules($("#scRule"));
      sc.rule = rule;
      sc.tf = $("#scTf").value;
      const c = compileRules({ rules: [rule] });
      const prev = sc.scan;
      sc.scan = null;
      const targets = filtered().slice(0, 500).map((r) => r.symbol);
      sc.scan = prev;
      $("#scScan").textContent = `Scanning ${targets.length}…`;
      try {
        const res = await api.post("/api/scan", {
          symbols: targets,
          tf: sc.tf,
          indicators: c.indicators,
          rules: c.rules,
          metrics: true,
          metricFilters: Object.fromEntries(Object.entries(sc.tech).filter(([,v])=>v!=null&&v!=="")),
        });
        sc.scan = Object.fromEntries(res.map((x) => [x.symbol, x]));
        const hits = res.filter((x) => x.pass).length;
        app.toast(`${hits} of ${targets.length} match.`);
      } catch (e) {
        app.toast(e.message, "err");
      }
      renderScreener();
    };
    if (!sc.rows.length) loadScreener();
    else drawScreener();
  }
  function drawScreener() {
    const box = $("#scTable");
    if (!box) return;
    const rows = filtered();
    const withMetrics = !!sc.scan && rows.some((r) => sc.scan[r.symbol]?.metrics);
    const cols = [
      ["ticker", "Symbol"],
      ["name", "Name"],
      ["price", "Price"],
      ["changePct", "Change %"],
      ["volume", sc.universe === "crypto" ? "Volume (USDT)" : "Volume"],
      ...(sc.universe !== "crypto"
        ? [
            ["marketCap", "Market cap"],
            ["sector", "Sector"],
          ]
        : []),
      ...(withMetrics ? [["rsi", "RSI"], ["ema", "vs EMA 50"], ["volumeSpike", "Vol ×"], ["high52DistancePct", "52w high %"], ["supertrendFlip", "ST flip"], ["macdCross", "MACD"]] : []),
    ];
    box.innerHTML = `<table class="t"><thead><tr>${cols.map(([k, l]) => `<th data-k="${k}" class="${k === "name" || k === "sector" ? "l" : ""}">${l}${sc.sort === k ? (sc.dir < 0 ? " ↓" : " ↑") : ""}</th>`).join("")}</tr></thead><tbody>${rows
      .slice(0, sc.visible)
      .map(
        (r) =>
          `<tr data-s="${esc(r.symbol)}"><td><b>${esc(r.ticker)}</b></td><td class="l muted">${esc((r.name || "").slice(0, 40))}</td><td>${formatSymbolPrice(r.symbol, r.price)}</td><td class="${r.changePct >= 0 ? "up" : "down"}">${fmtPct(r.changePct)}</td><td>${fmtNum(r.volume, 0)}</td>${sc.universe !== "crypto" ? `<td>${/^india|nifty|sensex/.test(sc.universe) ? "₹" : ""}${fmtNum(r.marketCap, 0)}</td><td class="l muted">${esc(r.sector || r.exchange || "")}</td>` : ""}${withMetrics ? (()=>{const m=sc.scan[r.symbol]?.metrics||{};return `<td>${Number.isFinite(m.rsi)?m.rsi.toFixed(1):"—"}</td><td>${m.aboveEMA50?"Above":"Below"}</td><td>${Number.isFinite(m.volumeSpike)?`${m.volumeSpike.toFixed(1)}×`:"—"}</td><td>${Number.isFinite(m.high52DistancePct)?`${m.high52DistancePct.toFixed(1)}%`:"—"}</td><td>${esc(m.supertrendFlip||"—")}</td><td>${esc(m.macdCross||"—")}</td>`;})():""}</tr>`,
      )
      .join(
        "",
      )}</tbody></table><div class="pad hint-text">${rows.length} match${rows.length === 1 ? "" : "es"}${rows.length > 500 ? " (showing 500)" : ""}. Click a row to open its chart.${sc.universe === "us" || sc.universe === "etf" ? " Live prices for the 200 largest companies; the rest show the last close." : sc.universe === "india" && rows.some((r) => !r.live) ? " Some prices are last close or unavailable when Yahoo Finance has no quote." : ""}</div>`;
    const note = box.querySelector(".pad.hint-text");
    if (note) {
      const availability = sc.universe === "us" || sc.universe === "etf"
        ? " Live prices cover the 200 largest companies; other rows use last-close data."
        : sc.universe === "india" && rows.some((r) => !r.live)
          ? " Some prices may be delayed or unavailable from Yahoo Finance."
          : "";
      note.textContent = `${rows.length} matches. Showing ${Math.min(rows.length, sc.visible)} of ${rows.length}.${availability} `;
    }
    if (note && rows.length > sc.visible) {
      const more = document.createElement("button");
      more.className = "btn small";
      more.textContent = "Show next 500";
      more.onclick = () => {
        sc.visible += 500;
        drawScreener();
      };
      note.append(more);
    }
    box.querySelector("thead").onclick = (e) => {
      const k = e.target.closest("th")?.dataset.k;
      if (!k) return;
      sc.dir = sc.sort === k ? -sc.dir : -1;
      sc.sort = k;
      drawScreener();
    };
    box.querySelector("tbody").onclick = (e) => {
      const s = e.target.closest("tr")?.dataset.s;
      if (s) app.setSymbol(s);
    };
  }

  // ======================= HEATMAP =======================
  async function renderOptionChain() {
    const current = ticker(app.active?.cfg.symbol || "YAHOO:^NSEI").replace(/\.(NS|BO)$/i, "");
    bottom.innerHTML = `<div class="pad"><div class="row-flex"><label class="field">NSE index or F&amp;O stock<input class="in" id="ocSymbol" value="${esc(["^NSEI", "^NIFTY"].includes(current) ? "NIFTY" : current)}" placeholder="NIFTY, BANKNIFTY, RELIANCE"></label><button class="btn primary" id="ocLoad">Load option chain</button><button class="btn" id="ocBroker">Broker API settings</button><span class="hint-text" id="ocStatus">NSE public data · delayed as published</span></div><div id="ocSummary" class="stats"></div><div id="ocChart" style="height:150px;overflow:hidden"></div><div id="ocTable" style="overflow:auto;max-height:calc(100% - 220px)"></div><p class="hint-text">NSE public endpoints may rate limit or block automated requests. If blocked, configure a broker API in Settings. Option chain availability and freshness depend on the source.</p></div>`;
    const load = async () => {
      const status = $("#ocStatus"), symbol = $("#ocSymbol").value.trim();
      status.textContent = "Loading public NSE option chain…";
      $("#ocTable").innerHTML = "";
      try {
        const d = await api.get(`/api/india/option-chain?symbol=${encodeURIComponent(symbol)}${status.dataset.source === "broker" ? "&source=broker" : ""}`);
        status.dataset.source = "";
        status.textContent = `${d.source} · ${new Date(d.asOf).toLocaleTimeString()} · ${d.expiry || "current expiry"}`;
        $("#ocSummary").innerHTML = [["Underlying", d.underlying == null ? "—" : `₹${fmtPrice(d.underlying)}`], ["PCR (OI)", d.pcr == null ? "—" : d.pcr.toFixed(2)], ["Max pain", d.maxPain == null ? "—" : `₹${fmtPrice(d.maxPain)}`], ["Expiry", d.expiry || "—"]].map(([k,v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("");
        const max = Math.max(1, ...d.strikes.flatMap((r) => [r.call?.oi || 0, r.put?.oi || 0]));
        $("#ocChart").innerHTML = `<div style="display:flex;height:100%;align-items:end;gap:2px;padding:10px 2px">${d.strikes.map((r) => `<div title="${r.strike}: CE ${fmtNum(r.call?.oi || 0,0)} / PE ${fmtNum(r.put?.oi || 0,0)}" style="display:flex;align-items:end;gap:1px;flex:1;height:100%"><i style="height:${Math.max(2,(r.call?.oi||0)/max*100)}%;background:#ef5350;flex:1"></i><i style="height:${Math.max(2,(r.put?.oi||0)/max*100)}%;background:#26a69a;flex:1"></i></div>`).join("")}</div><div class="hint-text">Open interest by strike · <span class="down">Calls</span> / <span class="up">Puts</span></div>`;
        $("#ocTable").innerHTML = `<table class="t"><thead><tr><th colspan="4">CALLS</th><th>STRIKE</th><th colspan="4">PUTS</th></tr><tr><th>OI</th><th>Change OI</th><th>IV</th><th>LTP</th><th></th><th>LTP</th><th>IV</th><th>Change OI</th><th>OI</th></tr></thead><tbody>${d.strikes.map((r) => `<tr><td>${fmtNum(r.call?.oi||0,0)}</td><td>${fmtNum(r.call?.changeOi||0,0)}</td><td>${fmtNum(r.call?.iv||0,2)}</td><td>₹${fmtPrice(r.call?.ltp)}</td><td><b>${fmtNum(r.strike,2)}</b></td><td>₹${fmtPrice(r.put?.ltp)}</td><td>${fmtNum(r.put?.iv||0,2)}</td><td>${fmtNum(r.put?.changeOi||0,0)}</td><td>${fmtNum(r.put?.oi||0,0)}</td></tr>`).join("")}</tbody></table>`;
      } catch (e) {
        status.textContent = "NSE public data unavailable";
        $("#ocSummary").innerHTML = `<div class="hint-text down">${esc(e.message)} <button class="btn small" id="ocTryBroker">Try configured broker</button> <button class="btn small" id="ocBrokerErr">Broker API settings</button></div>`;
        $("#ocBrokerErr").onclick = () => app.openSettings();
        $("#ocTryBroker").onclick = () => { status.dataset.source = "broker"; load(); };
      }
    };
    $("#ocLoad").onclick = load;
    $("#ocBroker").onclick = () => app.openSettings();
    load();
  }

  async function renderIndiaFlows() {
    bottom.innerHTML = '<div class="pad"><div class="row-flex"><button class="btn primary" id="ifLoad">Refresh NSE/BSE reports</button><span class="hint-text" id="ifStatus">Public exchange reports · refresh on demand</span></div><div id="ifData" class="hint-text" style="margin-top:12px">Loading reports…</div></div>';
    const fmt = (v) => {
      if (Array.isArray(v)) {
        if (!v.length) return '<p class="hint-text">No rows reported.</p>';
        if (typeof v[0] !== "object") return `<pre>${esc(JSON.stringify(v, null, 2))}</pre>`;
        const keys = [...new Set(v.slice(0, 100).flatMap((r) => Object.keys(r)))].slice(0, 10);
        return `<div style="overflow:auto;max-height:330px"><table class="t"><thead><tr>${keys.map((k) => `<th>${esc(k)}</th>`).join("")}</tr></thead><tbody>${v.slice(0, 100).map((r) => `<tr>${keys.map((k) => `<td>${esc(r[k] == null ? "" : typeof r[k] === "object" ? JSON.stringify(r[k]) : r[k])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
      }
      if (v && typeof v === "object") {
        const arr = Object.values(v).find(Array.isArray);
        return arr ? fmt(arr) : `<pre>${esc(JSON.stringify(v, null, 2))}</pre>`;
      }
      return '<p class="hint-text">No report returned.</p>';
    };
    const load = async () => {
      $("#ifStatus").textContent = "Fetching public reports…";
      try {
        const d = await api.get("/api/india/flows");
        $("#ifStatus").textContent = `Updated ${new Date(d.asOf).toLocaleString()}`;
        $("#ifData").innerHTML = `<h3>FII/FPI &amp; DII activity</h3>${d.fiiDii ? fmt(d.fiiDii) : '<p class="hint-text">The NSE FII/DII report could not be loaded.</p>'}<h3>NSE bulk/block deals</h3>${d.nseDeals ? fmt(d.nseDeals) : '<p class="hint-text">NSE deal report unavailable.</p>'}<h3>BSE bulk deals</h3>${d.bseDeals ? fmt(d.bseDeals) : '<p class="hint-text">BSE deal report unavailable.</p>'}${d.errors?.length ? `<h3>Source messages</h3><ul>${d.errors.map((x) => `<li class="hint-text">${esc(x)}</li>`).join("")}</ul>` : ""}<p class="hint-text">Sources: <a target="_blank" rel="noreferrer" href="https://www.nseindia.com/reports/fii-dii">NSE FII/DII</a>, NSE public large-deals reports, and <a target="_blank" rel="noreferrer" href="https://www.bseindia.com/markets/equity/EQReports/bulk_deals.aspx">BSE bulk deals</a>.</p>`;
      } catch (e) { $("#ifStatus").textContent = e.message; $("#ifData").innerHTML = `<p class="down">${esc(e.message)}</p>`; }
    };
    $("#ifLoad").onclick = load;
    await load();
  }

  // ======================= HEATMAP =======================
  const hm = { universe: "nifty50", size: "marketCap", colorBy: "changePct", groupBy: "sector" };
  async function renderHeatmap() {
    bottom.innerHTML = `<div class="pad row-flex"><label class="field">Market<select id="hmU"><option value="nifty50">Nifty 50</option><option value="sensex">S&amp;P BSE Sensex</option><option value="nifty500">Nifty 500</option><option value="niftynext50">Nifty Next 50</option><option value="india">All India companies</option><option value="us">US stocks (200 largest)</option><option value="crypto">Crypto (100 most traded)</option></select></label><label class="field">Size by<select id="hmS"><option value="marketCap">Market cap</option><option value="volume">Volume</option></select></label><label class="field">Color by<select id="hmCBy"><option value="changePct">Change %</option><option value="volume">Volume</option><option value="price">Price</option></select></label><label class="field">Group by<select id="hmG"><option value="sector">Sector</option><option value="exchange">Exchange</option><option value="none">None</option></select></label><span class="hint-text" style="align-self:end">Tile area, color scale, and grouping update the map. Hover for details; click a tile to open its chart.</span></div><div class="heatmap-wrap" style="height:calc(100% - 76px)"><canvas id="hmC"></canvas></div>`;
    $("#hmU").value = hm.universe;
    $("#hmS").value = hm.size;
    $("#hmCBy").value = hm.colorBy;
    $("#hmG").value = hm.groupBy;
    $("#hmU").onchange = (e) => {
      hm.universe = e.target.value;
      renderHeatmap();
    };
    $("#hmS").onchange = (e) => {
      hm.size = e.target.value;
      drawHeatmap();
    };
    $("#hmCBy").onchange = (e) => { hm.colorBy = e.target.value; drawHeatmap(); };
    $("#hmG").onchange = (e) => { hm.groupBy = e.target.value; drawHeatmap(); };
    try {
      const rows = await api.get(`/api/screener?universe=${hm.universe}`);
      const indiaMarkets = ["india", "nifty50", "nifty100", "nifty500", "niftynext50", "sensex"];
      hm.rows =
        hm.universe === "us"
          ? rows
              .filter((r) => r.marketCap > 0)
              .sort((a, b) => b.marketCap - a.marketCap)
              .slice(0, 200)
          : indiaMarkets.includes(hm.universe)
            ? rows.filter((r) => r.ticker).sort((a, b) => (b.marketCap || b.sizeValue || 0) - (a.marketCap || a.sizeValue || 0)).slice(0, hm.universe === "india" ? rows.length : 500)
            : rows.sort((a, b) => b.volume - a.volume).slice(0, 100);
      drawHeatmap();
    } catch (e) {
      app.toast(e.message, "err");
    }
  }
  function squarify(items, x, y, w, h) {
    const out = [];
    let rest = items.filter((i) => i.value > 0);
    const total = rest.reduce((a, i) => a + i.value, 0);
    if (!total) return out;
    const scale = (w * h) / total;
    let rx = x,
      ry = y,
      rw = w,
      rh = h;
    while (rest.length) {
      const short = Math.min(rw, rh);
      const row = [];
      let best = Infinity;
      for (const it of rest) {
        const test = [...row, it];
        const s = test.reduce((a, i) => a + i.value * scale, 0);
        const max = Math.max(...test.map((i) => i.value * scale)),
          min = Math.min(...test.map((i) => i.value * scale));
        const worst = Math.max(
          (short * short * max) / (s * s),
          (s * s) / (short * short * min),
        );
        if (worst > best) break;
        best = worst;
        row.push(it);
      }
      const area = row.reduce((a, i) => a + i.value * scale, 0);
      const thick = area / short;
      let off = 0;
      for (const it of row) {
        const len = (it.value * scale) / thick;
        if (rw >= rh) out.push({ ...it, x: rx, y: ry + off, w: thick, h: len });
        else out.push({ ...it, x: rx + off, y: ry, w: len, h: thick });
        off += len;
      }
      if (rw >= rh) {
        rx += thick;
        rw -= thick;
      } else {
        ry += thick;
        rh -= thick;
      }
      rest = rest.slice(row.length);
    }
    return out;
  }
  function drawHeatmap() {
    const c = $("#hmC");
    if (!c || !hm.rows) return;
    const dpr = window.devicePixelRatio || 1,
      W = c.clientWidth,
      H = c.clientHeight;
    c.width = W * dpr;
    c.height = H * dpr;
    const ctx = c.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    const cap = hm.universe === "crypto" ? 8 : 3;
    const color = (ch) => {
      const t = Math.max(-1, Math.min(1, ch / cap));
      const base = [66, 69, 80],
        up = [8, 153, 129],
        dn = [242, 54, 69];
      const tgt = t >= 0 ? up : dn,
        k = Math.abs(t);
      return `rgb(${base.map((b, i) => Math.round(b + (tgt[i] - b) * k)).join(",")})`;
    };
    const val = (r) =>
      Math.max(
        1,
        hm.size === "volume"
          ? r.volume * (hm.universe === "crypto" ? 1 : r.price || 0)
          : r.marketCap || r.sizeValue || r.volume,
      );
    let tiles = [];
    if (["us", "india", "nifty50", "nifty100", "nifty500", "niftynext50", "sensex"].includes(hm.universe) && hm.groupBy !== "none") {
      const bySector = {};
      const sectorFor = (r) => hm.groupBy === "exchange" ? (r.exchange || "Other") : (r.sector && r.sector !== "Other" ? r.sector : ({ "ADANIENT":"Conglomerates", "ADANIPORTS":"Infrastructure", "APOLLOHOSP":"Healthcare", "ASIANPAINT":"Consumer", "AXISBANK":"Financials", "BAJAJ-AUTO":"Automobiles", "BAJFINANCE":"Financials", "BAJAJFINSV":"Financials", "BEL":"Industrials", "BHARTIARTL":"Telecom", "CIPLA":"Healthcare", "COALINDIA":"Energy", "DRREDDY":"Healthcare", "EICHERMOT":"Automobiles", "ETERNAL":"Consumer", "GRASIM":"Materials", "HCLTECH":"Information Technology", "HDFCBANK":"Financials", "HDFCLIFE":"Financials", "HEROMOTOCO":"Automobiles", "HINDALCO":"Materials", "HINDUNILVR":"Consumer", "ICICIBANK":"Financials", "INDUSINDBK":"Financials", "INFY":"Information Technology", "ITC":"Consumer", "JIOFIN":"Financials", "JSWSTEEL":"Materials", "KOTAKBANK":"Financials", "LT":"Industrials", "M&M":"Automobiles", "MARUTI":"Automobiles", "NESTLEIND":"Consumer", "NTPC":"Utilities", "ONGC":"Energy", "POWERGRID":"Utilities", "RELIANCE":"Energy", "SBILIFE":"Financials", "SBIN":"Financials", "SHRIRAMFIN":"Financials", "SUNPHARMA":"Healthcare", "TATACONSUM":"Consumer", "TATASTEEL":"Materials", "TCS":"Information Technology", "TECHM":"Information Technology", "TITAN":"Consumer", "TRENT":"Retail", "ULTRACEMCO":"Materials", "WIPRO":"Information Technology" }[r.ticker] || "Other"));
      for (const r of hm.rows) (bySector[sectorFor(r)] ||= []).push(r);
      const groups = Object.entries(bySector)
        .map(([name, rs]) => ({
          name,
          value: rs.reduce((a, r) => a + val(r), 0),
          rs,
        }))
        .sort((a, b) => b.value - a.value);
      for (const g of squarify(groups, 0, 0, W, H)) {
        const headerH = Math.min(15, Math.max(0, g.h - 3));
        if (g.w < 4 || g.h < 4) continue;
        const inner = squarify(
          g.rs
            .map((r) => ({ ...r, value: val(r) }))
            .sort((a, b) => b.value - a.value),
          g.x + 1,
          g.y + headerH,
          g.w - 2,
          g.h - headerH - 1,
        );
        tiles.push(...inner);
        ctx.fillStyle = css("--panel");
        ctx.fillRect(g.x, g.y, g.w, g.h);
        ctx.fillStyle = css("--muted");
        ctx.font = "600 10px -apple-system, Segoe UI, sans-serif";
        ctx.textBaseline = "top";
        if (g.w > 50 && g.h > 10)
          ctx.fillText(
            g.name.toUpperCase().slice(0, Math.floor(g.w / 7)),
            g.x + 4,
            g.y + 2,
          );
      }
    } else
      tiles = squarify(
        hm.rows
          .map((r) => ({ ...r, value: val(r) }))
          .sort((a, b) => b.value - a.value),
        0,
        0,
        W,
        H,
      );
    const sortedVolumes = hm.rows.map((r) => Math.max(0, Number(r.volume) || 0)).sort((a, b) => a - b);
    const medianVolume = sortedVolumes[Math.floor(sortedVolumes.length / 2)] || 1;
    const prices = hm.rows.map((r) => Number(r.price) || 0).filter((p) => p > 0);
    const minPrice = Math.min(...prices), maxPrice = Math.max(...prices);
    const colorMetric = (r) => hm.colorBy === "volume" ? Math.max(-3, Math.min(3, Math.log2((Number(r.volume) || 1) / medianVolume))) : hm.colorBy === "price" ? (maxPrice > minPrice ? ((Number(r.price) - minPrice) / (maxPrice - minPrice) * 6 - 3) : 0) : (Number(r.changePct) || 0);
    const colorCap = hm.colorBy === "changePct" ? (hm.universe === "crypto" ? 8 : 3) : 3;
    for (const t of tiles) {
      ctx.fillStyle = color(colorMetric(t) * (3 / colorCap));
      ctx.fillRect(t.x + 0.5, t.y + 0.5, t.w - 1, t.h - 1);
      if (t.w > 23 && t.h > 15) {
        const fs = Math.max(8, Math.min(20, Math.sqrt(t.w * t.h) / 5));
        const cx = t.x + t.w / 2, cy = t.y + t.h / 2;
        ctx.save();
        ctx.beginPath();
        ctx.rect(t.x + 2, t.y + 2, t.w - 4, t.h - 4);
        ctx.clip();
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = `700 ${fs}px -apple-system, Segoe UI, sans-serif`;
        const maxChars = Math.max(3, Math.floor((t.w - 8) / (fs * 0.58)));
        const name = t.ticker.replace(/USDT$/, "");
        ctx.fillText(name.length > maxChars ? `${name.slice(0, maxChars - 1)}…` : name, cx, t.h > 40 ? cy - fs * 0.55 : cy);
        if (t.h > 30) {
          ctx.font = `600 ${Math.max(8, fs * 0.8)}px -apple-system, Segoe UI, sans-serif`;
          ctx.fillText(fmtPct(t.changePct), cx, t.h > 55 ? cy + fs * 1.1 : cy + fs * 0.75);
        }
        const isIndian = ["india", "nifty50", "nifty100", "nifty500", "niftynext50", "sensex"].includes(hm.universe);
        if (isIndian && t.w > 75 && t.h > 55 && t.price > 0) {
          ctx.font = `500 ${Math.max(8, fs * 0.72)}px -apple-system, Segoe UI, sans-serif`;
          ctx.fillText(`₹${fmtPrice(t.price)}`, cx, cy + fs * 2.2);
        }
        ctx.restore();
        ctx.textAlign = "left";
      }
    }
    hm.tiles = tiles;
    let tip = document.querySelector(".tip");
    c.onmousemove = (e) => {
      const r = c.getBoundingClientRect(),
        x = e.clientX - r.left,
        y = e.clientY - r.top;
      const t = tiles.find(
        (q) => x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h,
      );
      if (!t) {
        tip?.remove();
        tip = null;
        return;
      }
      if (!tip) {
        tip = document.createElement("div");
        tip.className = "tip";
        document.body.appendChild(tip);
      }
      const indianMap = ["india", "nifty50", "nifty100", "nifty500", "niftynext50", "sensex"].includes(hm.universe);
      tip.innerHTML = `<b>${esc(t.ticker)}</b> ${esc(t.name || "")}<br>${formatSymbolPrice(t.symbol, t.price)} <span class="${t.changePct >= 0 ? "up" : "down"}">${fmtPct(t.changePct)}</span>${t.marketCap ? `<br>Market cap ${indianMap ? "₹" : ""}${fmtNum(t.marketCap)}` : t.sizeValue ? `<br>Size estimate ${indianMap ? "₹" : ""}${fmtNum(t.sizeValue)}` : ""}${t.sector ? `<br>${esc(t.sector)}` : ""}`;
      tip.style.left = `${e.clientX + 14}px`;
      tip.style.top = `${e.clientY + 14}px`;
    };
    c.onmouseleave = () => {
      tip?.remove();
      tip = null;
    };
    c.onclick = (e) => {
      const r = c.getBoundingClientRect(),
        x = e.clientX - r.left,
        y = e.clientY - r.top;
      const t = tiles.find(
        (q) => x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h,
      );
      if (t) app.setSymbol(t.symbol);
    };
  }
  window.addEventListener("resize", () => {
    if (bottomTab === "heatmap") drawHeatmap();
  });

  // ======================= PAPER TRADING =======================
  // While the active chart is in bar replay, paper trading uses a separate practice account that
  // fills at the replayed bar's prices, so replay trades never mix with the live paper account.
  const replayPane = () => (app.active?.replay ? app.active : null);
  const freshAccount = (sym) => ({ initial: 100000, cash: 100000, feePct: 0.05, charges: { brokeragePct: 0.03, sttPct: 0.025, exchangePct: 0.00325, gstPct: 18, sebiPct: 0.0001, stampPct: 0.003 }, currency: isIndianSymbol(sym) ? "INR" : "USD", positions: {}, orders: [], history: [], equityCurve: [] });
  const livePaper = (indian = false) => {
    const key = indian ? "paperINR" : "paper";
    const p = (app.state[key] ||= {
      initial: 100000,
      cash: 100000,
      feePct: 0.05,
      charges: { brokeragePct: 0.03, sttPct: 0.025, exchangePct: 0.00325, gstPct: 18, sebiPct: 0.0001, stampPct: 0.003 },
      currency: indian ? "INR" : "USD",
      positions: {},
      orders: [],
      history: [],
    });
    // Existing saved paper accounts predate the currency field and are treated as USD.
    p.currency ||= indian ? "INR" : "USD";
    p.charges ||= { brokeragePct: 0.03, sttPct: 0.025, exchangePct: 0.00325, gstPct: 18, sebiPct: 0.0001, stampPct: 0.003 };
    p.equityCurve ||= [];
    return p;
  };
  const accountForSymbol = (sym, create = true) => {
    const rp = replayPane();
    if (rp && sym === rp.cfg.symbol) {
      const account = create ? (app.state.replayPaper ||= freshAccount(sym)) : app.state.replayPaper;
      if (account) {
        account.currency ||= isIndianSymbol(sym) ? "INR" : "USD";
        account.charges ||= { brokeragePct: 0.03, sttPct: 0.025, exchangePct: 0.00325, gstPct: 18, sebiPct: 0.0001, stampPct: 0.003 };
        account.equityCurve ||= [];
      }
      return account;
    }
    const indian = isIndianSymbol(sym);
    return create ? livePaper(indian) : app.state[indian ? "paperINR" : "paper"];
  };
  const paper = () => accountForSymbol(app.active?.cfg.symbol || "");
  const cash = (value, account) => `${account.currency === "INR" ? "₹" : "$"}${fmtPrice(value)}`;
  const priceText = (sym, value) => formatSymbolPrice(sym, value);
  const price = (s) => {
    const rp = replayPane();
    if (rp && s === rp.cfg.symbol) return rp.bars[rp.replay.index]?.close;
    return rp ? null : app.prices[s];
  };
  function paperSymbols() {
    return [app.state.paper, app.state.paperINR, app.state.replayPaper]
      .filter(Boolean)
      .flatMap((p) => [...Object.keys(p.positions || {}), ...(p.orders || []).map((o) => o.symbol)]);
  }
  function fill(sym, side, qty, px, note = "", acct = null) {
    const p = acct || accountForSymbol(sym);
    const activeReplay = replayPane();
    const rp = activeReplay && activeReplay.cfg.symbol === sym ? activeReplay : null;
    const signed = side === "buy" ? qty : -qty;
    const pos = p.positions[sym] || { qty: 0, avg: 0 };
    const turnover = Math.abs(qty * px);
    const c = p.currency === "INR" ? p.charges : null;
    const brokerage = c ? turnover * (Number(c.brokeragePct || 0) / 100) : turnover * (p.feePct / 100);
    const other = c ? turnover * ((Number(c.sttPct || 0) + Number(c.exchangePct || 0) + Number(c.sebiPct || 0) + Number(c.stampPct || 0)) / 100) + brokerage * (Number(c.gstPct || 0) / 100) : 0;
    const fee = brokerage + other;
    let realized = 0;
    if (pos.qty !== 0 && Math.sign(pos.qty) !== Math.sign(signed)) {
      const closing =
        Math.sign(signed) * Math.min(Math.abs(signed), Math.abs(pos.qty));
      realized = -closing * (px - pos.avg);
    }
    const nq = pos.qty + signed;
    if (nq === 0) delete p.positions[sym];
    else if (pos.qty === 0 || Math.sign(nq) !== Math.sign(pos.qty))
      p.positions[sym] = { qty: nq, avg: px };
    else if (Math.sign(signed) === Math.sign(pos.qty))
      p.positions[sym] = {
        qty: nq,
        avg: (pos.qty * pos.avg + signed * px) / nq,
      };
    else p.positions[sym] = { qty: nq, avg: pos.avg };
    p.cash -= signed * px + fee;
    p.history.unshift({
      time: rp ? rp.bars[rp.replay.index].time * 1000 : Date.now(),
      symbol: sym,
      side,
      qty,
      price: px,
      fee,
      realized: realized - fee,
      note,
    });
    p.history = p.history.slice(0, 500);
    const marked = p.cash + Object.entries(p.positions).reduce((sum, [s, x]) => sum + x.qty * (price(s) ?? x.avg), 0);
    p.equityCurve.push({ time: rp ? rp.bars[rp.replay.index].time : Math.floor(Date.now() / 1000), value: marked });
    p.equityCurve = p.equityCurve.slice(-500);
    app.persist();
    app.toast(
      `Paper ${side} ${fmtNum(qty, 4)} ${ticker(sym)} at ${priceText(sym, px)}`,
    );
  }
  function checkOrders(sym, px) {
    const p = accountForSymbol(sym, false);
    if (!p?.orders.length) return;
    let changed = false;
    for (const o of [...p.orders]) {
      if (o.symbol !== sym) continue;
      const hit =
        o.type === "limit"
          ? o.side === "buy"
            ? px <= o.price
            : px >= o.price
          : o.side === "buy"
            ? px >= o.price
            : px <= o.price;
      if (!hit) continue;
      p.orders = p.orders.filter((x) => x !== o && (!o.oco || x.oco !== o.oco));
      fill(
        sym,
        o.side,
        o.qty,
        o.type === "limit" ? o.price : px,
        o.note || `${o.type} order`,
        p,
      );
      changed = true;
    }
    if (changed && bottomTab === "paper") renderPaper();
  }
  app.priceListeners.add((sym, px) => {
    checkOrders(sym, px);
    if (
      bottomTab === "paper" &&
      !bottomEl.classList.contains("collapsed") &&
      paper().positions[sym]
    )
      drawPaperNumbers();
  });
  function equity() {
    const p = paper();
    return (
      p.cash +
      Object.entries(p.positions).reduce(
        (a, [s, pos]) => a + pos.qty * (price(s) ?? pos.avg),
        0,
      )
    );
  }
  function drawPaperNumbers() {
    const p = paper();
    const eq = equity();
    const el = $("#ppEq");
    if (el) {
      el.innerHTML = `<div class="stat"><div class="k">Equity</div><div class="v">${cash(eq, p)}</div></div><div class="stat"><div class="k">Cash</div><div class="v">${cash(p.cash, p)}</div></div><div class="stat"><div class="k">Total P&amp;L</div><div class="v ${eq >= p.initial ? "up" : "down"}">${cash(eq - p.initial, p)} (${fmtPct(((eq - p.initial) / p.initial) * 100)})</div></div>`;
    }
    const pos = $("#ppPos");
    if (pos) {
      pos.innerHTML =
        Object.entries(p.positions)
          .map(([s, x]) => {
            const px = price(s) ?? x.avg,
              pnl = x.qty * (px - x.avg);
            return `<tr data-s="${esc(s)}"><td><b>${esc(ticker(s))}</b></td><td>${x.qty > 0 ? "Long" : "Short"}</td><td>${fmtNum(Math.abs(x.qty), 4)}</td><td>${priceText(s, x.avg)}</td><td>${priceText(s, px)}</td><td class="${pnl >= 0 ? "up" : "down"}">${cash(pnl, p)} (${fmtPct(((px - x.avg) / x.avg) * 100 * Math.sign(x.qty))})</td><td><button class="btn small" data-close="${esc(s)}">Close</button></td></tr>`;
          })
          .join("") ||
        '<tr><td colspan="7" class="l muted">No open positions.</td></tr>';
    }
  }
  function renderPaper() {
    const p = paper();
    const sym = app.active?.cfg.symbol || "";
    const px = price(sym) ?? app.active?.bars.at(-1)?.close;
    const unit = p.currency === "INR" ? "₹" : "$";
    bottom.innerHTML = `<div class="tester"><div class="left">
      <h4 style="margin-top:0">Order ticket · ${esc(ticker(sym))} ${px ? `<span class="muted">${priceText(sym, px)}</span>` : ""}</h4>
      <div class="row-flex"><label class="field">Type<select id="ppType"><option value="market">Market</option><option value="limit">Limit</option><option value="stop">Stop</option></select></label><label class="field">Price<input id="ppPrice" type="number" step="any" value="${px ? Number(px.toPrecision(6)) : ""}" style="width:110px"></label><label class="field">Amount (${unit})<input id="ppAmt" type="number" step="any" value="1000" style="width:100px"></label></div>
      <div class="row-flex" style="margin-top:6px"><label class="field">Stop loss % (optional)<input id="ppSl" type="number" step="any" style="width:90px"></label><label class="field">Take profit % (optional)<input id="ppTp" type="number" step="any" style="width:90px"></label></div>
      <div class="row-flex" style="margin-top:10px"><button class="btn primary" id="ppBuy" style="background:var(--up);border-color:var(--up)">Buy</button><button class="btn primary" id="ppSell" style="background:var(--down);border-color:var(--down)">Sell / short</button></div>
      <h4>Account</h4><div class="row-flex"><label class="field">Starting balance (${unit})<input id="ppInit" type="number" value="${p.initial}" style="width:110px"></label>${p.currency === "INR" ? `<label class="field">Brokerage %<input data-charge="brokeragePct" type="number" step="any" value="${p.charges.brokeragePct}" style="width:80px"></label><label class="field">STT %<input data-charge="sttPct" type="number" step="any" value="${p.charges.sttPct}" style="width:80px"></label><label class="field">Exchange %<input data-charge="exchangePct" type="number" step="any" value="${p.charges.exchangePct}" style="width:80px"></label><label class="field">GST %<input data-charge="gstPct" type="number" step="any" value="${p.charges.gstPct}" style="width:80px"></label><label class="field">SEBI %<input data-charge="sebiPct" type="number" step="any" value="${p.charges.sebiPct}" style="width:80px"></label><label class="field">Stamp duty %<input data-charge="stampPct" type="number" step="any" value="${p.charges.stampPct}" style="width:80px"></label>` : `<label class="field">Fee % per trade<input id="ppFee" type="number" step="any" value="${p.feePct}" style="width:80px"></label>`}<button class="btn danger" id="ppReset" style="align-self:end">Reset account</button></div><div class="equity" id="ppEquity" style="height:120px;margin-top:8px"></div>
      <p class="hint-text">${replayPane() ? `<b>Replay trading.</b> Orders fill at the replayed bars' prices in a separate practice account. Step or play the replay to fill limit and stop orders. Exit replay to go back to your live paper account.` : "Simulated fills at the live price. No real money, no exchange connection."}</p>
    </div><div class="right"><div class="stats" id="ppEq"></div>
      <h4>Positions</h4><table class="t"><thead><tr><th>Symbol</th><th>Side</th><th>Qty</th><th>Avg price</th><th>Last</th><th>P&amp;L</th><th></th></tr></thead><tbody id="ppPos"></tbody></table>
      <h4>Working orders</h4><table class="t"><thead><tr><th>Symbol</th><th>Side</th><th>Type</th><th>Price</th><th>Qty</th><th></th></tr></thead><tbody>${p.orders.map((o) => `<tr><td><b>${esc(ticker(o.symbol))}</b></td><td>${o.side}</td><td>${o.type}${o.oco ? " (bracket)" : ""}</td><td>${priceText(o.symbol, o.price)}</td><td>${fmtNum(o.qty, 4)}</td><td><button class="btn small" data-cancel="${o.id}">Cancel</button></td></tr>`).join("") || '<tr><td colspan="6" class="l muted">None.</td></tr>'}</tbody></table>
      <h4>History</h4><table class="t"><thead><tr><th>Time</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Price</th><th>Realised</th></tr></thead><tbody>${p.history
        .slice(0, 100)
        .map(
          (h) =>
            `<tr><td>${new Date(h.time).toLocaleString()}</td><td>${esc(ticker(h.symbol))}</td><td>${h.side}</td><td>${fmtNum(h.qty, 4)}</td><td>${priceText(h.symbol, h.price)}</td><td class="${h.realized >= 0 ? "up" : "down"}">${h.realized ? cash(h.realized, p) : ""}</td></tr>`,
        )
        .join("")}</tbody></table>
    </div></div>`;
    drawPaperNumbers();
    drawPaperEquity(p);
    const place = async (side) => {
      const type = $("#ppType").value,
        amt = Number($("#ppAmt").value);
      let cur = price(sym) ?? app.active?.bars.at(-1)?.close;
      if (!cur) {
        try {
          cur = (await api.quotes([sym]))[sym]?.price;
        } catch {
          /* none */
        }
      }
      if (!cur || !(amt > 0))
        return app.toast("Need a live price and an amount.", "err");
      const qty = amt / cur;
      const sl = Number($("#ppSl").value),
        tp = Number($("#ppTp").value);
      const entry = type === "market" ? cur : Number($("#ppPrice").value);
      const exitSide = side === "buy" ? "sell" : "buy",
        dir = side === "buy" ? 1 : -1;
      const addBracket = () => {
        const oco = sl > 0 && tp > 0 ? `oco${Date.now()}` : null;
        if (sl > 0)
          paper().orders.push({
            id: `o${Date.now()}s`,
            symbol: sym,
            side: exitSide,
            type: "stop",
            price: entry * (1 - (dir * sl) / 100),
            qty,
            oco,
            note: "stop loss",
          });
        if (tp > 0)
          paper().orders.push({
            id: `o${Date.now()}t`,
            symbol: sym,
            side: exitSide,
            type: "limit",
            price: entry * (1 + (dir * tp) / 100),
            qty,
            oco,
            note: "take profit",
          });
      };
      if (type === "market") {
        fill(sym, side, qty, cur);
        addBracket();
      } else {
        if (!(entry > 0)) return app.toast("Set a price for the order.", "err");
        paper().orders.push({
          id: `o${Date.now()}`,
          symbol: sym,
          side,
          type,
          price: entry,
          qty: amt / entry,
        });
        addBracket();
        app.toast(`${type} ${side} order placed.`);
      }
      app.persist();
      renderPaper();
      refreshQuotes();
    };
    $("#ppBuy").onclick = () => place("buy");
    $("#ppSell").onclick = () => place("sell");
    $("#ppReset").onclick = () => {
      if (
        !confirm(
          "Reset the paper account? Positions, orders and history are cleared.",
        )
      )
        return;
      const key = replayPane() ? "replayPaper" : isIndianSymbol(sym) ? "paperINR" : "paper";
      app.state[key] = {
        initial: Number($("#ppInit").value) || 100000,
        cash: Number($("#ppInit").value) || 100000,
        feePct: Number($("#ppFee")?.value) || p.feePct || 0,
        charges: p.charges,
        currency: unit === "₹" ? "INR" : "USD",
        positions: {},
        orders: [],
        history: [],
        equityCurve: [],
      };
      app.persist();
      renderPaper();
    };
    $("#ppFee").onchange = (e) => {
      paper().feePct = Number(e.target.value) || 0;
      app.persist();
    };
    bottom.querySelectorAll("[data-charge]").forEach((el) => el.addEventListener("change", () => {
      paper().charges[el.dataset.charge] = Number(el.value) || 0;
      app.persist();
    }));
    bottom.onclick = (e) => {
      const close = e.target.closest("[data-close]")?.dataset.close;
      if (close) {
        const pos = paper().positions[close];
        const px2 = price(close) ?? pos.avg;
        fill(
          close,
          pos.qty > 0 ? "sell" : "buy",
          Math.abs(pos.qty),
          px2,
          "closed",
          paper(),
        );
        paper().orders = paper().orders.filter((o) => o.symbol !== close);
        app.persist();
        renderPaper();
      }
      const cancel = e.target.closest("[data-cancel]")?.dataset.cancel;
      if (cancel) {
        paper().orders = paper().orders.filter((o) => o.id !== cancel);
        app.persist();
        renderPaper();
      }
    };
  }

  function drawPaperEquity(account) {
    const el = $("#ppEquity");
    if (!el) return;
    const values = [account.initial, ...(account.equityCurve || []).map((x) => x.value)];
    if (values.length < 2) {
      el.innerHTML = '<div class="hint-text">Equity curve will appear after your first paper trade.</div>';
      return;
    }
    const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
    const points = values.map((v, i) => `${(i / (values.length - 1)) * 100},${96 - ((v - min) / span) * 88}`).join(" ");
    el.innerHTML = `<svg viewBox="0 0 100 100" preserveAspectRatio="none" style="width:100%;height:100%" aria-label="Paper trading equity curve"><polyline points="${points}" fill="none" stroke="${values.at(-1) >= account.initial ? "#26a69a" : "#ef5350"}" stroke-width="1.5" vector-effect="non-scaling-stroke" /></svg>`;
  }

  // ======================= INDICATOR EDITOR =======================
  const TEMPLATE = `export default {
  name: 'EMA ribbon squeeze',
  overlay: true, // true = drawn on the price chart, false = its own pane
  inputs: [
    { key: 'fast', label: 'Fast EMA', type: 'int', default: 8 },
    { key: 'slow', label: 'Slow EMA', type: 'int', default: 34 },
  ],
  outputs: [
    { key: 'fast', label: 'Fast', kind: 'line', color: '#26a69a' },
    { key: 'slow', label: 'Slow', kind: 'line', color: '#ef5350' },
  ],
  // bars: [{ time, open, high, low, close, volume }], p: your inputs,
  // ta: sma, ema, rma, wma, hma, rsi, atr, stdev, highest, lowest, crossover, crossunder, source, compute(...)
  calc(bars, p, ta) {
    const close = ta.source(bars, 'close');
    const fast = ta.ema(close, p.fast), slow = ta.ema(close, p.slow);
    const up = ta.crossover(fast, slow);
    return {
      fast,
      slow,
      markers: bars.filter((b, i) => up[i]).map((b) => ({ time: b.time, position: 'belowBar', shape: 'arrowUp', color: '#26a69a', text: 'Cross' })),
    };
  },
};
`;
  let edFile = null;
  const edListHtml = (list) =>
    list.map((c) => `<div class="card" data-file="${esc(c.file)}"><div class="top"><span>${esc(c.file)}</span><span class="row-flex"><button class="btn small" data-act="open">Edit</button><button class="btn small" data-act="add">Add to chart</button><button class="btn small danger" data-act="del">Delete</button></span></div>${c.error ? `<div class="sub down" style="white-space:pre-line">${esc(c.error)}</div>` : ""}</div>`).join("") || '<p class="hint-text">None yet.</p>';
  async function renderEditor() {
    let list = [];
    try {
      list = await api.get("/api/custom");
    } catch {
      /* none */
    }
    bottom.innerHTML = `<div class="tester"><div class="left"><div class="row-flex"><button class="btn primary" id="edNew">New indicator</button></div>
      <h4>Your indicators</h4><div id="edList">${edListHtml(list)}</div>
      <p class="hint-text">Each indicator is a small JavaScript file in the app's <code>custom</code> folder, in the format in <code>docs/custom-indicators.md</code> (start from <code>docs/indicator-template.js</code>). Indicators use the active chart bars, including NSE and BSE stocks. Each one is checked before it's saved.</p></div>
      <div class="right"><div class="row-flex"><input class="in" id="edName" placeholder="Indicator name" style="flex:1"><button class="btn" id="edSave">Save</button><button class="btn primary" id="edSaveAdd">Save and add to chart</button></div><textarea class="in" id="edCode" spellcheck="false" style="flex:1;min-height:220px"></textarea><div id="edErr" class="down" style="white-space:pre-line"></div></div></div>`;
    const code = $("#edCode");
    code.value = TEMPLATE;
    $("#edName").value = "EMA ribbon squeeze";
    code.onkeydown = (e) => {
      if (e.key !== "Tab") return;
      e.preventDefault();
      const s = code.selectionStart;
      code.setRangeText("  ", s, code.selectionEnd, "end");
    };
    $("#edNew").onclick = () => {
      edFile = null;
      code.value = TEMPLATE.replace("'EMA ribbon squeeze'", "'My indicator'");
      $("#edName").value = "My indicator";
    };
    const save = async (add) => {
      $("#edErr").textContent = "";
      const name = $("#edName").value.trim() || "indicator";
      let src = code.value;
      try {
        const r = await api.post("/api/custom", { name, code: src });
        const def = await app.importCustom(r.file);
        if (!def)
          throw new Error(
            "Saved, but the browser could not load it. Check the code.",
          );
        app.toast(`Saved ${r.file}`);
        if (add) app.active.addIndicator(def.id);
        else app.panes.forEach((p) => p.render(false));
        edFile = r.file;
        renderEditorList();
      } catch (e) {
        $("#edErr").textContent = e.message;
      }
    };
    $("#edSave").onclick = () => save(false);
    $("#edSaveAdd").onclick = () => save(true);
    $("#edList").onclick = async (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      const file = btn.closest("[data-file]").dataset.file;
      if (btn.dataset.act === "open") {
        code.value = await (
          await fetch(`/custom/${encodeURIComponent(file)}?v=${Date.now()}`)
        ).text();
        $("#edName").value = file.replace(/\.js$/, "").replace(/-/g, " ");
        edFile = file;
      }
      if (btn.dataset.act === "add") {
        const def = await app.importCustom(file);
        if (def) app.active.addIndicator(def.id);
      }
      if (btn.dataset.act === "del" && confirm(`Delete ${file}?`)) {
        await api.del(`/api/custom/${encodeURIComponent(file)}`);
        renderEditor();
      }
    };
  }
  const renderEditorList = async () => {
    const box = $("#edList");
    if (box) box.innerHTML = edListHtml(await api.get("/api/custom").catch(() => []));
  };

  // Limit and stop orders in the replay account fill when a replayed bar's range reaches them.
  function checkReplayOrders(pane, bar) {
    const p = app.state.replayPaper;
    if (!p?.orders.length) return;
    for (const o of [...p.orders]) {
      if (o.symbol !== pane.cfg.symbol) continue;
      let px = null;
      if (o.type === "limit" && o.side === "buy" && bar.low <= o.price) px = Math.min(o.price, bar.open);
      if (o.type === "limit" && o.side === "sell" && bar.high >= o.price) px = Math.max(o.price, bar.open);
      if (o.type === "stop" && o.side === "buy" && bar.high >= o.price) px = Math.max(o.price, bar.open);
      if (o.type === "stop" && o.side === "sell" && bar.low <= o.price) px = Math.min(o.price, bar.open);
      if (px == null) continue;
      p.orders = p.orders.filter((x) => x !== o && (!o.oco || x.oco !== o.oco));
      fill(o.symbol, o.side, o.qty, px, o.note || `${o.type} order`);
    }
  }
  let paperRenderAt = 0;
  P.onReplayBar = (pane, bar) => {
    if (pane !== app.active || !bar) return;
    checkReplayOrders(pane, bar);
    if (bottomTab === "paper" && !bottomEl.classList.contains("collapsed") && Date.now() - paperRenderAt > 250) { paperRenderAt = Date.now(); renderPaper(); }
  };
  P.onReplayChange = () => {
    if (bottomTab === "paper" && !bottomEl.classList.contains("collapsed")) renderPaper();
  };

  // ---------- hooks for the app ----------
  P.showBottom = showBottom;
  P.openAlertDialog = openAlertDialog;
  let lastSymbol = null;
  P.onActiveChange = () => {
    if (sideTab === "watchlist") drawRows();
    const sym = app.active?.cfg.symbol;
    if (sym !== lastSymbol) {
      lastSymbol = sym;
      if (sideTab === "news") renderNews(side, app);
      if (!bottomEl.classList.contains("collapsed") && bottomTab === "seasonals") renderSeasonals(bottom, app);
      if (!bottomEl.classList.contains("collapsed") && bottomTab === "financials") renderFinancials(bottom, app);
    }
    if (bottomTab === "paper" && !bottomEl.classList.contains("collapsed"))
      renderPaper();
  };
  P.onAlertFired = () => {
    if (sideTab === "alerts") renderAlerts();
  };
  P.onTheme = () => {
    renderBottom();
  };
  showSide("watchlist");
  return P;
}
