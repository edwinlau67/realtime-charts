import WebSocket from "ws";
import { Source } from "./base.js";
import { SESSION_ALWAYS_OPEN } from "../session.js";

// OKX public trade stream. No API key required.
// Docs: https://www.okx.com/docs-v5/en/#overview-websocket-subscribe
//
// Symbols are exposed with a "-O" suffix (e.g. "BTC-USDT-O") to prevent
// collision with Binance's "BTC-USDT". OKX requires plain-string "ping" (not
// JSON) every 25s; the server responds with "pong".
const URL = "wss://ws.okx.com:8443/ws/v5/public";

const DEFAULT_INSTRUMENTS = [
  { instId: "BTC-USDT",  display: "BTC-USDT-O", name: "Bitcoin / USDT (OKX)"  },
  { instId: "ETH-USDT",  display: "ETH-USDT-O", name: "Ethereum / USDT (OKX)" },
  { instId: "SOL-USDT",  display: "SOL-USDT-O", name: "Solana / USDT (OKX)"   },
  { instId: "XRP-USDT",  display: "XRP-USDT-O", name: "Ripple / USDT (OKX)"   },
];

export class OkxSource extends Source {
  constructor({ instruments } = {}) {
    super({ id: "okx", name: "OKX (live crypto)" });
    this.instruments = (instruments && instruments.length
      ? instruments.map((i) =>
          typeof i === "string"
            ? { instId: i.toUpperCase(), display: `${i.toUpperCase()}-O`, name: i.toUpperCase() }
            : i
        )
      : DEFAULT_INSTRUMENTS
    );
    this._lookup = new Map(this.instruments.map((i) => [i.instId, i]));
    this._ws = null;
    this._closing = false;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._heartbeat = null;
  }

  getSymbols() {
    return this.instruments.map((i) => ({
      symbol: i.display,
      name: i.name,
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
    this.setStatus("connecting", `${this.instruments.length} instruments`);
    const ws = new WebSocket(URL);
    this._ws = ws;

    ws.on("open", () => {
      this._reconnectAttempts = 0;
      ws.send(JSON.stringify({
        op: "subscribe",
        args: this.instruments.map((i) => ({ channel: "trades", instId: i.instId })),
      }));
      this.setStatus("live", `${this.instruments.length} instruments subscribed`);
      // OKX closes idle connections; keep alive with plain-string ping every 25s.
      this._heartbeat = setInterval(() => {
        if (ws.readyState === ws.OPEN) ws.send("ping");
      }, 25000);
    });

    ws.on("message", (raw) => {
      const str = raw.toString();
      if (str === "pong") return;
      let msg;
      try { msg = JSON.parse(str); } catch { return; }
      if (msg?.arg?.channel !== "trades" || !Array.isArray(msg.data)) return;
      const meta = this._lookup.get(msg.arg.instId);
      if (!meta) return;
      for (const t of msg.data) {
        const price = Number(t.px);
        if (!Number.isFinite(price)) continue;
        this.emit("tick", {
          source: this.id,
          symbol: meta.display,
          time: Number(t.ts) || Date.now(),
          price,
          volume: Math.max(1, Math.round(Number(t.sz) * 1e4)),
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
