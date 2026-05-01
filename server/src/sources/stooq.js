import { Source } from "./base.js";
import { sessionForUSEquity } from "../session.js";

function readTimeoutMs(envName, fallback) {
  const n = Number(process.env[envName] || fallback);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Stooq free CSV quote endpoint. No API key, no auth, no signup. Stooq does
// not WAF cloud/datacenter IPs the way Yahoo does, so this is the most
// reliable zero-key stock source for non-residential deployments.
//
// Symbol format: append a market suffix (lowercase) — ".us" for US stocks,
// ".uk" for London, ".de" for Frankfurt, etc. The default set covers the
// large-cap US universe + S&P 500 / Nasdaq 100 ETFs.
//
// Stooq's bulk-symbol mode ?s=aapl.us,msft.us is broken (collapses into a
// single N/D row), so we issue one request per symbol in parallel. With the
// default 5 s poll cadence and 9 symbols this is ~2 req/s — well within
// Stooq's tolerance.
//
// Free Stooq quotes are typically delayed by 15-20 minutes during US market
// hours; outside market hours you'll see the last close. For a "live" feel
// during the US session, prefer Yahoo (residential IPs) or Finnhub (key).
const URL = (sym) =>
  `https://stooq.com/q/l/?s=${encodeURIComponent(sym)}&f=sd2t2ohlcv&h&e=csv`;

const DEFAULT_SYMBOLS = [
  { symbol: "AAPL",  stooq: "aapl.us",  name: "Apple Inc."         },
  { symbol: "MSFT",  stooq: "msft.us",  name: "Microsoft Corp."    },
  { symbol: "GOOGL", stooq: "googl.us", name: "Alphabet Inc."      },
  { symbol: "AMZN",  stooq: "amzn.us",  name: "Amazon.com Inc."    },
  { symbol: "NVDA",  stooq: "nvda.us",  name: "NVIDIA Corp."       },
  { symbol: "META",  stooq: "meta.us",  name: "Meta Platforms"     },
  { symbol: "TSLA",  stooq: "tsla.us",  name: "Tesla Inc."         },
  { symbol: "SPY",   stooq: "spy.us",   name: "SPDR S&P 500 ETF"   },
  { symbol: "QQQ",   stooq: "qqq.us",   name: "Invesco QQQ Trust"  },
];

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/csv,text/plain,*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://stooq.com/",
};

