import express from "express";
import cors from "cors";
import http from "node:http";
import dns from "node:dns";
import { WebSocketServer } from "ws";

// Prefer IPv4 first so slow/broken IPv6 routes do not leave HTTPS fetches
// hanging until the Yahoo/Stooq client timeouts fire (common on some networks).
dns.setDefaultResultOrder("ipv4first");
import { CandleAggregator, INTERVAL_KEYS } from "./aggregator.js";
import { SourceManager } from "./sources/manager.js";

const PORT    = Number(process.env.PORT || 4000);
const TICK_MS = Number(process.env.TICK_MS || 250);

// Default sources: simulator plus all zero-key public live feeds. Pass
// SOURCES=simulated to disable external connections entirely.
const enabledSources = (process.env.SOURCES || "simulated,binance,coinbase,kraken,yahoo")
  .split(",").map((s) => s.trim()).filter(Boolean);

const finnhubApiKey = process.env.FINNHUB_API_KEY || "";
const binancePairs = (process.env.BINANCE_PAIRS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const coinbaseProducts = (process.env.COINBASE_PRODUCTS || "")
  .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const krakenPairs = (process.env.KRAKEN_PAIRS || "")
  .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const yahooSymbols = (process.env.YAHOO_SYMBOLS || "")
  .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const yahooPollMs = Number(process.env.YAHOO_POLL_MS || 3000);
const stooqSymbols = (process.env.STOOQ_SYMBOLS || "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const stooqPollMs = Number(process.env.STOOQ_POLL_MS || 5000);
const finnhubSymbols = (process.env.FINNHUB_SYMBOLS || "")
  .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

const app = express();
app.use(cors());
// We don't accept JSON request bodies on any route, but cap the parser anyway
// so a malicious client can't force the server to buffer a large payload.
app.use(express.json({ limit: "16kb" }));

const manager = new SourceManager({
  enabled: enabledSources,
  tickIntervalMs: TICK_MS,
  finnhubApiKey,
  binancePairs,
  coinbaseProducts,
  krakenPairs,
  yahooSymbols,
  yahooPollMs,
  stooqSymbols,
  stooqPollMs,
  finnhubSymbols,
});
const agg = new CandleAggregator();

manager.on("tick", (tick) => agg.ingest(tick));
manager.on("status", (s) => console.log(`[source ${s.id}] ${s.status}${s.detail ? " · " + s.detail : ""}`));

// REST: list configured data sources and their live status.
app.get("/api/sources", (_req, res) => {
  res.json({ sources: manager.describe(), enabled: enabledSources });
});

// REST: list available symbols (each tagged with its source).
app.get("/api/symbols", (_req, res) => {
  res.json({
    symbols: manager.getSymbols(),
    intervals: INTERVAL_KEYS,
    sources: manager.describe(),
  });
});

// REST: historical candles for a (source, symbol, interval) tuple.
app.get("/api/history", (req, res) => {
  const symbol   = String(req.query.symbol || "").slice(0, 64);
  const source   = String(req.query.source || "").slice(0, 32);
  const interval = String(req.query.interval || "1s");

  // Clamp limit to a positive integer in [1, 600]. Without this,
  // limit=-1 / NaN / Infinity flow into Array#slice and return the wrong
  // window (or the entire history).
  const rawLimit = Number(req.query.limit ?? 240);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(600, Math.max(1, Math.floor(rawLimit)))
    : 240;

  if (!INTERVAL_KEYS.includes(interval)) {
    return res.status(400).json({ error: `interval must be one of ${INTERVAL_KEYS.join(", ")}` });
  }
  const known = manager.getSymbols().some(
    (s) => s.symbol === symbol && (!source || s.source === source)
  );
  if (!symbol || !known) {
    return res.status(404).json({ error: `unknown symbol: ${source || "*"}:${symbol}` });
  }
  // If caller didn't specify source, pick the first match (single-source case).
  const resolved = source || manager.getSymbols().find((s) => s.symbol === symbol).source;
  res.json({
    source: resolved,
    symbol,
    interval,
    candles: agg.history(resolved, symbol, interval, limit),
  });
});

app.get("/api/health", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

const server = http.createServer(app);

// WebSocket protocol:
//   client -> server: { type: "subscribe", sources?: [...], symbols?: [...], intervals?: [...] }
//   server -> client: { type: "hello", sources, symbols, intervals, tickIntervalMs }
//                     { type: "tick",   source, symbol, time, price, volume }
//                     { type: "candle", source, symbol, interval, candle, closed }
//                     { type: "source-status", id, status, detail }
//
// Hardening:
//   * maxPayload caps inbound frames at 64 KiB so a client can't force the
//     server to buffer a multi-megabyte JSON blob.
//   * Subscribe arrays are clamped (size + per-string length) for the same
//     reason — without this a single client could pin large Sets per socket.
//   * A 30 s ping/pong heartbeat evicts half-open clients so their attached
//     emitter listeners don't accumulate forever.
const MAX_WS_PAYLOAD     = 64 * 1024;          // 64 KiB
const MAX_SUBSCRIBE_LIST = 256;                // entries per array
const MAX_SUBSCRIBE_ITEM = 64;                 // chars per entry
const HEARTBEAT_MS       = 30_000;
const wss = new WebSocketServer({
  server,
  path: "/ws",
  maxPayload: MAX_WS_PAYLOAD,
});

// Each connection adds 3 listeners on shared emitters. The Node default cap
// of 10 trips a MaxListenersExceededWarning at ~3 concurrent clients and
// masks real leaks. Explicitly raise the cap.
manager.setMaxListeners(0);
agg.setMaxListeners(0);

function clampStringArray(arr) {
  if (!Array.isArray(arr)) return null;
  return arr
    .slice(0, MAX_SUBSCRIBE_LIST)
    .map((v) => String(v).slice(0, MAX_SUBSCRIBE_ITEM));
}

wss.on("connection", (ws) => {
  // isAlive flips to false on each heartbeat; pong from the client flips it
  // back to true. If we miss a beat the socket gets terminated.
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  const subs = {
    sources:   new Set(manager.describe().map((s) => s.id)),
    symbols:   new Set(manager.getSymbols().map((s) => s.symbol)),
    intervals: new Set(INTERVAL_KEYS),
  };

  const onTick = (tick) => {
    if (ws.readyState !== ws.OPEN) return;
    if (!subs.sources.has(tick.source)) return;
    if (!subs.symbols.has(tick.symbol)) return;
    ws.send(JSON.stringify({ type: "tick", ...tick }));
  };

  const onUpdate = ({ source, symbol, interval, candle, closed }) => {
    if (ws.readyState !== ws.OPEN) return;
    if (!subs.sources.has(source))     return;
    if (!subs.symbols.has(symbol))     return;
    if (!subs.intervals.has(interval)) return;
    ws.send(JSON.stringify({ type: "candle", source, symbol, interval, candle, closed }));
  };

  const onStatus = (s) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ type: "source-status", ...s }));
  };

  manager.on("tick", onTick);
  agg.on("update", onUpdate);
  manager.on("status", onStatus);

  ws.send(JSON.stringify({
    type: "hello",
    sources: manager.describe(),
    symbols: manager.getSymbols(),
    intervals: INTERVAL_KEYS,
    tickIntervalMs: TICK_MS,
  }));

  ws.on("message", (raw) => {
    // maxPayload already bounds raw size; toString is safe.
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg?.type === "subscribe") {
      const sources   = clampStringArray(msg.sources);
      const symbols   = clampStringArray(msg.symbols);
      const intervals = clampStringArray(msg.intervals);
      if (sources)   subs.sources   = new Set(sources);
      if (symbols)   subs.symbols   = new Set(symbols);
      if (intervals) subs.intervals = new Set(intervals);
      ws.send(JSON.stringify({
        type: "subscribed",
        sources:   [...subs.sources],
        symbols:   [...subs.symbols],
        intervals: [...subs.intervals],
      }));
    } else if (msg?.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", t: Date.now() }));
    }
  });

  ws.on("close", () => {
    manager.off("tick", onTick);
    agg.off("update", onUpdate);
    manager.off("status", onStatus);
  });
});

// Periodically ping each client; terminate any that didn't pong since the
// previous beat. This frees up the per-connection emitter listeners that
// would otherwise leak when a client disappears without a clean close
// (mobile networks, NAT timeouts, force-killed tabs).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, HEARTBEAT_MS);
wss.on("close", () => clearInterval(heartbeat));

// Prime ~5 minutes of history for the simulated source so charts aren't empty
// on first connect. Real feeds bootstrap their own history once trades flow.
(function prime() {
  const sim = manager.getSimulated();
  if (!sim) return;
  const now = Date.now();
  const PRIME_SECS = 300;
  const orig = Date.now;
  for (let t = now - PRIME_SECS * 1000; t < now; t += TICK_MS) {
    Date.now = () => t;
    // Tick into the aggregator directly without setTimeout.
    sim._tick();
  }
  Date.now = orig;
})();

manager.start();

server.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}  ws://localhost:${PORT}/ws  (tick=${TICK_MS}ms)`);
  console.log(`[server] sources: ${enabledSources.join(", ")}`);
});
