#!/usr/bin/env node
// Quant Terminal server. Node 18+ and nothing else: no npm install, no build step.
//   node server.js            start on http://localhost:3777 (or the next free port)
//   node server.js --open     start and open your browser
//   PORT=4000 node server.js  pick a port

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as data from "./lib/providers.js";
import * as feeds from "./lib/feeds.js";
import * as imports from "./lib/imports.js";
import * as alerts from "./lib/alerts.js";
import * as store from "./lib/store.js";
import * as info from "./lib/market-info.js";
import * as indiaMarket from "./lib/india-market.js";
import { registerIndicator, INDICATORS, compute } from "./public/lib/indicators.js";
import { conditionFn, backtest, magnifierTf } from "./public/lib/backtest.js";
import { quantChecks } from "./public/lib/quant.js";
import { parseTf } from "./public/lib/series.js";
import { relaunchForProxy, proxyNote } from "./lib/proxy.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const CUSTOM = path.join(ROOT, "custom");
const VERSION = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
).version;
const HOST = process.env.HOST || "127.0.0.1";
const START_PORT = Number(process.env.PORT) || 3777;
const PUBLIC_DEPLOY = process.env.QT_PUBLIC_DEPLOY === "1";

function hasPublicCredentials(req) {
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(req.headers.authorization || "");
  if (!match) return false;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  const suppliedUser = Buffer.from(decoded.slice(0, separator));
  const suppliedPassword = Buffer.from(decoded.slice(separator + 1));
  const expectedUser = Buffer.from(process.env.QT_AUTH_USER || "");
  const expectedPassword = Buffer.from(process.env.QT_AUTH_PASSWORD || "");
  return suppliedUser.length === expectedUser.length &&
    suppliedPassword.length === expectedPassword.length &&
    crypto.timingSafeEqual(suppliedUser, expectedUser) &&
    crypto.timingSafeEqual(suppliedPassword, expectedPassword);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

// ---------- helpers ----------
const httpError = (status, message) => Object.assign(new Error(message), { status });

function send(res, status, body, headers = {}) {
  const isStr = typeof body === "string" || Buffer.isBuffer(body);
  res.writeHead(status, {
    "Content-Type": isStr ? "text/plain; charset=utf-8" : "application/json",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(isStr ? body : JSON.stringify(body));
}

async function readBody(req, limit = 2e6) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit)
      throw Object.assign(new Error("Request too large"), { status: 413 });
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw httpError(400, "The request body isn't valid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw httpError(400, "The request body must be a JSON object");
  return body;
}

// A raw text body (CSV imports), up to `limit` bytes.
async function readText(req, limit = 300e6) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw httpError(413, `The file is over ${Math.round(limit / 1e6)} MB`);
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// The server only answers to this machine's browser. Writes need a custom header, which a random
// website can't add to a cross-site request, so other pages can't drive your terminal.
function allowed(req) {
  const host = (req.headers.host || "")
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "");
  const okHosts = new Set(["localhost", "127.0.0.1", "::1", ...lanAddresses()]);
  if (!PUBLIC_DEPLOY && !okHosts.has(host)) return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    if (req.headers["x-qt"] !== "1") return false;
    const origin = req.headers.origin;
    if (origin) {
      try {
        if (new URL(origin).host !== req.headers.host) return false;
      } catch {
        return false; // "null" and other opaque origins
      }
    }
  }
  return true;
}

function lanAddresses() {
  if (HOST === "127.0.0.1" || HOST === "localhost") return [];
  return Object.values(os.networkInterfaces())
    .flat()
    .filter(Boolean)
    .map((i) => i.address);
}

function serveStatic(res, baseDir, rel) {
  const file = path.normalize(path.join(baseDir, rel));
  if (!file.startsWith(baseDir + path.sep)) return send(res, 403, "Forbidden");
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, "Not found");
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": rel.startsWith("vendor/")
        ? "public, max-age=86400"
        : "no-cache",
    });
    fs.createReadStream(file).pipe(res);
  });
}

