import WebSocket from "ws";
import { Source } from "./base.js";
import { sessionForUSEquity } from "../session.js";

// Alpaca real-time trade stream via the IEX feed (free paper account).
// Requires ALPACA_API_KEY and ALPACA_API_SECRET.
// Docs: https://docs.alpaca.markets/reference/websocket-streaming
//
// Auth is two-step: send auth on open, then subscribe only after receiving
// {"T":"success","msg":"authenticated"}. Subscribing before the ack results
// in a silent drop.
const DEFAULT_SYMBOLS = [
  { symbol: "AAPL",  name: "Apple Inc."      },
  { symbol: "MSFT",  name: "Microsoft Corp." },
  { symbol: "GOOGL", name: "Alphabet Inc."   },
  { symbol: "AMZN",  name: "Amazon.com Inc." },
  { symbol: "NVDA",  name: "NVIDIA Corp."    },
  { symbol: "META",  name: "Meta Platforms"  },
  { symbol: "TSLA",  name: "Tesla Inc."      },
  { symbol: "SPY",   name: "SPDR S&P 500 ETF"},
  { symbol: "QQQ",   name: "Invesco QQQ ETF" },
];

const URL = "wss://stream.data.alpaca.markets/v2/iex";

export class AlpacaSource extends Source {
  constructor({ apiKey, apiSecret, symbols } = {}) {
    super({ id: "alpaca", name: "Alpaca (live US stocks)" });
    this.apiKey    = apiKey;
    this.apiSecret = apiSecret;
    this.symbols = (symbols && symbols.length ? symbols : DEFAULT_SYMBOLS).map((s) =>
      typeof s === "string" ? { symbol: s.toUpperCase(), name: s.toUpperCase() } : s
    );
    this._ws = null;
    this._closing = false;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
  }

  isAvailable() { return Boolean(this.apiKey && this.apiSecret); }

  getSymbols() {
    return this.symbols.map((s) => ({
      symbol: s.symbol,
      name: s.name,
      source: this.id,
    }));
  }

  start() {
    if (!this.isAvailable()) {
      this.setStatus("disabled", "ALPACA_API_KEY / ALPACA_API_SECRET not set");
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
    const ws = new WebSocket(URL);
    this._ws = ws;

    ws.on("open", () => {
      this._reconnectAttempts = 0;
      ws.send(JSON.stringify({ action: "auth", key: this.apiKey, secret: this.apiSecret }));
    });

    ws.on("message", (raw) => {
      let items;
      try { items = JSON.parse(raw.toString()); } catch { return; }
      if (!Array.isArray(items)) return;
      for (const item of items) {
        if (item.T === "success" && item.msg === "authenticated") {
          ws.send(JSON.stringify({ action: "subscribe", trades: this.symbols.map((s) => s.symbol) }));
          this.setStatus("live", `${this.symbols.length} symbols subscribed`);
        } else if (item.T === "error") {
          this.setStatus("error", item.msg || "auth error");
          try { ws.close(); } catch { /* noop */ }
        } else if (item.T === "t") {
          const time = item.t ? Date.parse(item.t) : Date.now();
          this.emit("tick", {
            source: this.id,
            symbol: item.S,
            time,
            price: Number(item.p),
            volume: Math.max(1, Math.round(Number(item.s) || 1)),
            session: sessionForUSEquity(time),
          });
        }
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
