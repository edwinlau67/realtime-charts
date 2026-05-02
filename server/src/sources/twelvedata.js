import WebSocket from "ws";
import { Source } from "./base.js";
import { sessionForUSEquity, SESSION_ALWAYS_OPEN } from "../session.js";

// Twelve Data real-time WebSocket feed. Free tier supports up to 8 concurrent
// symbols. Requires TWELVE_DATA_API_KEY.
// Docs: https://twelvedata.com/docs#websocket
//
// Two quirks vs other adapters:
//   1. Server sends {"event":"heartbeat"} every ~10s; must echo it back or the
//      connection drops silently after ~30s.
//   2. Timestamps are Unix epoch in seconds, not milliseconds.
const DEFAULT_SYMBOLS = [
  { symbol: "AAPL",    name: "Apple Inc.",        forex: false },
  { symbol: "MSFT",    name: "Microsoft Corp.",   forex: false },
  { symbol: "GOOGL",   name: "Alphabet Inc.",     forex: false },
  { symbol: "AMZN",    name: "Amazon.com Inc.",   forex: false },
  { symbol: "NVDA",    name: "NVIDIA Corp.",      forex: false },
  { symbol: "EUR/USD", name: "Euro / US Dollar",  forex: true  },
  { symbol: "GBP/USD", name: "Pound / US Dollar", forex: true  },
  { symbol: "USD/JPY", name: "US Dollar / Yen",   forex: true  },
];

export class TwelveDataSource extends Source {
  constructor({ apiKey, symbols } = {}) {
    super({ id: "twelvedata", name: "Twelve Data (stocks + forex)" });
    this.apiKey = apiKey;
    this.symbols = (symbols && symbols.length
      ? symbols.map((s) => (typeof s === "string" ? { symbol: s, name: s, forex: s.includes("/") } : s))
      : DEFAULT_SYMBOLS
    );
    // Set for O(1) session lookup — symbols containing "/" are forex (always open).
    this._forexSet = new Set(this.symbols.filter((s) => s.forex).map((s) => s.symbol));
    this._ws = null;
    this._closing = false;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
  }

  isAvailable() { return Boolean(this.apiKey); }

  getSymbols() {
    return this.symbols.map((s) => ({
      symbol: s.symbol,
      name: s.name,
      source: this.id,
    }));
  }

  start() {
    if (!this.isAvailable()) {
      this.setStatus("disabled", "TWELVE_DATA_API_KEY not set");
      return;
    }
    if (this._ws || this._closing) return;
    this._closing = false;
    this._connect();
  }

  stop() {
    this._closing = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    if (this._ws) {
      try { this._ws.close(); } catch { /* noop */ }
      this._ws = null;
    }
    this.setStatus("idle", "");
  }

  _connect() {
    this.setStatus("connecting", `${this.symbols.length} symbols`);
    const url = `wss://ws.twelvedata.com/v1/quotes/price?apikey=${encodeURIComponent(this.apiKey)}`;
    const ws = new WebSocket(url);
    this._ws = ws;

    ws.on("open", () => {
      this._reconnectAttempts = 0;
      const symbolList = this.symbols.map((s) => s.symbol).join(",");
      ws.send(JSON.stringify({ action: "subscribe", params: { symbols: symbolList } }));
      this.setStatus("live", `${this.symbols.length} symbols subscribed`);
    });

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      // Echo heartbeat back before any early-return — missing this drops the connection.
      if (msg?.event === "heartbeat") {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
        return;
      }
      if (msg?.event !== "price") return;
      const time = Number(msg.timestamp) * 1000; // epoch seconds → ms
      const isForex = this._forexSet.has(msg.symbol);
      this.emit("tick", {
        source: this.id,
        symbol: msg.symbol,
        time,
        price: Number(msg.price),
        volume: Math.max(1, Math.round(Number(msg.day_volume) || 1)),
        session: isForex ? SESSION_ALWAYS_OPEN : sessionForUSEquity(time),
      });
    });

    ws.on("close", () => {
      this._ws = null;
      if (this._closing) return;
      const delay = Math.min(1000 * 2 ** this._reconnectAttempts++, 30000);
      this.setStatus("error", `disconnected; retry in ${Math.round(delay / 1000)}s`);
      this._reconnectTimer = setTimeout(() => this._connect(), delay);
    });

    ws.on("error", (err) => {
      this.setStatus("error", err.message || "websocket error");
      try { ws.close(); } catch { /* noop */ }
    });
  }
}
