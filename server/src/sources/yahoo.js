import { Source } from "./base.js";
import { sessionForUSEquity } from "../session.js";

function readTimeoutMs(envName, fallback) {
  const n = Number(process.env[envName] || fallback);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

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

// Hard cap on outbound HTTP calls. Without this a hung upstream (Yahoo
// occasionally holds connections open instead of returning 429) lets every
// poll tick stack a new pending fetch on top of the previous one until we
// run out of sockets / memory.
async function fetchWithTimeout(url, init = {}, timeoutMs) {
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

// Browser-like headers — Yahoo returns 401/403/429 more aggressively to bare
// Node clients; Referer/Origin match what finance.yahoo.com sends.
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json,text/plain,*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://finance.yahoo.com/",
  "Origin": "https://finance.yahoo.com",
};
export class YahooSource extends Source {
  constructor({ symbols, pollIntervalMs = 3000 } = {}) {
    super({ id: "yahoo", name: "Yahoo Finance (free polling)" });
    this.symbols = (symbols && symbols.length ? symbols : DEFAULT_SYMBOLS).map((s) =>
      typeof s === "string" ? { symbol: s.toUpperCase(), name: s.toUpperCase() } : s
    );
    this.pollIntervalMs = pollIntervalMs;
    // Datacenter / VPN egress often needs a longer budget than 5 s.
    this.yahooTimeoutMs = Math.max(5000, readTimeoutMs("YAHOO_FETCH_TIMEOUT_MS", 15000));
    this._pollConcurrency = Math.min(
      4,
      Math.max(1, Number(process.env.YAHOO_POLL_CONCURRENCY || 4) || 4),
    );
    this._timer = null;
    this._pollInFlight = false;
    this._closing = false;
    this._lastBarVolume = new Map(); // symbol -> last cumulative volume seen for current bar
    this._lastBarTs     = new Map(); // symbol -> last bar timestamp seen
    this._consecErrors  = 0;
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
    if (this._pollInFlight) return;
    this._pollInFlight = true;
    let lastErr = null;
    try {
      const results = [];
      const n = this.symbols.length;
      const batch = Math.min(this._pollConcurrency, n);
      for (let i = 0; i < n; i += batch) {
        const slice = this.symbols.slice(i, i + batch);
        const part = await Promise.all(
          slice.map((s) =>
            this._fetchOne(s.symbol).catch((e) => { lastErr = e; return null; })
          )
        );
        results.push(...part);
      }

      const ok = results.filter(Boolean);
      if (ok.length === 0) {
        this._consecErrors++;
        const reason = lastErr?.message || "all polls failed";
        let hint = "";
        if (/\b429\b/.test(reason)) {
          hint = " (Yahoo rate-limited; try YAHOO_POLL_MS=15000, residential IP, or FINNHUB_API_KEY)";
        } else if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT/i.test(reason)) {
          hint = " (network/DNS issue reaching Yahoo host)";
        } else if (/timeout|aborted/i.test(reason)) {
          hint = " (upstream slow or blocked; increase YAHOO_FETCH_TIMEOUT_MS or use finnhub)";
        }
        this.setStatus("error", `${reason}${hint} (${this._consecErrors}x)`);
        return;
      }
      this._consecErrors = 0;
      this.setStatus("live", `${ok.length}/${this.symbols.length} symbols · poll ${this.pollIntervalMs}ms`);
      for (const tick of ok) this.emit("tick", tick);
    } finally {
      this._pollInFlight = false;
    }
  }

  async _fetchOne(symbol) {
    let lastStatus = 0;
    let lastNetErr = null;
    let data = null;
    for (const host of HOSTS) {
      let res = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          res = await fetchWithTimeout(
            URL(host, symbol),
            { headers: HEADERS },
            this.yahooTimeoutMs,
          );
          break;
        } catch (e) {
          lastNetErr = e;
          if (e?.message === "fetch failed") {
            const code = e?.cause?.code || "";
            const causeMsg = e?.cause?.message || "";
            const detail = [code, causeMsg].filter(Boolean).join(" ");
            lastNetErr = new Error(`fetch failed${detail ? ` (${detail})` : ""}`);
          }
          if (e?.name === "AbortError" && attempt === 0) {
            await new Promise((r) => setTimeout(r, 400));
            continue;
          }
          res = null;
          break;
        }
      }
      if (!res) continue;
      if (res.ok) {
        try {
          data = await res.json();
        } catch {
          data = null;
        }
        if (data) break;
        continue;
      }
      lastStatus = res.status;
      if (res.status !== 429 && res.status !== 401) break;
    }
    if (!data) {
      if (lastNetErr) {
        const msg = lastNetErr.name === "AbortError"
          ? `Yahoo timeout after ${this.yahooTimeoutMs}ms`
          : `${lastNetErr.message || "network error"}`;
        throw new Error(msg);
      }
      throw new Error(
        lastStatus
          ? `HTTP ${lastStatus}`
          : "Yahoo unreachable",
      );
    }

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

}
