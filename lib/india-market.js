// Read-only Indian exchange reports. NSE endpoints are public website endpoints, not a stable
// exchange API; callers get a clear block/rate-limit message and can fall back to a broker.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./store.js";

const NSE = "https://www.nseindia.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36";
let cookie = "", cookieAt = 0;
const caches = new Map();
const timeout = (ms = 12000) => AbortSignal.timeout(ms);

async function nseJson(url) {
  const headers = { "User-Agent": UA, Accept: "application/json, text/plain, */*", "Accept-Language": "en-US,en;q=0.9", Referer: `${NSE}/` };
  if (Date.now() - cookieAt > 5 * 60e3 || !cookie) {
    const page = await fetch(`${NSE}/`, { headers, signal: timeout() });
    cookie = page.headers.getSetCookie?.().map((x) => x.split(";")[0]).join("; ") || page.headers.get("set-cookie")?.split(", ").map((x) => x.split(";")[0]).join("; ") || "";
    cookieAt = Date.now();
  }
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(url, { headers, signal: timeout() });
  if (!res.ok) throw new Error(res.status === 403 || res.status === 429
    ? `NSE public data is blocking this request (HTTP ${res.status}). Choose a broker API in Settings to continue.`
    : `NSE public data returned HTTP ${res.status}. You can choose a broker API in Settings.`);
  const type = res.headers.get("content-type") || "";
  if (!type.includes("json")) throw new Error("NSE returned a web page instead of data, likely due to its public-data protection. Choose a broker API in Settings.");
  return res.json();
}

async function cached(key, ttl, fn) {
  const old = caches.get(key);
  if (old && old.until > Date.now()) return old.value;
  const value = await fn();
  caches.set(key, { value, until: Date.now() + ttl });
  return value;
}

export async function optionChain(raw = "NIFTY") {
  const symbol = String(raw).trim().toUpperCase().replace(/^YAHOO:/, "").replace(/\.(NS|BO)$/, "");
  const index = symbol.replace(/[^A-Z0-9]/g, "");
  if (!/^(NIFTY|BANKNIFTY|FINNIFTY|MIDCPNIFTY|NIFTYNXT50|[A-Z0-9&-]{2,20})$/.test(index)) throw Object.assign(new Error("Enter NIFTY, BANKNIFTY, or an NSE F&O stock symbol."), { status: 400 });
  return cached(`oc:${index}`, 20_000, async () => {
    const isIndex = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50"].includes(index);
    const endpoint = isIndex ? "option-chain-indices" : "option-chain-equities";
    const rawData = await nseJson(`${NSE}/api/${endpoint}?symbol=${encodeURIComponent(index)}`);
    const source = rawData.records?.data || rawData.filtered?.data;
    if (!Array.isArray(source)) throw new Error("NSE option-chain response had no strike data. Try again later or choose a broker API in Settings.");
    const rows = source.map((r) => ({
      strike: Number(r.strikePrice), expiry: r.expiryDate,
      call: r.CE ? { ltp: r.CE.lastPrice, oi: r.CE.openInterest, changeOi: r.CE.changeinOpenInterest, iv: r.CE.impliedVolatility, volume: r.CE.totalTradedVolume } : null,
      put: r.PE ? { ltp: r.PE.lastPrice, oi: r.PE.openInterest, changeOi: r.PE.changeinOpenInterest, iv: r.PE.impliedVolatility, volume: r.PE.totalTradedVolume } : null,
    })).filter((r) => Number.isFinite(r.strike));
    const expiry = rawData.records?.expiryDates?.[0] || rows.find((r) => r.expiry)?.expiry;
    const active = rows.filter((r) => !expiry || r.expiry === expiry);
    const callOi = active.reduce((s, r) => s + (r.call?.oi || 0), 0);
    const putOi = active.reduce((s, r) => s + (r.put?.oi || 0), 0);
    const pain = active.map((x) => ({ strike: x.strike, pain: active.reduce((s, y) => s + (y.call?.oi || 0) * Math.max(0, x.strike - y.strike) + (y.put?.oi || 0) * Math.max(0, y.strike - x.strike), 0) })).sort((a, b) => a.pain - b.pain)[0]?.strike;
    return { symbol: index, underlying: rawData.records?.underlyingValue ?? rawData.filtered?.underlyingValue ?? null, expiry, pcr: callOi ? putOi / callOi : null, maxPain: pain, strikes: active, asOf: new Date().toISOString(), source: "NSE India public option chain" };
  });
}

