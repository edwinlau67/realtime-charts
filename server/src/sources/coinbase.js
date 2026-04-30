import WebSocket from "ws";
import { Source } from "./base.js";
import { SESSION_ALWAYS_OPEN } from "../session.js";

// Coinbase Exchange public market-data WebSocket.
// No API key, no auth, no rate-limit signing required for the `matches` channel.
// Docs: https://docs.cdp.coinbase.com/exchange/docs/websocket-overview
//
// We pass the canonical Coinbase product id (e.g. "BTC-USD") through unchanged
// as the symbol. These are USD-quoted pairs, so they coexist cleanly with
// Binance USDT pairs.
const URL = "wss://ws-feed.exchange.coinbase.com";

const DEFAULT_PRODUCTS = [
  { id: "BTC-USD",  name: "Bitcoin / USD"   },
  { id: "ETH-USD",  name: "Ethereum / USD"  },
  { id: "SOL-USD",  name: "Solana / USD"    },
  { id: "XRP-USD",  name: "Ripple / USD"    },
  { id: "LTC-USD",  name: "Litecoin / USD"  },
  { id: "DOGE-USD", name: "Dogecoin / USD"  },
];

export class CoinbaseSource extends Source {
  constructor({ products } = {}) {
    super({ id: "coinbase", name: "Coinbase (live USD crypto)" });
    this.products = (products && products.length ? products : DEFAULT_PRODUCTS).map((p) =>
      typeof p === "string" ? { id: p.toUpperCase(), name: p.toUpperCase() } : p
    );
    this._ws = null;
    this._closing = false;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
  }

  getSymbols() {
    return this.products.map((p) => ({
      symbol: p.id,
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
    this.setStatus("connecting", `${this.products.length} products`);
    const ws = new WebSocket(URL);
    this._ws = ws;

    ws.on("open", () => {
      this._reconnectAttempts = 0;
      ws.send(JSON.stringify({
        type: "subscribe",
        product_ids: this.products.map((p) => p.id),
        channels: ["matches"],
      }));
      this.setStatus("live", `${this.products.length} products subscribed`);
    });

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      // We care about real trades. "match" is a normal trade; "last_match" is
      // the snapshot sent on subscribe (also a real trade).
      if (msg?.type !== "match" && msg?.type !== "last_match") return;
      const price = Number(msg.price);
      const size  = Number(msg.size);
      if (!Number.isFinite(price)) return;
      this.emit("tick", {
        source: this.id,
        symbol: msg.product_id,
        time: msg.time ? Date.parse(msg.time) : Date.now(),
        price,
        volume: Math.max(1, Math.round(size * 1e4)), // size is BTC-fractional; scale for visibility
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
