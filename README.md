# Realtime Stock Charts

A real-time stock charts monitoring system. The server simulates a multi-symbol
tick feed and aggregates ticks into OHLCV candles at multiple resolutions, up
to **1 minute** per spec. The client streams updates over WebSocket and renders
live candlestick + volume charts.

```
realtime-charts/
├── server/   Node + Express + ws  — tick simulator, OHLCV aggregator, REST + WS API
└── client/   React + Vite + lightweight-charts — live candlestick UI
```

## Features

- **Pluggable data sources**, selectable at runtime in the UI. The default
  `SOURCES` profile includes the **simulator** plus **four** live public feeds
  with **no API key** (three crypto exchanges + Yahoo). Additional **Stooq** and
  **Finnhub** feeds are opt-in:
  - **Simulated** — Geometric Brownian Motion synthetic feed (always available).
  - **Binance** — live public crypto trade stream (WebSocket push), USDT-quoted
    pairs (BTC-USDT, ETH-USDT, SOL-USDT, BNB-USDT, XRP-USDT, DOGE-USDT).
    *No key.*
  - **Coinbase Exchange** — live public crypto trade stream (WebSocket push),
    USD-quoted pairs (BTC-USD, ETH-USD, SOL-USD, XRP-USD, LTC-USD, DOGE-USD).
    *No key.*
  - **Kraken v2** — live public crypto trade stream (WebSocket push),
    USD-quoted pairs (BTC/USD-K, ETH/USD-K, SOL/USD-K, XRP/USD-K, ADA/USD-K,
    DOT/USD-K). The `-K` suffix marks them as Kraken's quote so they don't
    visually collide with Coinbase's USD pairs. *No key.*
  - **Yahoo Finance** — real US equities, ETFs, and indices via Yahoo's public
    chart endpoint (HTTP polling, default 3 s cadence). Tries
    `query1.finance.yahoo.com` then `query2.finance.yahoo.com` when a host
    returns **401** or **429**; configurable timeout and bounded parallel polls
    per cycle (`YAHOO_FETCH_TIMEOUT_MS`, `YAHOO_POLL_CONCURRENCY`). There is
    **no** automatic failover to Stooq from Yahoo — enable `stooq` or `finnhub`
    separately if needed. Default symbols: AAPL, MSFT, GOOGL, AMZN, NVDA, META,
    TSLA, SPY, QQQ. Supports anything Yahoo quotes — pass
    `YAHOO_SYMBOLS=^GSPC,EURUSD=X,BTC-USD` to track indices, FX pairs, or
    Yahoo's own crypto tickers. *No key.*
    > Yahoo aggressively rate-limits some IPs (**HTTP 429**). If you see
    > rate-limit errors, increase `YAHOO_POLL_MS` (e.g. **15000**), reduce
    > `YAHOO_SYMBOLS`, use a residential network, or prefer **Finnhub** below.
  - **Stooq** *(opt-in)* — real US equities & ETFs via Stooq's free CSV quote
    endpoint (HTTP polling, default 5 s cadence). Free tier is typically
    delayed ~15 minutes during US market hours. Enable with `SOURCES=...,stooq`.
    Reachability depends on your network (some VPNs/firewalls block or slow
    **stooq.com**). *No key.*
  - **Finnhub** *(opt-in)* — live US equities trade stream (WebSocket push).
    Free tier with a free API key (set `FINNHUB_API_KEY`). Recommended when
    Yahoo returns **429**; repo preset: `FINNHUB_API_KEY=xxx npm run dev:server:finnhub`.
- 8 simulated tickers driven by per-symbol Geometric Brownian Motion when no
  real source claims them (drift + volatility).
- Tick stream at configurable cadence (default **250 ms** for the simulator;
  real sources stream at exchange-native rates).
- Server-side OHLCV aggregation at **1s, 5s, 15s, and 1m** resolutions with a
  rolling 600-candle history per symbol/interval.
- WebSocket broadcasts of every tick + every candle update (in-progress *and*
  finalized), so the chart's last bar updates live and rolls cleanly at each
  bucket boundary.
- REST `/api/sources`, `/api/symbols`, `/api/history`, `/api/health` for bootstrap.
- Auto-reconnecting WebSocket client with exponential backoff.
- Watchlist sidebar with live price flashes, interval switcher (1s / 5s / 15s / 1m),
  and OHLCV stat tiles.