export async function brokerOptionChain(raw = "NIFTY") {
  const c = readBroker();
  if (!credentialsConfigured(c)) throw new Error("Configure a broker API in Settings before requesting its option chain.");
  if (!["upstox", "dhan"].includes(c.broker)) throw new Error(`Option-chain fallback is available through Upstox and Dhan APIs. ${c.broker} can still provide mapped prices and candles; use NSE public data or select Upstox/Dhan for broker option chains.`);
  const symbol = String(raw).trim().toUpperCase().replace(/^YAHOO:/, "").replace(/\.(NS|BO)$/, "");
  const m = c.instruments?.[symbol] || c.instruments?.[`YAHOO:${symbol}`] || c.instruments?.[`YAHOO:${symbol}.NS`] || c.instruments?.[`${symbol}.NS`] || {};
  const headers = c.broker === "upstox" ? { Authorization: `Bearer ${c.accessToken}`, Accept: "application/json" } : { "access-token": c.accessToken, "client-id": c.clientId, "Content-Type": "application/json" };
  const getUpstoxChain = async () => {
    const key = m.optionInstrumentKey || m.instrumentKey || ({ NIFTY: "NSE_INDEX|Nifty 50", BANKNIFTY: "NSE_INDEX|Nifty Bank" })[symbol];
    if (!key) throw new Error(`Add optionInstrumentKey in the ${c.broker} instrument mapping for ${symbol}.`);
    const exp = encodeURIComponent(m.expiry || "current_week");
    const res = await fetch(`https://api.upstox.com/v2/option/chain?instrument_key=${encodeURIComponent(key)}&expiry_date=${exp}`, { headers, signal: timeout() });
    if (!res.ok) throw indianApiError(res, "Upstox option chain");
    const j = await res.json();
    const rows = (j.data || []).map((r) => ({ strike: Number(r.strike_price), expiry: r.expiry, call: r.call_options ? { ltp: r.call_options.market_data?.ltp, oi: r.call_options.market_data?.oi, changeOi: Number(r.call_options.market_data?.oi || 0) - Number(r.call_options.market_data?.prev_oi || 0), iv: r.call_options.option_greeks?.iv, volume: r.call_options.market_data?.volume } : null, put: r.put_options ? { ltp: r.put_options.market_data?.ltp, oi: r.put_options.market_data?.oi, changeOi: Number(r.put_options.market_data?.oi || 0) - Number(r.put_options.market_data?.prev_oi || 0), iv: r.put_options.option_greeks?.iv, volume: r.put_options.market_data?.volume } : null }));
    return { symbol, underlying: j.data?.[0]?.underlying_spot_price, expiry: j.data?.[0]?.expiry || m.expiry || "current_week", strikes: rows, source: "Upstox option-chain API" };
  };
  const getDhanChain = async () => {
    const securityId = m.underlyingSecurityId || m.securityId || ({ NIFTY: "13" })[symbol];
    const segment = m.underlyingExchangeSegment || m.exchangeSegment || "IDX_I";
    if (!securityId) throw new Error(`Add underlyingSecurityId and underlyingExchangeSegment in the Dhan instrument mapping for ${symbol}.`);
    const post = async (path, body) => {
      const res = await fetch(`https://api.dhan.co/v2/optionchain/${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: timeout() });
      if (!res.ok) throw indianApiError(res, "Dhan option chain");
      return res.json();
    };
    const body = { UnderlyingScrip: Number(securityId), UnderlyingSeg: segment };
    const expiries = await post("expirylist", body);
    const expiry = m.expiry || expiries.data?.[0];
    if (!expiry) throw new Error("Dhan returned no active option expiry for this symbol.");
    const j = await post("", { ...body, Expiry: expiry });
    const oc = j.data?.oc || {};
    const rows = Object.entries(oc).map(([strike, r]) => ({ strike: Number(strike), expiry, call: r.ce ? { ltp: r.ce.last_price, oi: r.ce.oi, changeOi: Number(r.ce.oi || 0) - Number(r.ce.previous_oi || r.ce.prev_oi || 0), iv: r.ce.greeks?.iv, volume: r.ce.volume } : null, put: r.pe ? { ltp: r.pe.last_price, oi: r.pe.oi, changeOi: Number(r.pe.oi || 0) - Number(r.pe.previous_oi || r.pe.prev_oi || 0), iv: r.pe.greeks?.iv, volume: r.pe.volume } : null }));
    return { symbol, underlying: j.data?.last_price, expiry, strikes: rows, source: "Dhan option-chain API" };
  };
  const result = c.broker === "upstox" ? await getUpstoxChain() : await getDhanChain();
  const callOi = result.strikes.reduce((s, r) => s + (r.call?.oi || 0), 0), putOi = result.strikes.reduce((s, r) => s + (r.put?.oi || 0), 0);
  result.pcr = callOi ? putOi / callOi : null;
  result.maxPain = result.strikes.map((x) => ({ strike: x.strike, pain: result.strikes.reduce((s, y) => s + (y.call?.oi || 0) * Math.max(0, x.strike - y.strike) + (y.put?.oi || 0) * Math.max(0, y.strike - x.strike), 0) })).sort((a, b) => a.pain - b.pain)[0]?.strike;
  result.asOf = new Date().toISOString();
  return result;
}

export async function flowsAndDeals() {
  return cached("flows-deals", 5 * 60e3, async () => {
    let fiiDii = null, nseDeals = null, bseDeals = null;
    const errors = [];
    try { fiiDii = await nseJson(`${NSE}/api/fiidiiTradeReact`); } catch (e) { errors.push(`FII/DII: ${e.message}`); }
    try { nseDeals = await nseJson(`${NSE}/api/snapshot-capital-market-largedeal?index=bulk_deals`); } catch (e) { errors.push(`NSE deals: ${e.message}`); }
    try {
      const res = await fetch("https://api.bseindia.com/BseIndiaAPI/api/BulkDealData_ng/w?fdate=&tdate=&scripcode=", { headers: { "User-Agent": UA, Accept: "application/json", Referer: "https://www.bseindia.com/" }, signal: timeout() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      bseDeals = await res.json();
    } catch (e) { errors.push(`BSE deals: ${e.message}`); }
    return { fiiDii, nseDeals, bseDeals, errors, asOf: new Date().toISOString(), sources: { fiiDii: "NSE FII/FPI & DII report", nseDeals: "NSE large deals report", bseDeals: "BSE Bulk Deal data" } };
  });
}

const BROKER_FILE = path.join(DATA_DIR, "broker.json");
const brokers = new Set(["none", "kite", "upstox", "angel", "dhan"]);
const credentialsConfigured = (c) => c.broker === "dhan" ? !!(c.clientId && c.accessToken) : c.broker === "angel" ? !!(c.apiKey && c.clientId && (c.jwtToken || c.accessToken)) : c.broker === "none" ? false : !!(c.apiKey && c.accessToken);
export function brokerSettings() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(BROKER_FILE, "utf8")); } catch { /* unconfigured */ }
  return { broker: c.broker || "none", configured: credentialsConfigured(c), hasAccessToken: !!(c.accessToken || c.jwtToken), hasSecret: !!(c.apiSecret || c.clientSecret), instrumentMappings: Object.keys(c.instruments || {}).length };
}
export function saveBrokerSettings(input) {
  if (!brokers.has(input.broker)) throw Object.assign(new Error("Choose Kite Connect, Upstox, Angel One SmartAPI, Dhan, or None."), { status: 400 });
  const prior = (() => { try { return JSON.parse(fs.readFileSync(BROKER_FILE, "utf8")); } catch { return {}; } })();
  const config = { ...prior, broker: input.broker };
  for (const k of ["apiKey", "apiSecret", "accessToken", "clientId", "clientSecret", "jwtToken", "feedToken"])
    if (Object.hasOwn(input, k) && String(input[k] || "").trim()) config[k] = String(input[k]).trim();
  if (input.instruments && typeof input.instruments === "object" && !Array.isArray(input.instruments)) config.instruments = input.instruments;
  if (input.clear === true) { for (const k of ["apiKey", "apiSecret", "accessToken", "clientId", "clientSecret", "jwtToken", "feedToken"]) delete config[k]; }
  fs.writeFileSync(BROKER_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
  try { fs.chmodSync(BROKER_FILE, 0o600); } catch { /* Windows ACLs apply */ }
  return brokerSettings();
}

function readBroker() {
  try { return JSON.parse(fs.readFileSync(BROKER_FILE, "utf8")); } catch { return {}; }
}
const intervals = { "1m": ["minute", "1"], "3m": ["minute", "3"], "5m": ["minute", "5"], "15m": ["minute", "15"], "30m": ["minute", "30"], "1h": ["minute", "60"], "4h": ["minute", "240"], "1D": ["day", "1"], "1W": ["week", "1"], "1M": ["month", "1"] };
function mappedInstrument(config, symbol) {
  const key = String(symbol).toUpperCase();
  const mapping = config.instruments?.[key] || config.instruments?.[key.replace(/^YAHOO:/, "")];
  if (!mapping) throw new Error(`No ${config.broker} instrument mapping for ${symbol}. Add a mapping in Settings; using public data for now.`);
  return mapping;
}
function indianApiError(r, name) {
  if (r.status === 401 || r.status === 403) return new Error(`${name} rejected credentials or access. Check the broker token and API permissions; public data will be tried.`);
  if (r.status === 429) return new Error(`${name} rate limit reached. Public data will be tried.`);
  return new Error(`${name} returned HTTP ${r.status}. Public data will be tried.`);
}

export async function brokerCandles(symbol, tf, limit = 3000) {
  const c = readBroker();
  if (!c.broker || c.broker === "none") return null;
  const name = { kite: "Zerodha Kite Connect", upstox: "Upstox", angel: "Angel One SmartAPI", dhan: "Dhan" }[c.broker];
  if (!credentialsConfigured(c)) throw new Error(`${name} is selected but required credentials are missing. Set them in Settings; public data will be tried.`);
  const m = mappedInstrument(c, symbol);
  const [unit, size] = intervals[tf] || [];
  if (!unit) throw new Error(`${tf} interval is not supported by ${name}; public data will be tried.`);
  const to = new Date(), from = new Date(to.getTime() - Math.max(120, limit * (unit === "minute" ? Number(size) : 1440)) * 60_000);
  const iso = (d) => d.toISOString().slice(0, 10);
  const headers = {};
  let url, init = { method: "GET", headers };
  if (c.broker === "kite") {
    headers.Authorization = `token ${c.apiKey}:${c.accessToken}`;
    headers["X-Kite-Version"] = "3";
    url = `https://api.kite.trade/instruments/historical/${encodeURIComponent(m.instrumentToken)}/${unit === "minute" ? size : unit}?from=${iso(from)}+09:15:00&to=${iso(to)}+15:30:00&oi=1`;
  } else if (c.broker === "upstox") {
    headers.Authorization = `Bearer ${c.accessToken}`;
    const upstoxInterval = unit === "minute" ? `${size}minute` : unit;
    url = `https://api.upstox.com/v2/historical-candle/${encodeURIComponent(m.instrumentKey)}/${upstoxInterval}/${iso(to)}/${iso(from)}`;
  } else if (c.broker === "angel") {
    url = "https://apiconnect.angelone.in/rest/secure/angelbroking/historical/v1/getCandleData";
    init = { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", "X-PrivateKey": c.apiKey, "X-ClientCode": c.clientId || "", Authorization: `Bearer ${c.jwtToken || c.accessToken}`, "X-UserType": "USER", "X-SourceID": "WEB", "X-ClientLocalIP": "127.0.0.1", "X-ClientPublicIP": "127.0.0.1", "X-MACAddress": "00:00:00:00:00:00" }, body: JSON.stringify({ exchange: m.exchange || "NSE", symboltoken: m.symbolToken, interval: ({ "1m": "ONE_MINUTE", "3m": "THREE_MINUTE", "5m": "FIVE_MINUTE", "15m": "FIFTEEN_MINUTE", "30m": "THIRTY_MINUTE", "1h": "ONE_HOUR", "1D": "ONE_DAY" })[tf], fromdate: `${iso(from)} 09:15`, todate: `${iso(to)} 15:30` }) };
  } else {
    const intraday = unit === "minute";
    url = `https://api.dhan.co/v2/charts/${intraday ? "intraday" : "historical"}`;
    init = { method: "POST", headers: { "Content-Type": "application/json", "access-token": c.accessToken, clientId: c.clientId }, body: JSON.stringify({ securityId: m.securityId, exchangeSegment: m.exchangeSegment || "NSE_EQ", instrument: m.instrument || "EQUITY", ...(intraday ? { interval: Number(size) } : { expiryCode: Number(m.expiryCode || 0) }), fromDate: iso(from), toDate: iso(to) }) };
  }
  const res = await fetch(url, { ...init, signal: timeout(15000) });
  if (!res.ok) throw indianApiError(res, name);
  const j = await res.json();
  const rows = c.broker === "kite" ? j.data?.candles : c.broker === "upstox" ? j.data?.candles : c.broker === "angel" ? j.data : Array.isArray(j.timestamp) ? j.timestamp.map((t, i) => [t, j.open?.[i], j.high?.[i], j.low?.[i], j.close?.[i], j.volume?.[i]]) : [];
  const asSeconds = (v) => { const n = Number(v); return Number.isFinite(n) && n > 1e9 ? Math.floor(n > 1e12 ? n / 1000 : n) : Math.floor(new Date(v).getTime() / 1000); };
  const candles = (rows || []).map((r) => ({ time: asSeconds(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5] || 0) })).filter((b) => Number.isFinite(b.time) && Number.isFinite(b.close)).slice(-limit);
  if (!candles.length) throw new Error(`${name} returned no candles for this instrument and timeframe. Check its mapping; public data will be tried.`);
  return { symbol, tf, provider: `${name} (broker API)`, candles, notes: ["Broker data is supplied by your connected account; availability, real-time access and history depend on its plan."] };
}

export async function brokerQuote(symbol) {
  const c = readBroker();
  if (!c.broker || c.broker === "none") return null;
  const m = mappedInstrument(c, symbol);
  const headers = {};
  let url;
  if (c.broker === "kite") { headers.Authorization = `token ${c.apiKey}:${c.accessToken}`; headers["X-Kite-Version"] = "3"; url = `https://api.kite.trade/quote/ltp?i=${encodeURIComponent(`${m.exchange || "NSE"}:${m.tradingsymbol}`)}`; }
  else if (c.broker === "upstox") { headers.Authorization = `Bearer ${c.accessToken}`; url = `https://api.upstox.com/v2/market-quote/ltp?instrument_key=${encodeURIComponent(m.instrumentKey)}`; }
  else if (c.broker === "angel") { headers.Authorization = `Bearer ${c.jwtToken || c.accessToken}`; headers["X-PrivateKey"] = c.apiKey; headers["X-ClientCode"] = c.clientId || ""; url = `https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/ltp?exchange=${encodeURIComponent(m.exchange || "NSE")}&tradingsymbol=${encodeURIComponent(m.tradingsymbol)}&symboltoken=${encodeURIComponent(m.symbolToken)}`; }
  else { headers["access-token"] = c.accessToken; headers.clientId = c.clientId; headers["Content-Type"] = "application/json"; url = "https://api.dhan.co/v2/marketfeed/ltp"; }
  const init = c.broker === "dhan" ? { method: "POST", headers, body: JSON.stringify({ [m.exchangeSegment || "NSE_EQ"]: [String(m.securityId)] }) } : { headers };
  const res = await fetch(url, { ...init, signal: timeout() });
  if (!res.ok) throw indianApiError(res, c.broker);
  const j = await res.json();
  const data = j.data;
  const val = c.broker === "kite" ? Object.values(data || {})[0]?.last_price : c.broker === "upstox" ? Object.values(data || {})[0]?.last_price : c.broker === "angel" ? data?.[0]?.ltp : data?.[m.exchangeSegment || "NSE_EQ"]?.[String(m.securityId)]?.last_price;
  if (!Number.isFinite(Number(val))) throw new Error("Broker did not return a price for the configured instrument.");
  return Number(val);
}
