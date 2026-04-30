import WebSocket from "ws";
import { Source } from "./base.js";
import { SESSION_ALWAYS_OPEN } from "../session.js";

// Public Binance combined-trade stream. No API key required.
// Docs: https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams#trade-streams
//
// We expose Binance pair "BTCUSDT" to the rest of the system as the symbol
// "BTC-USDT" so it doesn't collide with any other source's tickers.
const DEFAULT_PAIRS = [
  { pair: "btcusdt", display: "BTC-USDT", name: "Bitcoin / USDT" },
  { pair: "ethusdt", display: "ETH-USDT", name: "Ethereum / USDT" },
  { pair: "solusdt", display: "SOL-USDT", name: "Solana / USDT"   },
  { pair: "bnbusdt", display: "BNB-USDT", name: "BNB / USDT"      },
  { pair: "xrpusdt", display: "XRP-USDT", name: "Ripple / USDT"   },
  { pair: "dogeusdt",display: "DOGE-USDT",name: "Dogecoin / USDT" },
];

export class BinanceSource extends Source {
  constructor({ pairs } = {}) {
    super({ id: "binance", name: "Binance (live crypto)" });
    this.pairs = (pairs && pairs.length ? pairs : DEFAULT_PAIRS).map((p) =>
      typeof p === "string"
        ? { pair: p.toLowerCase(), display: p.toUpperCase(), name: p.toUpperCase() }
        : p
    );
    this._ws = null;
    this._closing = false;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._lookup = new Map(this.pairs.map((p) => [p.pair.toUpperCase(), p]));
  }

  getSymbols() {
    return this.pairs.map((p) => ({
      symbol: p.display,
      name: p.name,
      source: this.id,
    }));
  }

  start() {
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
    const streams = this.pairs.map((p) => `${p.pair}@trade`).join("/");
    const url = `wss://stream.binance.com:9443/stream?streams=${streams}`;
    this.setStatus("connecting", `${this.pairs.length} pairs`);

    const ws = new WebSocket(url);
    this._ws = ws;

    ws.on("open", () => {
      this._reconnectAttempts = 0;
      this.setStatus("live", `${this.pairs.length} pairs streaming`);
    });

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const d = msg?.data;
      if (!d || d.e !== "trade") return;
      const meta = this._lookup.get(d.s);
      if (!meta) return;

      this.emit("tick", {
        source: this.id,
        symbol: meta.display,
        time: Number(d.T) || Date.now(),
        price: Number(d.p),
        volume: Math.max(1, Math.round(Number(d.q))),
        session: SESSION_ALWAYS_OPEN,
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