- **Appearance**: **Auto** (follow OS light/dark), **Light**, or **Dark** — persisted in
  the browser (`localStorage`) and applied via `data-theme` on the document root.
- **MACD trend analysis** panel synchronized to the price chart's time scale,
  with configurable fast / slow / signal periods (defaults 12 / 26 / 9), live
  histogram coloring (rising vs. fading momentum), and a header trend badge
  that classifies the latest sample as Bullish / Bearish / Crossover and
  pulses on bullish or bearish crossovers.
- **Pre-market & after-hours session awareness**:
  - Server tags every tick and OHLCV candle with a session label (`pre` /
    `regular` / `post` / `closed`) using a DST-correct ET resolver.
  - For **Stooq** and **Finnhub**, session on each tick follows the quote/trade
    time. **Yahoo** uses **poll-time** (wall clock) for tick session so sub-minute
    buckets align with “now” in ET; crypto sources (Binance, Coinbase, Kraken)
    and the simulator always use `regular` (24/7).
  - Yahoo polls with `includePrePost=true` so pre-market (04:00–09:30 ET) and
    after-hours (16:00–20:00 ET) bars are streamed live as they happen.
  - Finnhub's WebSocket trade stream includes extended-hours trades by default.
  - The chart paints pre-market candles with an **amber border** and
    after-hours candles with a **purple border**, with muted body fills so
    extended-hours activity is instantly distinguishable from regular trading.
  - The header shows a live **session pill** (`PRE-MARKET` / `MARKET OPEN` /
    `AFTER-HOURS` / `MARKET CLOSED` / `24/7 OPEN`) that auto-flips at session
    boundaries, plus a continuously-updating ET market clock.

## Run it

```bash
# 1) install
npm run install:all

# 2) start the server (in one terminal)
npm run dev:server     # http://localhost:4000

# 3) start the client (in another terminal)
npm run dev:client     # http://localhost:5173
```

Open http://localhost:5173. The Vite dev server proxies `/api` and `/ws` to the
backend, so no CORS or URL config is needed.

### Verification and tests

```bash
npm test              # server + client unit tests (Vitest on the client)
npm run verify        # client build, simulated-only server, REST + WS smoke checks
```

Optional: `VERIFY_PORT=4010 npm run verify` if port **4010** is free (default in the script).

### Documentation

- [docs/README.md](docs/README.md) — index of guides below  
- [docs/USER_GUIDE.md](docs/USER_GUIDE.md) — using the UI and sessions  
- [docs/REFERENCE.md](docs/REFERENCE.md) — REST, WebSocket, env vars  
- [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) — per-feed technical detail  
- [DESIGN_SPEC.md](DESIGN_SPEC.md) — architecture and release checklist  

### Environment

Server:

| Var                 | Default                              | Description                                                                                            |
| ------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `PORT`              | `4000`                               | HTTP + WebSocket port                                                                                  |
| `TICK_MS`           | `250`                                | Simulator tick cadence (ms). Lower = faster synthetic feed.                                            |
| `SOURCES`           | `simulated,binance,coinbase,kraken,yahoo` | Comma list of enabled sources: `simulated`, `binance`, `coinbase`, `kraken`, `yahoo`, `stooq`, `finnhub`. |
| `FINNHUB_API_KEY`   | *(unset)*                            | Required to enable the Finnhub real-equity feed.                                                       |
| `BINANCE_PAIRS`     | *(default 6 pairs)*                  | Comma list, e.g. `btcusdt,ethusdt,solusdt`.                                                            |
| `COINBASE_PRODUCTS` | *(default 6 products)*               | Comma list, e.g. `BTC-USD,ETH-USD,SOL-USD`.                                                            |
| `KRAKEN_PAIRS`      | *(default 6 pairs)*                  | Comma list, e.g. `BTC/USD,ETH/USD,SOL/USD`.                                                            |
| `YAHOO_SYMBOLS`     | *(default 9 stocks/ETFs)*            | Comma list, e.g. `AAPL,MSFT,SPY,^GSPC,EURUSD=X`.                                                       |
| `YAHOO_POLL_MS`     | `3000`                               | Polling cadence in ms for the Yahoo source. Lower = fresher prices, more requests.                     |
| `YAHOO_FETCH_TIMEOUT_MS` | `15000` (min `5000`)             | Per-request HTTP timeout for Yahoo.                                                                    |
| `YAHOO_POLL_CONCURRENCY` | `4` (clamped 1–4)                | Max Yahoo symbols polled in parallel each cycle.                                                       |
| `STOOQ_SYMBOLS`     | *(default 9 stocks/ETFs)*            | Comma list of Stooq tickers (with market suffix), e.g. `aapl.us,msft.us,spy.us`.                       |
| `STOOQ_POLL_MS`     | `5000`                               | Polling cadence in ms for the Stooq source.                                                            |
| `STOOQ_FETCH_TIMEOUT_MS` | `25000` (min `8000`)           | Per-request HTTP timeout for Stooq.                                                                    |
| `STOOQ_POLL_CONCURRENCY` | `3` (clamped 1–3)              | Max Stooq symbols polled in parallel each cycle.                                                       |
| `FINNHUB_SYMBOLS`   | *(default 7 stocks)*                 | Comma list, e.g. `AAPL,MSFT,GOOGL`. The `dev:server:finnhub` script overrides with a longer preset list. |

