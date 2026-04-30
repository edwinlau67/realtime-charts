import WebSocket from "ws";
import { Source } from "./base.js";
import { SESSION_ALWAYS_OPEN } from "../session.js";

// Kraken public WebSocket v2. No auth required for the trade channel.
// Docs: https://docs.kraken.com/api/docs/websocket-v2/trade
//
// Kraken uses pairs like "BTC/USD". To prevent collision with Coinbase's
// "BTC-USD" we expose them with a "-K" suffix (e.g. "BTC/USD-K") so the user
// can tell at a glance which exchange a quote is from even before reading the
// source badge.
const URL = "wss://ws.kraken.com/v2";

const DEFAULT_PAIRS = [
  { pair: "BTC/USD", name: "Bitcoin / USD"  },
  { pair: "ETH/USD", name: "Ethereum / USD" },
  { pair: "SOL/USD", name: "Solana / USD"   },
  { pair: "XRP/USD", name: "Ripple / USD"   },
  { pair: "ADA/USD", name: "Cardano / USD"  },
  { pair: "DOT/USD", name: "Polkadot / USD" },
];

export class KrakenSource extends Source {
  constructor({ pairs } = {}) {
    super({ id: "kraken", name: "Kraken (live crypto)" });
    this.pairs = (pairs && pairs.length ? pairs : DEFAULT_PAIRS).map((p) =>
      typeof p === "string" ? { pair: p.toUpperCase(), name: p.toUpperCase() } : p
    );
    this._lookup = new Map(this.pairs.map((p) => [p.pair, p]));
    this._ws = null;
    this._closing = false;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._heartbeat = null;
  }

  getSymbols() {
    return this.pairs.map((p) => ({
      symbol: `${p.pair}-K`,
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
    if (this._heartbeat) clearInterval(this._heartbeat);
    this._reconnectTimer = null;
    this._heartbeat = null;
    if (this._ws) {
      try { this._ws.close(); } catch { /* noop */ }
      this._ws = null;
    }
    this.setStatus("idle", "");
  }

  _connect() {
    this.setStatus("connecting", `${this.pairs.length} pairs`);
    const ws = new WebSocket(URL);
    this._ws = ws;

    ws.on("open", () => {
      this._reconnectAttempts = 0;
      ws.send(JSON.stringify({
        method: "subscribe",
        params: {
          channel: "trade",
          symbol: this.pairs.map((p) => p.pair),
          snapshot: false,
        },
      }));
      this.setStatus("live", `${this.pairs.length} pairs subscribed`);
      // Kraken closes idle connections after ~60s without traffic; poke ping.
      this._heartbeat = setInterval(() => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ method: "ping" }));
      }, 30000);
    });

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg?.channel !== "trade" || !Array.isArray(msg.data)) return;
      for (const t of msg.data) {
        const meta = this._lookup.get(t.symbol);
        if (!meta) continue;
        const price = Number(t.price);
        if (!Number.isFinite(price)) continue;
        this.emit("tick", {
          source: this.id,
          symbol: `${meta.pair}-K`,
          time: t.timestamp ? Date.parse(t.timestamp) : Date.now(),
          price,
          volume: Math.max(1, Math.round(Number(t.qty) * 1e4)),
          session: SESSION_ALWAYS_OPEN,
        });
      }
    });

    ws.on("close", () => {
      this._ws = null;
      if (this._heartbeat) clearInterval(this._heartbeat);
      this._heartbeat = null;
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