// ---------- custom indicators (your own "Pine scripts", as plain JS files in /custom) ----------
const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "indicator";
const customErrors = {};
let customImportVersion = 0;

function listCustom() {
  fs.mkdirSync(CUSTOM, { recursive: true });
  return fs
    .readdirSync(CUSTOM)
    .filter((f) => f.endsWith(".js"))
    .map((f) => ({
      file: f,
      id: `custom:${f.replace(/\.js$/, "")}`,
      mtime: fs.statSync(path.join(CUSTOM, f)).mtimeMs,
      error: customErrors[f] || null,
    }));
}

async function loadCustom(file) {
  try {
    const full = path.join(CUSTOM, file);
    const mod = await import(
      `${pathToFileURL(full).href}?v=${fs.statSync(full).mtimeMs}-${++customImportVersion}`
    );
    registerIndicator({
      ...mod.default,
      id: `custom:${file.replace(/\.js$/, "")}`,
    });
    delete customErrors[file];
  } catch (e) {
    customErrors[file] = e.message;
  }
}

// ---------- server-sent events (alerts pop up in the browser) ----------
const clients = new Set();
function broadcast(type, payload) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(msg);
}
alerts.onFire((e) => broadcast("alert", e));
setInterval(() => {
  for (const res of clients) res.write(": keep-alive\n\n");
}, 25000).unref();

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    }),
  );
  return out;
}

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  let p;
  try {
    p = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, "Bad URL");
  }
  // Public hosting health probes must work without exposing user data or write routes.
  if (p === "/healthz" && req.method === "GET")
    return send(res, 200, { ok: true, app: "quant-terminal", version: VERSION });
  if (PUBLIC_DEPLOY && !hasPublicCredentials(req))
    return send(res, 401, "Sign in to Quant Terminal", {
      "WWW-Authenticate": 'Basic realm="Quant Terminal", charset="UTF-8"',
    });
  if (!allowed(req))
    return send(
      res,
      403,
      "Forbidden: Quant Terminal only answers to this computer.",
    );
  const q = Object.fromEntries(url.searchParams);

  if (!p.startsWith("/api/")) {
    if (p === "/" || p === "/index.html")
      return serveStatic(res, PUBLIC, "index.html");
    if (p.startsWith("/custom/")) return serveStatic(res, CUSTOM, p.slice(8));
    return serveStatic(res, PUBLIC, p.slice(1));
  }

  try {
    if (p === "/api/health") {
      return send(res, 200, {
        ok: true,
        app: "quant-terminal",
        root: ROOT,
        version: VERSION,
        node: process.version,
        platform: process.platform,
        providers: data.health,
        feeds: feeds.configured(),
        broker: indiaMarket.brokerSettings(),
        yahoo: data.yahooAvailable() ? "available" : "rate limited",
        alerts: alerts.list().filter((a) => a.active).length,
      });
    }
    if (p === "/api/probe") return send(res, 200, await data.probeAll());
    if (p === "/api/resolve")
      return send(res, 200, await data.resolve(q.symbol));
    if (p === "/api/search") return send(res, 200, await data.search(q.q, q.type));
    if (p === "/api/spread") return send(res, 200, await data.getSpread(q.symbol));
    if (p === "/api/candles")
      {
        let brokerNote = "";
        const indian = /\.(NS|BO)$/i.test(q.symbol || "") || /\^NSEI|\^BSESN/i.test(q.symbol || "");
        if (indian) try {
          const broker = await indiaMarket.brokerCandles(q.symbol, q.tf || "1D", q.limit);
          if (broker) return send(res, 200, broker);
        } catch (e) { brokerNote = e.message; }
        const result = await data.getCandles(q.symbol, q.tf || "1D", q.limit);
        if (brokerNote) result.notes = [...(result.notes || []), brokerNote];
        return send(res, 200, result);
      }
    if (p === "/api/quotes")
      {
        const symbols = (q.symbols || "").split(",").filter(Boolean).slice(0, 200);
        const quotes = await data.getQuotes(symbols);
        const indianSymbols = symbols.filter((symbol) => /\.(NS|BO)$/i.test(symbol) || /\^NSEI|\^BSESN/i.test(symbol));
        if (indiaMarket.brokerSettings().broker !== "none") await mapLimit(indianSymbols, 4, async (symbol) => {
          try {
            const price = await indiaMarket.brokerQuote(symbol);
            if (price != null) quotes[symbol] = { ...quotes[symbol], price, provider: `${indiaMarket.brokerSettings().broker} broker API` };
          } catch { /* public quote remains the fallback */ }
        });
        return send(res, 200, quotes);
      }
    if (p === "/api/india/option-chain") return send(res, 200, q.source === "broker" ? await indiaMarket.brokerOptionChain(q.symbol || "NIFTY") : await indiaMarket.optionChain(q.symbol || "NIFTY"));
    if (p === "/api/india/flows") return send(res, 200, await indiaMarket.flowsAndDeals());
    if (p === "/api/broker-settings") {
      if (req.method === "GET") return send(res, 200, indiaMarket.brokerSettings());
      if (req.method === "PUT") return send(res, 200, indiaMarket.saveBrokerSettings(await readBody(req)));
    }
    if (p === "/api/calendar")
      return send(res, 200, await data.economicCalendar());
    if (p === "/api/earnings") return send(res, 200, await info.earnings(Number(q.days) || 5));
    if (p === "/api/india-earnings") return send(res, 200, await info.indianEarnings());
    if (p === "/api/dividends") return send(res, 200, await info.dividends(Number(q.days) || 5));
    if (p === "/api/news") return send(res, 200, await info.news(q.symbol));
    if (p === "/api/financials") return send(res, 200, await info.financials(q.symbol, q.frequency));
    if (p === "/api/screener") {
      const u = q.universe || "crypto";
      const rows =
        u === "crypto"
          ? await data.cryptoScreener()
          : u === "india"
            ? await data.indiaScreener()
          : ["nifty50", "niftynext50", "nifty100", "nifty500", "sensex"].includes(u)
            ? await data.indiaIndexScreener(u)
          : await data.nasdaqScreener(u === "etf" ? "etf" : "stocks");
      return send(res, 200, rows);
    }
    if (p === "/api/correlation") {
      const symbols = [...new Set(String(q.symbols || "").split(",").map((s) => s.trim()).filter(Boolean))].slice(0, 12);
      if (symbols.length < 2) throw httpError(400, "Enter at least two symbols for a correlation matrix.");
      const series = await mapLimit(symbols, 4, async (symbol) => {
        const { candles } = await data.getCandles(symbol, "1D", 400);
        const byDay = new Map();
        for (let i = 1; i < candles.length; i++) if (candles[i - 1].close) byDay.set(candles[i].time, (candles[i].close / candles[i - 1].close) - 1);
        return { symbol, byDay };
      });
      const corr = (a, b) => {
        const pairs = [...a.byDay].flatMap(([t, x]) => b.byDay.has(t) ? [[x, b.byDay.get(t)]] : []);
        if (pairs.length < 20) return null;
        const mx = pairs.reduce((s, x) => s + x[0], 0) / pairs.length, my = pairs.reduce((s, x) => s + x[1], 0) / pairs.length;
        let cov = 0, vx = 0, vy = 0;
        for (const [x, y] of pairs) { cov += (x - mx) * (y - my); vx += (x - mx) ** 2; vy += (y - my) ** 2; }
        return vx && vy ? cov / Math.sqrt(vx * vy) : null;
      };
      return send(res, 200, { symbols: series.map((x) => x.symbol), observations: series.map((x) => x.byDay.size), matrix: series.map((a) => series.map((b) => a === b ? 1 : corr(a, b))) });
    }
    if (p === "/api/scan" && req.method === "POST") {
      const body = await readBody(req);
      if (!Array.isArray(body.symbols) || !Array.isArray(body.rules ?? []))
        throw httpError(400, "Send { symbols: [...], rules: [...] }");
      const symbols = body.symbols.slice(0, 500);
      const rules = body.rules || [];
      const results = await mapLimit(symbols, 4, async (symbol) => {
        try {
          const { candles } = await data.getCandles(
            symbol,
            body.tf || "1D",
            400,
          );
          const i = candles.length - 1;
          const make = rules.length ? conditionFn(candles, body.indicators || {}) : null;
          const passes = make ? rules.map((r) => make(r)(i)) : [];
          let metrics;
          if (body.metrics && candles.length) {
            const rsi = compute("rsi", candles, { length: 14 }).value;
            const e50 = compute("ema", candles, { length: 50, source: "close" }).value;
            const e200 = compute("ema", candles, { length: 200, source: "close" }).value;
            const macd = compute("macd", candles, { fast: 12, slow: 26, signal: 9, source: "close" });
            const st = compute("supertrend", candles, { atrLength: 10, factor: 3 }).direction;
            const prevVol = candles.slice(Math.max(0, i - 20), i).reduce((s, b) => s + (b.volume || 0), 0) / Math.max(1, Math.min(20, i));
            const range = candles.slice(Math.max(0, i - 251), i + 1);
            const high52 = Math.max(...range.map((b) => b.high)), low52 = Math.min(...range.map((b) => b.low));
            metrics = {
              rsi: rsi[i], ema50: e50[i], ema200: e200[i],
              aboveEMA50: candles[i].close > e50[i], aboveEMA200: candles[i].close > e200[i],
              volumeSpike: prevVol ? (candles[i].volume || 0) / prevVol : null,
              high52DistancePct: high52 ? (high52 - candles[i].close) / high52 * 100 : null,
              low52DistancePct: low52 ? (candles[i].close - low52) / low52 * 100 : null,
              changePct: i ? (candles[i].close / candles[i - 1].close - 1) * 100 : null,
              supertrendFlip: i && st[i] !== st[i - 1] ? (st[i] < 0 ? "up" : "down") : null,
              macdCross: i && macd.macd[i] > macd.signal[i] && macd.macd[i - 1] <= macd.signal[i - 1] ? "bullish" : i && macd.macd[i] < macd.signal[i] && macd.macd[i - 1] >= macd.signal[i - 1] ? "bearish" : null,
            };
          }
          const f = body.metricFilters || {};
          const metricPass = !metrics || (
            (f.rsiMin == null || metrics.rsi >= f.rsiMin) && (f.rsiMax == null || metrics.rsi <= f.rsiMax) &&
            (!f.ema || (f.ema === "above50" ? metrics.aboveEMA50 : f.ema === "below50" ? !metrics.aboveEMA50 : f.ema === "above200" ? metrics.aboveEMA200 : !metrics.aboveEMA200)) &&
            (f.volumeSpike == null || metrics.volumeSpike >= f.volumeSpike) &&
            (!f.week52 || (f.week52 === "high" ? metrics.high52DistancePct <= 5 : metrics.low52DistancePct <= 5)) &&
            (f.changeMin == null || metrics.changePct >= f.changeMin) && (f.changeMax == null || metrics.changePct <= f.changeMax) &&
            (!f.supertrendFlip || metrics.supertrendFlip === f.supertrendFlip) && (!f.macdCross || metrics.macdCross === f.macdCross)
          );
          return { symbol, pass: passes.every(Boolean) && metricPass, passes, close: candles[i]?.close, ...(metrics ? { metrics } : {}) };
        } catch (e) {
          return { symbol, error: e.message };
        }
      });
      return send(res, 200, results);
    }
    // The strategy tester on the server, for your own code (docs/api.md). Same rule format as the tester.
    if (p === "/api/backtest" && req.method === "POST") {
      const body = await readBody(req);
      const strategy = body.strategy;
      if (!body.symbol || !strategy || typeof strategy !== "object" || Array.isArray(strategy))
        throw httpError(400, "Send { symbol, tf, strategy: { indicators, entryLong, exitLong, ... } }");
      const tf = body.tf || "1D";
      const { symbol, provider, candles } = await data.getCandles(body.symbol, tf, body.limit || 1500);
      if (candles.length < 2) throw httpError(422, "Not enough bars to test on");
      let subBars = null;
      if (strategy.intrabar === "magnifier") {
        const sec = parseTf(tf).seconds;
        const span = candles.at(-1).time - candles[0].time + sec;
        const m = magnifierTf(sec, span);
        if (m) {
          const r = await data.getCandles(symbol, m.tf, Math.ceil(span / m.seconds) + 10);
          subBars = r.candles.filter((c) => c.time >= candles[0].time && c.time < candles.at(-1).time + sec);
        }
      }
      let r, q;
      try {
        r = backtest(candles, strategy, { subBars });
        if (body.quantChecks) q = quantChecks(candles, strategy, { subBars });
      } catch (e) {
        throw httpError(400, e.message);
      }
      return send(res, 200, {
        symbol,
        tf,
        provider,
        bars: candles.length,
        from: candles[0].time,
        to: candles.at(-1).time,
        stats: r.stats,
        trades: r.trades,
        ...(body.equity ? { equity: r.equity } : {}),
        ...(q
          ? {
              quantChecks: {
                passed: q.passed,
                total: q.gates.length,
                gates: q.gates.map(({ label, value, pass }) => ({ label, value, pass })),
                walkForward: q.walkForward,
                monteCarlo: q.monteCarlo,
              },
            }
          : {}),
      });
    }
    // Your own data files (lib/imports.js): bars chart as CSV:<NAME>; a signal becomes an indicator.
    if (p === "/api/imports") return send(res, 200, imports.listImports());
    if (p === "/api/import/bars" && req.method === "POST")
      return send(res, 200, imports.importBars(q.name, await readText(req)));
    if (p === "/api/import/signal" && req.method === "POST") {
      const name = imports.cleanName(q.name);
      const sig = imports.parseSignals(await readText(req, 100e6));
      const file = `signal-${name.toLowerCase()}.js`;
      const full = path.join(CUSTOM, file);
      fs.mkdirSync(CUSTOM, { recursive: true });
      const before = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
      fs.writeFileSync(full, imports.signalIndicatorSource(name, sig, q.name));
      await loadCustom(file);
      const error = customErrors[file];
      if (error) {
        if (before == null) fs.rmSync(full, { force: true });
        else fs.writeFileSync(full, before);
        delete customErrors[file];
        throw httpError(400, error);
      }
      const id = `custom:${file.replace(/\.js$/, "")}`;
      return send(res, 200, { ok: true, name, id, file, rows: sig.rows, changes: sig.changes.length, from: sig.from, to: sig.to, strategy: imports.signalStrategy(id) });
    }
    if (p === "/api/indicators")
      return send(
        res,
        200,
        INDICATORS.map((d) => ({
          id: d.id,
          name: d.name,
          inputs: (d.inputs || []).map(({ key, type, default: def, options }) => ({ key, type, default: def, ...(options ? { options } : {}) })),
          outputs: (d.outputs || []).map((o) => o.key),
        })),
      );
    if (p === "/api/state") {
      if (req.method === "GET") return send(res, 200, store.read("state", {}));
      if (req.method === "PUT") {
        const patch = await readBody(req, 20e6);
        const next = { ...store.read("state", {}), ...patch };
        store.write("state", next);
        return send(res, 200, { ok: true });
      }
    }
    if (p === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write("retry: 3000\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (p === "/api/alerts") {
      if (req.method === "GET") return send(res, 200, alerts.list());
      if (req.method === "POST")
        return send(res, 200, alerts.add(await readBody(req)));
    }
    if (p === "/api/alerts/log") return send(res, 200, alerts.history());
    if (p === "/api/alerts/check" && req.method === "POST") {
      await alerts.evaluate();
      return send(res, 200, { ok: true });
    }
    if (p.startsWith("/api/alerts/")) {
      const id = p.split("/")[3];
      if (req.method === "DELETE") {
        alerts.remove(id);
        return send(res, 200, { ok: true });
      }
      if (req.method === "PATCH")
        return send(res, 200, alerts.update(id, await readBody(req)));
    }
    if (p === "/api/webhook-test" && req.method === "POST") {
      const { url: hook } = await readBody(req);
      if (!/^https?:\/\/[^\s]+$/i.test(String(hook || "")))
        throw httpError(400, "Webhook must be an http(s) URL");
      const r = await fetch(hook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "Quant Terminal test alert",
          content: "Quant Terminal test alert",
        }),
        signal: AbortSignal.timeout(10000),
      });
      return send(res, 200, { ok: r.ok, status: r.status });
    }
    if (p === "/api/custom") {
      if (req.method === "GET") return send(res, 200, listCustom());
      if (req.method === "POST") {
        const { name, code } = await readBody(req);
        if (!code || !/export\s+default/.test(code))
          throw Object.assign(
            new Error(
              "The file must `export default { name, calc(bars, params, ta) { ... } }`",
            ),
            { status: 400 },
          );
        const file = `${slug(name)}.js`;
        const full = path.join(CUSTOM, file);
        fs.mkdirSync(CUSTOM, { recursive: true });
        const before = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
        fs.writeFileSync(full, code);
        await loadCustom(file);
        const error = customErrors[file];
        if (error) {
          // Refused: put back what was there (or nothing), so a broken save never replaces a working file.
          // The refused code never registered, so the working version is still the one loaded.
          if (before == null) fs.rmSync(full, { force: true });
          else fs.writeFileSync(full, before);
          delete customErrors[file];
          return send(res, 400, { error, file });
        }
        return send(res, 200, { ok: true, file, id: `custom:${file.replace(/\.js$/, "")}` });
      }
    }
    if (p.startsWith("/api/custom/") && req.method === "DELETE") {
      const file = path.basename(p.slice(12));
      fs.rmSync(path.join(CUSTOM, file), { force: true });
      return send(res, 200, { ok: true });
    }
    if (p === "/api/shutdown" && req.method === "POST") {
      // Lets the installer stop a running copy before updating it, on any OS.
      send(res, 200, { ok: true });
      setTimeout(() => process.exit(0), 100);
      return;
    }
    return send(res, 404, { error: "Unknown endpoint" });
  } catch (e) {
    // Upstream failures are a bad gateway, whatever status the provider used.
    const code = e.upstream ? 502 : e.status >= 400 && e.status < 600 ? e.status : 500;
    return send(res, code, { error: e.message });
  }
}

