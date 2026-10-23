// Earnings and dividend calendars, news, financial statements and key stats. Nasdaq's public API
// for US stocks; Cointelegraph's and Decrypt's RSS feeds for crypto headlines.
import { getJson, cached, NQ, resolve } from "./providers.js";

const OFFLINE = process.env.QT_OFFLINE === "1";
const num = (s) => {
  const v = parseFloat(String(s ?? "").replace(/[$,%\s]/g, ""));
  return Number.isFinite(v) ? v : null;
};
const ymd = (d) => d.toISOString().slice(0, 10);

// The next n weekdays starting today (UTC).
function weekdays(n) {
  const out = [];
  const d = new Date();
  while (out.length < n) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(ymd(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export async function earnings(days = 5) {
  if (OFFLINE) return [];
  const dates = weekdays(Math.min(10, Math.max(1, days)));
  const perDay = await Promise.all(
    dates.map((date) =>
      cached(`earnings:${date}`, 30 * 60e3, async () => {
        const j = await getJson(
          `https://api.nasdaq.com/api/calendar/earnings?date=${date}`,
          NQ,
        );
        return (j?.data?.rows || []).map((r) => ({
          date,
          symbol: `US:${r.symbol}`,
          ticker: r.symbol,
          name: r.name,
          when:
            r.time === "time-pre-market"
              ? "Before the open"
              : r.time === "time-after-hours"
                ? "After the close"
                : "Time not given",
          marketCap: num(r.marketCap),
          epsForecast: r.epsForecast || "",
          quarter: r.fiscalQuarterEnding || "",
          lastYearEps: r.lastYearEPS || "",
        }));
      }).catch(() => []),
    ),
  );
  return perDay.flat();
}

// NSE's public event calendar lists board meetings that have scheduled financial results.
export async function indianEarnings() {
  if (OFFLINE) return [];
  return cached("earnings:india:events", 30 * 60e3, async () => {
    const rows = await getJson("https://www.nseindia.com/api/event-calendar", {
      "User-Agent": "Mozilla/5.0 QuantTerminal",
      Accept: "application/json, text/plain, */*",
      Referer: "https://www.nseindia.com/",
    });
    return (Array.isArray(rows) ? rows : []).filter((r) => /financial results/i.test(r.purpose || ""))
      .map((r) => {
        const ms = Date.parse(`${r.date || ""} 12:00:00`);
        return {
        date: Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "",
        symbol: `YAHOO:${r.symbol}.NS`, ticker: r.symbol, name: r.company,
        when: "NSE board meeting", epsForecast: "", lastYearEps: "", purpose: r.purpose, description: r.bm_desc,
      };}).filter((r) => r.date).sort((a,b)=>a.date.localeCompare(b.date));
  });
}

export async function dividends(days = 5) {
  if (OFFLINE) return [];
  const dates = weekdays(Math.min(10, Math.max(1, days)));
  const perDay = await Promise.all(
    dates.map((date) =>
      cached(`dividends:${date}`, 30 * 60e3, async () => {
        const j = await getJson(
          `https://api.nasdaq.com/api/calendar/dividends?date=${date}`,
          NQ,
        );
        return (j?.data?.calendar?.rows || []).map((r) => ({
          date,
          symbol: `US:${r.symbol}`,
          ticker: r.symbol,
          name: r.companyName,
          exDate: r.dividend_Ex_Date,
          payDate: r.payment_Date,
          recordDate: r.record_Date,
          amount: r.dividend_Rate,
          annual: r.indicated_Annual_Dividend,
        }));
      }).catch(() => []),
    ),
  );
  return perDay.flat();
}

// Corporate-action dates exposed by Yahoo's public chart endpoint. This is
// separate from the quote/candle request so event markers can be toggled.
export async function chartEvents(symbol) {
  if (OFFLINE) return { dividends: [], splits: [] };
  const sym = await resolve(symbol);
  const yahooSymbol = sym.exchange === "US" ? sym.ticker : sym.ticker;
  return cached(`chart-events:${yahooSymbol}`, 60 * 60e3, async () => {
    const j = await getJson(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=5y&events=div%2Csplits`,
      { "User-Agent": "Mozilla/5.0 QuantTerminal", Accept: "application/json" },
    );
    const events = j?.chart?.result?.[0]?.events || {};
    const rows = (key, label) => Object.values(events[key] || {}).map((e) => ({
      time: Number(e.date), date: new Date(Number(e.date) * 1000).toISOString().slice(0, 10),
      title: label, detail: key === "dividends" ? `Dividend ${e.amount ?? ""}`.trim() : `Split ${e.numerator ?? ""}:${e.denominator ?? ""}`,
    })).filter((e) => Number.isFinite(e.time));
    return { dividends: rows("dividends", "Dividend"), splits: rows("splits", "Split") };
  });
}

// ---------- news ----------
const COIN_NAMES = {
  BTC: ["bitcoin", "btc"],
  ETH: ["ethereum", "ether", "eth"],
  SOL: ["solana", "sol"],
  XRP: ["xrp", "ripple"],
  BNB: ["bnb", "binance coin"],
  DOGE: ["dogecoin", "doge"],
  ADA: ["cardano", "ada"],
  AVAX: ["avalanche", "avax"],
  LINK: ["chainlink", "link"],
  DOT: ["polkadot"],
  LTC: ["litecoin", "ltc"],
  TRX: ["tron", "trx"],
  TON: ["toncoin", "ton"],
  SHIB: ["shiba inu", "shib"],
  PEPE: ["pepe"],
  SUI: ["sui"],
  NEAR: ["near protocol", "near"],
  ZEC: ["zcash", "zec"],
};
const decode = (s) =>
  s
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/<[^>]+>/g, "")
    .trim();

export function parseRss(xml, source) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const pick = (tag) =>
      decode(
        (new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(block) ||
          [])[1] || "",
      );
    const title = pick("title");
    if (!title) continue;
    items.push({
      title,
      url: pick("link"),
      source,
      time: Date.parse(pick("pubDate")) || null,
      summary: pick("description").slice(0, 280),
    });
  }
  return items;
}

async function cryptoNews() {
  return cached("news:crypto", 10 * 60e3, async () => {
    const feeds = [
      ["https://cointelegraph.com/rss", "Cointelegraph"],
      ["https://decrypt.co/feed", "Decrypt"],
    ];
    const lists = await Promise.all(
      feeds.map(async ([url, name]) => {
        try {
          const res = await fetch(url, {
            headers: { "User-Agent": "Mozilla/5.0 QuantTerminal" },
            signal: AbortSignal.timeout(10000),
          });
          return res.ok ? parseRss(await res.text(), name) : [];
        } catch {
          return [];
        }
      }),
    );
    return lists.flat().sort((a, b) => (b.time || 0) - (a.time || 0));
  });
}

async function indiaNews(symbol) {
  const items = await cached("news:india:rss", 15 * 60e3, async () => {
    const sources = [
      ["https://www.moneycontrol.com/rss/marketreports.xml", "Moneycontrol"],
      ["https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms", "Economic Times"],
    ];
    const lists = await Promise.all(sources.map(async ([url, source]) => {
      try {
        const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 QuantTerminal", Accept: "application/rss+xml, application/xml, text/xml" }, signal: AbortSignal.timeout(10000) });
        return r.ok ? parseRss(await r.text(), source) : [];
      } catch { return []; }
    }));
    return lists.flat().sort((a,b)=>(b.time||0)-(a.time||0));
  });
  const words = String(symbol?.ticker || "").replace(/\.(NS|BO)$/i, "").toLowerCase();
  const hits = items.filter(n => `${n.title} ${n.summary}`.toLowerCase().includes(words));
  return { items: (hits.length >= 3 ? hits : items).slice(0, 30), note: hits.length >= 3 ? `Headlines mentioning ${words.toUpperCase()} from Moneycontrol and Economic Times` : "Latest market headlines from Moneycontrol and Economic Times" };
}

export async function news(symbol) {
  if (OFFLINE) return { items: [], note: "" };
  const sym = await resolve(symbol);
  if (["BINANCE", "COINBASE", "KRAKEN"].includes(sym.exchange)) {
    const base =
      sym.ticker
        .replace(/-/g, "")
        .replace(/(USDT|USDC|FDUSD|USD|BTC|ETH|EUR)$/, "")
        .replace(/^XBT$/, "BTC") || "BTC";
    const all = await cryptoNews();
    const words = COIN_NAMES[base] || [base.toLowerCase()];
    const re = new RegExp(
      `\\b(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
      "i",
    );
    const hits = all.filter((n) => re.test(`${n.title} ${n.summary}`));
    return hits.length >= 3
      ? { items: hits.slice(0, 30), note: `Headlines mentioning ${base}` }
      : {
          items: all.slice(0, 30),
          note: `Few headlines mention ${base} right now, so these are the latest crypto headlines`,
        };
  }
  if (sym.exchange === "US") {
    const items = await cached(`news:${sym.ticker}`, 10 * 60e3, async () => {
      for (const cls of ["stocks", "etf", "index"]) {
        const j = await getJson(
          `https://api.nasdaq.com/api/news/topic/articlebysymbol?q=${encodeURIComponent(`${sym.ticker.toLowerCase()}|${cls}`)}&offset=0&limit=30&fallback=true`,
          NQ,
        ).catch(() => null);
        const rows = j?.data?.rows || [];
        if (rows.length)
          return rows.map((r) => ({
            title: r.title,
            url: r.url?.startsWith("http")
              ? r.url
              : `https://www.nasdaq.com${r.url}`,
            source: r.publisher,
            time: Date.parse(r.created) || null,
            ago: r.ago,
            summary: r.description || "",
          }));
      }
      return [];
    });
    return {
      items,
      note: items.length
        ? `Headlines for ${sym.ticker} from Nasdaq`
        : `No headlines found for ${sym.ticker}`,
    };
  }
  if (sym.exchange === "YAHOO" && (/\.(NS|BO)$/i.test(sym.ticker) || ["^NSEI", "^BSESN"].includes(sym.ticker.toUpperCase()))) return indiaNews(sym);
  return {
    items: [],
    note: "Headlines are available for crypto and US stocks.",
  };
}

// ---------- fundamentals ----------
function table(t) {
  if (!t?.headers || !t?.rows) return null;
  const keys = Object.keys(t.headers).filter((k) => k !== "value1");
  return {
    periods: keys.map((k) => t.headers[k]),
    rows: t.rows.map((r) => ({
      label: r.value1,
      values: keys.map((k) => r[k] ?? ""),
    })),
  };
}

export async function financials(symbol, frequency = "annual") {
  if (OFFLINE) return null;
  const sym = await resolve(symbol);
  const indian =
    sym.exchange === "YAHOO" && /\.(NS|BO)$/i.test(sym.ticker);
  if (indian) return indianFinancials(sym, frequency);
  if (sym.exchange !== "US")
    throw Object.assign(
      new Error("Financial statements are available for US and NSE/BSE stocks."),
      { status: 422 },
    );
  const f = frequency === "quarterly" ? 2 : 1;
  return cached(`fin:${sym.ticker}:${f}`, 6 * 3600e3, async () => {
    const [fin, sum, ed] = await Promise.all([
      getJson(
        `https://api.nasdaq.com/api/company/${sym.ticker}/financials?frequency=${f}`,
        NQ,
      ).catch(() => null),
      getJson(
        `https://api.nasdaq.com/api/quote/${sym.ticker}/summary?assetclass=stocks`,
        NQ,
      ).catch(() => null),
      getJson(
        `https://api.nasdaq.com/api/analyst/${sym.ticker}/earnings-date`,
        NQ,
      ).catch(() => null),
    ]);
    const d = fin?.data || {};
    const stats = Object.values(sum?.data?.summaryData || {})
      .map((x) => ({ label: x.label, value: x.value }))
      .filter((x) => x.value && x.value !== "N/A");
    const out = {
      symbol: sym.id,
      frequency,
      stats,
      nextEarnings: (ed?.data?.reportText || "").replace(/\s+/g, " ").trim(),
      income: table(d.incomeStatementTable),
      balance: table(d.balanceSheetTable),
      cashflow: table(d.cashFlowTable),
      ratios: table(d.financialRatiosTable),
      currency: "USD",
      source: "Nasdaq",
      note: "Statement figures are in thousands of US dollars, as Nasdaq reports them.",
    };
    if (!out.income && !stats.length)
      throw Object.assign(
        new Error(
          `Nasdaq has no financials for ${sym.ticker} (ETFs and funds don't file them).`,
        ),
        { status: 404 },
      );
    return out;
  });
}

const YAHOO_HEADERS = {
  "User-Agent": "Mozilla/5.0",
  Accept: "application/json, text/plain, */*",
};

// Yahoo's quoteSummary endpoint sometimes accepts a direct request and sometimes asks for a
// browser cookie and crumb. Handle both, so Indian annual and quarterly statements share one path.
async function yahooSummary(ticker, modules) {
  const base = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}`;
  const query = `modules=${encodeURIComponent(modules.join(","))}`;
  try {
    const direct = await getJson(`${base}?${query}`, YAHOO_HEADERS);
    if (direct?.quoteSummary?.result?.[0]) return direct.quoteSummary.result[0];
    if (direct?.quoteSummary?.error)
      throw new Error(direct.quoteSummary.error.description || "Yahoo returned no financial data.");
  } catch {
    // Retry with Yahoo's cookie/crumb session below.
  }

  const timeout = { signal: AbortSignal.timeout(10000) };
  const cookieResponse = await fetch("https://fc.yahoo.com", {
    headers: YAHOO_HEADERS,
    ...timeout,
  }).catch(() => null);
  const setCookies = cookieResponse?.headers.getSetCookie?.() || [cookieResponse?.headers.get("set-cookie")].filter(Boolean);
  const cookie = setCookies.map((value) => value.split(";")[0]).join("; ");
  const crumbResponse = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: { ...YAHOO_HEADERS, ...(cookie ? { Cookie: cookie } : {}) },
    ...timeout,
  });
  const crumb = (await crumbResponse.text()).trim();
  if (!crumbResponse.ok || !crumb)
    throw Object.assign(new Error(`Yahoo Finance did not provide a data session for ${ticker}.`), { status: 502 });
  const url = `${base}?${query}&crumb=${encodeURIComponent(crumb)}`;
  const response = await fetch(url, {
    headers: { ...YAHOO_HEADERS, ...(cookie ? { Cookie: cookie } : {}) },
    ...timeout,
  });
  if (!response.ok)
    throw Object.assign(new Error(`Yahoo Finance returned HTTP ${response.status} for ${ticker} financials.`), { status: response.status === 404 ? 404 : 502 });
  const json = await response.json();
  const result = json?.quoteSummary?.result?.[0];
  if (!result) {
    const message = json?.quoteSummary?.error?.description || `Yahoo has no financial statements for ${ticker}.`;
    throw Object.assign(new Error(message), { status: 404 });
  }
  return result;
}

function yahooStatement(statement, currency) {
  if (!Array.isArray(statement) || !statement.length) return null;
  const fields = [...new Set(statement.flatMap((period) => Object.keys(period || {})))].filter(
    (key) => key !== "endDate" && key !== "maxAge" &&
      statement.some((period) => Number.isFinite(period?.[key]?.raw)),
  );
  const format = new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
    maximumFractionDigits: 2,
  });
  const label = (key) => key.replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
  return {
    periods: statement.map((period) => period.endDate?.fmt || "Period"),
    rows: fields.map((key) => ({
      label: label(key),
      values: statement.map((period) => {
        const value = period?.[key]?.raw;
        return Number.isFinite(value) ? format.format(value) : "—";
      }),
    })),
  };
}

function yahooValue(value) {
  return value?.fmt ?? value?.longFmt ?? (Number.isFinite(value?.raw) ? String(value.raw) : "");
}

async function indianFinancials(sym, frequency) {
  const quarterly = frequency === "quarterly";
  const modules = [
    quarterly ? "incomeStatementHistoryQuarterly" : "incomeStatementHistory",
    quarterly ? "balanceSheetHistoryQuarterly" : "balanceSheetHistory",
    quarterly ? "cashflowStatementHistoryQuarterly" : "cashflowStatementHistory",
    "defaultKeyStatistics",
    "financialData",
    "price",
    "calendarEvents",
  ];
  return cached(`fin:${sym.ticker}:${quarterly ? 2 : 1}`, 6 * 3600e3, async () => {
    const data = await yahooSummary(sym.ticker, modules);
    const currency = data.price?.currency || "INR";
    const info = { ...(data.defaultKeyStatistics || {}), ...(data.financialData || {}), ...(data.price || {}) };
    const statNames = [
      ["marketCap", "Market capitalization"],
      ["trailingEps", "Trailing EPS"],
      ["forwardEps", "Forward EPS"],
      ["enterpriseValue", "Enterprise value"],
      ["trailingPE", "Trailing P/E"],
      ["forwardPE", "Forward P/E"],
      ["priceToBook", "Price / book"],
      ["profitMargins", "Profit margin"],
      ["operatingMargins", "Operating margin"],
      ["returnOnEquity", "Return on equity"],
      ["returnOnAssets", "Return on assets"],
      ["revenueGrowth", "Revenue growth"],
      ["earningsGrowth", "Earnings growth"],
      ["debtToEquity", "Debt / equity"],
      ["currentRatio", "Current ratio"],
      ["beta", "Beta"],
    ];
    const stats = statNames
      .filter(([key]) => info[key] && yahooValue(info[key]))
      .map(([key, label]) => ({ label, value: yahooValue(info[key]) }));
    const ratios = {
      periods: ["Latest"],
      rows: statNames
        .filter(([key]) => info[key] && yahooValue(info[key]))
        .map(([key, label]) => ({ label, values: [yahooValue(info[key])] })),
    };
    const income = yahooStatement(data[modules[0]]?.incomeStatementHistory, currency);
    const balance = yahooStatement(data[modules[1]]?.balanceSheetStatements, currency);
    const cashflow = yahooStatement(data[modules[2]]?.cashflowStatements, currency);
    const earningsDate = data.calendarEvents?.earnings?.earningsDate?.[0]?.fmt || "";
    const out = {
      symbol: sym.id,
      frequency,
      stats,
      nextEarnings: earningsDate ? `Next earnings date: ${earningsDate}` : "",
      income,
      balance,
      cashflow,
      ratios: ratios.rows.length ? ratios : null,
      currency,
      source: "Yahoo Finance",
      note: `Statement figures are shown in ${currency}. Yahoo Finance reports these company figures.`,
    };
    if (!out.income && !out.balance && !out.cashflow && !stats.length)
      throw Object.assign(new Error(`Yahoo Finance has no statements for ${sym.ticker}.`), { status: 404 });
    return out;
  });
}
