import { Source } from "./base.js";
import { sessionForUSEquity } from "../session.js";

// Yahoo Finance public chart endpoint. No API key, no auth, no signup.
// Used by yfinance, node-yahoo-finance, and many other open-source projects.
//
// We poll every `pollIntervalMs` (default 3s) and emit one tick per symbol
// per poll cycle using the latest close from the 1-minute bar series. Volume
// emitted is the delta vs the previous poll within the same bar, so the
// aggregator's running sum mirrors real intraday volume.
//
// The chart endpoint returns intraday data for stocks, ETFs, indices, FX
// pairs, mutual funds, and even Yahoo's own crypto tickers — anything Yahoo
// quotes will work here.
// Yahoo serves the chart endpoint from two interchangeable hosts. We try them
// in order and fall back if one returns 429 (which datacenter/cloud IPs hit
// commonly). On a residential IP either host works fine.
const HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
const URL = (host, sym) =>
  `https://${host}/v8/finance/chart/${encodeURIComponent(sym)}` +
  `?interval=1m&range=1d&includePrePost=true`;
const STOOQ_URL = (sym) =>
  `https://stooq.com/q/l/?s=${encodeURIComponent(toStooqSymbol(sym))}&f=sd2t2ohlcv&h&e=csv`;

// Hard cap on outbound HTTP calls. Without this a hung upstream (Yahoo
// occasionally holds connections open instead of returning 429) lets every
// poll tick stack a new pending fetch on top of the previous one until we
// run out of sockets / memory.
const FETCH_TIMEOUT_MS = 5000;
async function fetchWithTimeout(url, init = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

const DEFAULT_SYMBOLS = [
  { symbol: "AAPL",  name: "Apple Inc."         },
  { symbol: "MSFT",  name: "Microsoft Corp."    },
  { symbol: "GOOGL", name: "Alphabet Inc."      },
  { symbol: "AMZN",  name: "Amazon.com Inc."    },
  { symbol: "NVDA",  name: "NVIDIA Corp."       },
  { symbol: "META",  name: "Meta Platforms"     },
  { symbol: "TSLA",  name: "Tesla Inc."         },
  { symbol: "SPY",   name: "SPDR S&P 500 ETF"   },
  { symbol: "QQQ",   name: "Invesco QQQ Trust"  },
];

// Browser-like UA — Yahoo will return 401/403 to the default Node UA.
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json,text/plain,*/*",
};
const CSV_HEADERS = {
  ...HEADERS,
  "Accept": "text/csv,text/plain,*/*",
};

export class YahooSource extends Source {
  constructor({ symbols, pollIntervalMs = 3000 } = {}) {
    super({ id: "yahoo", name: "Yahoo Finance (free polling)" });
    this.symbols = (symbols && symbols.length ? symbols : DEFAULT_SYMBOLS).map((s) =>
      typeof s === "string" ? { symbol: s.toUpperCase(), name: s.toUpperCase() } : s
    );
    this.pollIntervalMs = pollIntervalMs;
    this._timer = null;
    this._closing = false;
    this._lastBarVolume = new Map(); // symbol -> last cumulative volume seen for current bar
    this._lastBarTs     = new Map(); // symbol -> last bar timestamp seen
    this._consecErrors  = 0;
    this._usingStooqFallback = false;
  }

  isAvailable() {
    return typeof fetch === "function"; // Node 18+
  }

  getSymbols() {
    return this.symbols.map((s) => ({
      symbol: s.symbol,
      name: s.name,
      source: this.id,
    }));
  }

  start() {
    if (this._timer || this._closing) return;
    if (!this.isAvailable()) {
      this.setStatus("disabled", "global fetch() unavailable; need Node 18+");
      return;
    }
    this._closing = false;
    this.setStatus("connecting", `${this.symbols.length} symbols`);
    // Fire one immediately so the UI shows data quickly, then poll on interval.
    this._poll();
    this._timer = setInterval(() => this._poll(), this.pollIntervalMs);
  }

  stop() {
    this._closing = true;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this.setStatus("idle", "");
  }

  async _poll() {
    if (this._closing) return;
    let lastErr = null;
    const results = await Promise.all(
      this.symbols.map((s) =>
        this._fetchOne(s.symbol).catch((e) => { lastErr = e; return null; })
      )
    );

    const ok = results.filter(Boolean);
    if (ok.length === 0) {
      this._consecErrors++;
      const reason = lastErr?.message || "all polls failed";
      const hint = /\b429\b/.test(reason)
        ? " (Yahoo rate-limited this IP; try YAHOO_POLL_MS=10000 or use stooq instead)"
        : "";
      this.setStatus("error", `${reason}${hint} (${this._consecErrors}x)`);
      return;
    }
    this._consecErrors = 0;
    const suffix = this._usingStooqFallback ? " · failover: stooq" : "";
    this.setStatus("live", `${ok.length}/${this.symbols.length} symbols · poll ${this.pollIntervalMs}ms${suffix}`);
    for (const tick of ok) this.emit("tick", tick);
  }