// ---------- start ----------
function openBrowser(url) {
  const cmd =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", '""', url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* no desktop: the URL is printed anyway */
  }
}

export function start(port = START_PORT, tries = 20) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      handle(req, res).catch((e) => {
        if (!res.headersSent) send(res, 500, { error: e.message });
      });
    });
    server.once("error", (e) => {
      if (e.code === "EADDRINUSE" && tries > 0)
        resolve(start(port + 1, tries - 1));
      else reject(e);
    });
    server.listen(port, HOST, () => resolve({ server, port }));
  });
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const relaunched = isMain ? relaunchForProxy() : null;
if (relaunched) process.exit(await relaunched);
if (isMain) {
  if (PUBLIC_DEPLOY && (!process.env.QT_AUTH_USER || !process.env.QT_AUTH_PASSWORD))
    throw new Error("Public hosting requires QT_AUTH_USER and QT_AUTH_PASSWORD. Configure both secrets before starting.");
  for (const c of listCustom()) await loadCustom(c.file);
  const { port } = await start();
  const url = `http://localhost:${port}`;
  alerts.start();
  console.log(
    `\n  Quant Terminal ${VERSION} is running\n\n  Open:  ${url}\n  Stop:  Ctrl+C\n  Data:  ${store.DATA_DIR}\n`,
  );
  if (proxyNote()) console.log(`  ${proxyNote()}\n`);
  if (HOST !== "127.0.0.1" && HOST !== "localhost")
    console.log(
      `  Also on your network: ${lanAddresses()
        .filter((a) => a.includes(".") && a !== "127.0.0.1")
        .map((a) => `http://${a}:${port}`)
        .join("  ")}\n`,
    );
  if (process.argv.includes("--open") || process.env.QT_OPEN === "1")
    openBrowser(url);
  const bye = () => {
    console.log("\n  Stopped.");
    process.exit(0);
  };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}