Examples:

```bash
# only the synthetic feed (no external connections)
SOURCES=simulated npm run dev:server

# all free, no-key live feeds: 3 crypto exchanges + Yahoo stocks (default)
npm run dev:server

# real stocks only (Yahoo, no key needed)
SOURCES=yahoo YAHOO_SYMBOLS=AAPL,MSFT,GOOGL,SPY,QQQ npm run dev:server

# track indices and FX too via Yahoo (no key needed)
SOURCES=yahoo YAHOO_SYMBOLS=^GSPC,^DJI,^IXIC,EURUSD=X,GBPUSD=X,GC=F npm run dev:server

# real stocks via Stooq (works from any IP including datacenters; ~15min delay)
SOURCES=stooq STOOQ_SYMBOLS=aapl.us,msft.us,googl.us,spy.us,qqq.us npm run dev:server

# recommended: stable real-time US stocks via Finnhub (API key required; bundled FINNHUB_SYMBOLS in package.json)
FINNHUB_API_KEY=xxx npm run dev:server:finnhub

# both stock sources side-by-side for comparison
SOURCES=simulated,yahoo,stooq npm run dev:server

# everything: every free feed + real Finnhub equities (key required)
SOURCES=simulated,binance,coinbase,kraken,yahoo,finnhub FINNHUB_API_KEY=xxx npm run dev:server
```

When a real source claims a symbol, the simulator automatically drops the
overlapping ticker so there are never two feeds for the same instrument.

## API

### REST

- `GET /api/sources` → `{ sources: [{id, name, status, detail, symbols, available}], enabled }`
- `GET /api/symbols` → `{ symbols: [{symbol, name, source}], intervals, sources }`
- `GET /api/history?source=binance&symbol=BTC-USDT&interval=1m&limit=240` →
  `{ source, symbol, interval, candles: [{time, open, high, low, close, volume, session}] }`
- `GET /api/health` → `{ ok: true, uptime }`

`time` is a UNIX millisecond timestamp aligned to the bucket start. Each candle
includes a `session` label (`pre` / `regular` / `post` / `closed`) locked at bucket open.

### WebSocket — `ws://localhost:4000/ws`

Server → client messages:

```json
{ "type": "hello",         "sources": [...], "symbols": [...], "intervals": [...], "tickIntervalMs": 250 }
{ "type": "tick",           "source": "binance",  "symbol": "BTC-USDT", "time": 1714510800000, "price": 67212.5, "volume": 4, "session": "regular" }
{ "type": "candle",         "source": "binance",  "symbol": "BTC-USDT", "interval": "1m", "candle": { ..., "session": "regular" }, "closed": false }
{ "type": "source-status",  "id": "binance",      "status": "live",     "detail": "6 pairs streaming" }
```

Client → server messages:

```json
{ "type": "subscribe", "sources": ["binance"], "symbols": ["BTC-USDT"], "intervals": ["1s","1m"] }
{ "type": "ping" }
```

The server may reply with `subscribed` (echo of active filters) or `pong` (to `ping`).

Clients are subscribed to all sources, symbols, and intervals by default; send
a `subscribe` message to narrow the stream.

## Notes

- The server primes ~5 minutes of synthetic history at startup so charts have
  context immediately on first connect.
- Adding another real feed (Polygon, Alpaca, Coinbase, Kraken, …) is a small,
  self-contained change: drop a new `Source` subclass under `server/src/sources/`
  that emits `{ source, symbol, time, price, volume }` ticks, register it in
  `manager.js`, and the aggregator + WebSocket protocol pick it up unchanged.