  async _fetchOne(symbol) {
    let lastStatus = 0;
    let data = null;
    for (const host of HOSTS) {
      const res = await fetchWithTimeout(URL(host, symbol), { headers: HEADERS });
      if (res.ok) { data = await res.json(); break; }
      lastStatus = res.status;
      if (res.status !== 429 && res.status !== 401) break;
    }
    if (!data) {
      // Auto failover path: Yahoo throttles datacenter/shared egress IPs often.
      // When it does, try Stooq for the same symbol and keep streaming.
      if (lastStatus === 429 || lastStatus === 401) {
        const fallback = await this._fetchOneFromStooq(symbol);
        if (fallback) {
          this._usingStooqFallback = true;
          return fallback;
        }
      }
      throw new Error(`HTTP ${lastStatus}`);
    }
    this._usingStooqFallback = false;

    const result = data?.chart?.result?.[0];
    const meta   = result?.meta;
    const ts     = result?.timestamp || [];
    const quote  = result?.indicators?.quote?.[0];
    if (!meta) return null;

    // Walk back from the most recent bar to find one with a non-null close
    // (Yahoo sometimes returns null for the very latest bar mid-formation).
    let price = null;
    let barTs = null;
    let barVol = null;
    for (let i = ts.length - 1; i >= 0 && i > ts.length - 6; i--) {
      const c = quote?.close?.[i];
      if (c != null && Number.isFinite(c)) {
        price  = c;
        barTs  = ts[i] * 1000;
        barVol = Number(quote.volume?.[i] ?? 0);
        break;
      }
    }

    // Fallback to meta.regularMarketPrice if no usable bar (e.g. fresh open,
    // halted symbol, or thinly-traded ticker).
    if (price == null) {
      price  = Number(meta.regularMarketPrice);
      barTs  = (Number(meta.regularMarketTime) || Math.floor(Date.now() / 1000)) * 1000;
      barVol = 0;
    }
    if (!Number.isFinite(price)) return null;

    // Volume delta within the same bar; full volume on a new bar.
    const prevTs  = this._lastBarTs.get(symbol);
    const prevVol = this._lastBarVolume.get(symbol) ?? 0;
    const volDelta = barTs === prevTs ? Math.max(0, barVol - prevVol) : (barVol || 0);
    this._lastBarTs.set(symbol, barTs);
    this._lastBarVolume.set(symbol, barVol);

    const time = Date.now();
    return {
      source: this.id,
      symbol,
      // Use poll time (not bar time) so successive ticks within a 1m bar
      // distribute across the chart's sub-minute candles.
      time,
      price,
      volume: Math.max(1, Math.round(volDelta)),
      session: sessionForUSEquity(time),
    };
  }

  async _fetchOneFromStooq(symbol) {
    const res = await fetchWithTimeout(STOOQ_URL(symbol), { headers: CSV_HEADERS });
    if (!res.ok) return null;
    const text = await res.text();
    if (!/^Symbol\s*,/i.test(text)) return null;
    const rows = parseCsv(text);
    if (!rows.length) return null;
    const row = rows[0];
    const price = Number(row.Close);
    const vol = Number(row.Volume) || 0;
    if (!Number.isFinite(price) || price <= 0) return null;
    const time = parseDate(row.Date, row.Time) || Date.now();
    return {
      source: this.id,
      symbol,
      time,
      price,
      volume: Math.max(1, Math.round(vol / 60)),
      session: sessionForUSEquity(time),
    };
  }
}

function toStooqSymbol(symbol) {
  // Basic US-equity mapping: AAPL -> aapl.us
  // Keep existing exchange suffixes if caller already provided one.
  if (symbol.includes(".")) return symbol.toLowerCase();
  return `${symbol.toLowerCase()}.us`;
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cols = line.split(",");
    const row = {};
    for (let i = 0; i < headers.length; i++) row[headers[i]] = cols[i];
    return row;
  });
}

function parseDate(date, time) {
  if (!date || date === "N/D") return null;
  const ms = Date.parse(`${date}T${time || "00:00:00"}Z`);
  return Number.isFinite(ms) ? ms : null;
}
