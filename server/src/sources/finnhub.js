import WebSocket from "ws";
import { Source } from "./base.js";
import { sessionForUSEquity } from "../session.js";

// Finnhub real-time trade stream. Requires a free API key.
// Docs: https://finnhub.io/docs/api/websocket-trades
const DEFAULT_SYMBOLS = [
  { symbol: "AAPL",  name: "Apple Inc."         },
  { symbol: "MSFT",  name: "Microsoft Corp."    },
  { symbol: "GOOGL", name: "Alphabet Inc."      },
  { symbol: "AMZN",  name: "Amazon.com Inc."    },
  { symbol: "NVDA",  name: "NVIDIA Corp."       },
  { symbol: "META",  name: "Meta Platforms"     },
  { symbol: "TSLA",  name: "Tesla Inc."         },
];

export class FinnhubSource extends Source {
  constructor({ apiKey, symbols } = {}) {
    super({ id: "finnhub", name: "Finnhub (live US stocks)" });
    this.apiKey = apiKey;
    this.symbols = (symbols && symbols.length ? symbols : DEFAULT_SYMBOLS).map((s) =>
      typeof s === "string" ? { symbol: s.toUpperCase(), name: s.toUpperCase() } : s
    );
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
      this.setStatus("disabled", "FINNHUB_API_KEY not set");
      return;
    }
    if (this._ws || this._closing) return;
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
    const ws = new WebSocket(`wss://ws.finnhub.io?token=${encodeURIComponent(this.apiKey)}`);
    this._ws = ws;

    ws.on("open", () => {
      this._reconnectAttempts = 0;
      for (const s of this.symbols) {
        ws.send(JSON.stringify({ type: "subscribe", symbol: s.symbol }));
      }
      this.setStatus("live", `${this.symbols.length} symbols subscribed`);
    });

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg?.type !== "trade" || !Array.isArray(msg.data)) return;
      for (const t of msg.data) {
        const time = Number(t.t) || Date.now();
        this.emit("tick", {
          source: this.id,
          symbol: t.s,
          time,
          price: Number(t.p),
          volume: Math.max(1, Math.round(Number(t.v) || 1)),
          session: sessionForUSEquity(time),
        });
      }
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