// Hard cap on outbound HTTP calls so a hung Stooq response can't stack
// pending fetches on every poll tick.
async function fetchWithTimeout(url, init = {}, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Convert each entry into the canonical { symbol, stooq, name } shape.
function normalize(s) {
  if (typeof s === "string") {
    const stooq = s.includes(".") ? s.toLowerCase() : `${s.toLowerCase()}.us`;
    const symbol = s.split(".")[0].toUpperCase();
    return { symbol, stooq, name: symbol };
  }
  return {
    symbol: (s.symbol || s.stooq.split(".")[0]).toUpperCase(),
    stooq: s.stooq.toLowerCase(),
    name: s.name || s.symbol || s.stooq,
  };
}

export class StooqSource extends Source {
  constructor({ symbols, pollIntervalMs = 5000 } = {}) {
    super({ id: "stooq", name: "Stooq (free CSV polling)" });
    this.symbols = (symbols && symbols.length ? symbols : DEFAULT_SYMBOLS).map(normalize);
    this.pollIntervalMs = pollIntervalMs;
    // Stooq is often high-latency or filtered on VPN/corp networks; 5 s was
    // too aggressive and surfaced only Node's generic AbortError message.
    this.fetchTimeoutMs = Math.max(8000, readTimeoutMs("STOOQ_FETCH_TIMEOUT_MS", 25000));
    this._pollConcurrency = Math.min(
      3,
      Math.max(1, Number(process.env.STOOQ_POLL_CONCURRENCY || 3) || 3),
    );
    this._timer = null;
    this._pollInFlight = false;
    this._closing = false;
    this._lastPrice = new Map();
    this._consecErrors = 0;
  }

  isAvailable() { return typeof fetch === "function"; }

  getSymbols() {
    return this.symbols.map((s) => ({ symbol: s.symbol, name: s.name, source: this.id }));
  }

  start() {
    if (this._timer || this._closing) return;
    if (!this.isAvailable()) {
      this.setStatus("disabled", "global fetch() unavailable; need Node 18+");
      return;
    }
    this._closing = false;
    this.setStatus("connecting", `${this.symbols.length} symbols`);
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
          slice.map((meta) =>
            this._fetchOne(meta).catch((e) => { lastErr = e; return null; })
          )
        );
        results.push(...part);
      }

      const ticks = results.filter(Boolean);
      if (ticks.length === 0) {
        this._consecErrors++;
        const reason = lastErr?.message || "all polls failed";
        const hint =
          /timeout|Stooq timeout|cannot reach stooq\.com/i.test(reason)
            ? " — stooq.com blocked or very slow? Try VPN off, STOOQ_FETCH_TIMEOUT_MS=40000, or FINNHUB_API_KEY"
            : /fetch failed|ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|network error/i.test(reason)
              ? " — network/DNS cannot reach stooq.com (try different DNS/VPN/network)"
              : "";
        this.setStatus("error", `${reason}${hint} (${this._consecErrors}x)`);
        return;
      }

      let emitted = 0;
      for (const t of ticks) {
        // Only emit when price actually changes — Stooq returns the same close
        // until the next exchange tick, otherwise we'd spam identical ticks.
        const prev = this._lastPrice.get(t.symbol);
        if (prev != null && prev === t.price) continue;
        this._lastPrice.set(t.symbol, t.price);
        this.emit("tick", t);
        emitted++;
      }

      this._consecErrors = 0;
      this.setStatus(
        "live",
        emitted
          ? `${emitted} updated · ${ticks.length}/${this.symbols.length} fetched`
          : `${ticks.length}/${this.symbols.length} fetched · no changes`
      );
    } finally {
      this._pollInFlight = false;
    }
  }

  async _fetchOne(meta) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 700));
      try {
        const res = await fetchWithTimeout(
          URL(meta.stooq),
          { headers: HEADERS },
          this.fetchTimeoutMs,
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();

        // Stooq sometimes returns a 200 with a plain-text error body instead of
        // CSV — most commonly "Exceeded the daily hits limit" when the client IP
        // has burned through the free tier's daily quota. Surface that clearly so
        // it's not mistaken for a transient failure.
        if (!/^Symbol\s*,/i.test(text)) {
          const snippet = text.trim().split("\n")[0].slice(0, 120);
          throw new Error(`stooq: ${snippet || "non-CSV response"}`);
        }

        const rows = parseCsv(text);
        if (!rows.length) return null;
        const row = rows[0];

        const price  = Number(row.Close);
        const volume = Number(row.Volume) || 0;
        if (!Number.isFinite(price) || price <= 0) return null;

        const time = parseDate(row.Date, row.Time) || Date.now();
        return {
          source: this.id,
          symbol: meta.symbol,
          time,
          price,
          volume: Math.max(1, Math.round(volume / 60)),
          // Use the bar's actual exchange time so historical Stooq closes are
          // labeled with the session they actually represent (typically "regular").
          session: sessionForUSEquity(time),
        };
      } catch (e) {
        if (e?.name === "AbortError") continue;
        if (e?.message === "fetch failed") {
          const code = e?.cause?.code || "";
          const causeMsg = e?.cause?.message || "";
          const detail = [code, causeMsg].filter(Boolean).join(" ");
          throw new Error(`fetch failed${detail ? ` (${detail})` : ""}`);
        }
        throw e;
      }
    }
    throw new Error(
      `Stooq timeout after ${this.fetchTimeoutMs}ms (2 attempts) — cannot reach stooq.com`,
    );
  }
}

// Minimal CSV parser specific to Stooq's quote dump (header + rows, no
// embedded commas or quotes in the columns we care about).
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
