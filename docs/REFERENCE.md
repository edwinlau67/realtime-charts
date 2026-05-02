# Realtime Stock Charts — Technical Reference

Authoritative details for **HTTP endpoints**, **WebSocket protocol**, **environment configuration**, and **data contracts**. For narrative usage instructions, see [USER_GUIDE.md](./USER_GUIDE.md).

**Per-feed technical detail** (URLs, protocols, tick semantics, defaults, provider doc links): **[DATA_SOURCES.md](./DATA_SOURCES.md)**.

---

## Table of contents

1. [Repository scripts](#repository-scripts)
2. [Server configuration (environment variables)](#server-configuration-environment-variables)
3. [Data sources index](#data-sources-index)
4. [REST API](#rest-api)
5. [WebSocket API](#websocket-api)
6. [Data model](#data-model)
7. [Aggregation and history](#aggregation-and-history)
8. [Client development proxy](#client-development-proxy)
9. [Testing](#testing)
10. [Automated verification (`verify.sh`)](#automated-verification-verifysh)

---

## Repository scripts

Run from the **repository root** (`realtime-charts/`):

| Script | Command | Purpose |
| -------- | -------- | -------- |
| Install all | `npm run install:all` | `npm install` in `server/` and `client/`. |
| Dev server | `npm run dev:server` | Start Express + WebSocket backend (default port **4000**). |
| Dev server (Finnhub preset) | `npm run dev:server:finnhub` | Same as dev server with `SOURCES=finnhub` and a bundled `FINNHUB_SYMBOLS` list. Requires `FINNHUB_API_KEY` in `.env`. |
| Dev server (Alpaca preset) | `npm run dev:server:alpaca` | `SOURCES=alpaca`. Requires `ALPACA_API_KEY` + `ALPACA_API_SECRET` in `.env`. |
| Dev server (Twelve Data preset) | `npm run dev:server:twelvedata` | `SOURCES=twelvedata`. Requires `TWELVE_DATA_API_KEY` in `.env`. |
| Dev server (OKX preset) | `npm run dev:server:okx` | `SOURCES=okx` (no key required). |
| Dev client | `npm run dev:client` | Start Vite + React (default port **5173** with API proxy). |
| Build client | `npm run build:client` | Production build of the frontend. |
| Tests | `npm test` | Runs server tests then client tests. |
| Verify | `npm run verify` | Project verify script (see `scripts/verify.sh`). |

---

## Automated verification (`verify.sh`)

`npm run verify` runs `scripts/verify.sh` from the repo root (requires **Node**, **npm**, **curl**).

| Step | Behavior |
| ---- | -------- |
| Frontend | `npm --prefix client run build` (production bundle). |
| Server | `SOURCES=simulated PORT=$VERIFY_PORT node server/src/index.js` (background; killed on exit). |
| `VERIFY_PORT` | Default **`4010`** — avoids clashing with `PORT=4000` dev servers. |
| REST | Asserts `/api/health`, `/api/symbols` (non-empty, entries have `source`), `/api/sources`, `/api/history` returns candles with string `session`; invalid history must fail cleanly. |
| WebSocket | Node `ws` client: receives `hello`, then `tick` and `candle` each including `session`, within ~5s. |

---

## Server configuration (environment variables)

All variables are read by `server/src/index.js` and passed into `SourceManager` unless noted.

**API key setup**: copy `.env.example` (repo root) to `.env`, fill in your keys. The server loads `.env` automatically via `--env-file-if-exists`; the file is git-ignored. Inline env vars on the command line still override `.env` values when needed.

On startup the server sets **`dns.setDefaultResultOrder("ipv4first")`** so outbound `fetch` calls (Yahoo, Stooq, etc.) prefer IPv4 first and are less likely to hang on broken IPv6 paths.

| Variable | Default | Description |
| --------- | -------- | ----------- |
| `PORT` | `4000` | HTTP and WebSocket listen port (WS path `/ws`). |
| `TICK_MS` | `250` | Simulator tick interval in milliseconds (**only** the synthetic GBM source). |
| `SOURCES` | `simulated,binance,coinbase,kraken,yahoo` | Comma-separated list of source ids to enable. Allowed tokens: `simulated`, `binance`, `coinbase`, `kraken`, `okx`, `yahoo`, `stooq`, `finnhub`, `alpaca`, `twelvedata`. Order does not determine priority; symbol collision rules apply (see below). |
| `FINNHUB_API_KEY` | *(empty)* | Required for Finnhub to connect. Without a key the adapter reports **disabled** and does not open a socket; configured symbols may still appear in `/api/symbols` but will not receive ticks. |
| `BINANCE_PAIRS` | *(built-in list)* | Comma list of Binance **lowercase** stream ids, e.g. `btcusdt,ethusdt`. |
| `COINBASE_PRODUCTS` | *(built-in list)* | Comma list of Coinbase **product** ids, e.g. `BTC-USD,ETH-USD`. |
| `KRAKEN_PAIRS` | *(built-in list)* | Comma list of Kraken pairs, e.g. `BTC/USD,ETH/USD`. |
| `YAHOO_SYMBOLS` | *(built-in list)* | Comma list of Yahoo symbols, e.g. `AAPL,MSFT,^GSPC,EURUSD=X`. |
| `YAHOO_POLL_MS` | `3000` | Yahoo HTTP poll period in ms. |
| `YAHOO_FETCH_TIMEOUT_MS` | `15000` | Per-request Yahoo HTTP timeout in ms (minimum **5000**). |
| `YAHOO_POLL_CONCURRENCY` | `4` | Max Yahoo symbols polled in parallel per cycle (clamped **1–4**). |
| `STOOQ_SYMBOLS` | *(built-in list)* | Comma list of Stooq tickers, typically `symbol.us` form. |
| `STOOQ_POLL_MS` | `5000` | Stooq poll period in ms. |
| `STOOQ_FETCH_TIMEOUT_MS` | `25000` | Per-request Stooq HTTP timeout in ms (minimum **8000**). |
| `STOOQ_POLL_CONCURRENCY` | `3` | Max Stooq symbols polled in parallel per cycle (clamped **1–3**). |
| `FINNHUB_SYMBOLS` | *(built-in list)* | Comma list of US equity symbols for Finnhub. |
| `OKX_INSTRUMENTS` | *(built-in list)* | Comma list of OKX instrument ids, e.g. `BTC-USDT,ETH-USDT`. |
| `ALPACA_API_KEY` | *(empty)* | Required for Alpaca to connect (paper-account key). |
| `ALPACA_API_SECRET` | *(empty)* | Required for Alpaca to connect (paper-account secret). |
| `ALPACA_SYMBOLS` | *(built-in list)* | Comma list of US equity symbols for Alpaca, e.g. `AAPL,MSFT,SPY`. |
| `TWELVE_DATA_API_KEY` | *(empty)* | Required for Twelve Data to connect. |
| `TWELVE_DATA_SYMBOLS` | *(built-in list)* | Comma list of symbols for Twelve Data (max 8 on free tier), e.g. `AAPL,MSFT,EUR/USD`. |

### Source collision policy

- **Real** sources are started first; each exposes symbols with **source-specific** naming (e.g. `BTC-USDT` vs `BTC-USD` vs Kraken’s `-K` suffix convention).
- If **simulated** is enabled, its universe **excludes** any symbol string already claimed by another enabled source, so there is at most one stream per displayed equity/crypto ticker name per source.

### `SOURCES` examples

```bash
# Synthetic only, no external APIs
SOURCES=simulated npm run dev:server

# Add Finnhub (FINNHUB_API_KEY must be set in .env)
SOURCES=simulated,binance,coinbase,kraken,yahoo,finnhub npm run dev:server

# Finnhub-only preset (FINNHUB_API_KEY in .env; includes bundled FINNHUB_SYMBOLS)
npm run dev:server:finnhub

# Add Stooq for delayed CSV equities (opt-in; network must reach stooq.com)
SOURCES=simulated,yahoo,stooq npm run dev:server

# OKX crypto (no key)
SOURCES=okx npm run dev:server

# Alpaca live US equities (ALPACA_API_KEY + ALPACA_API_SECRET in .env)
npm run dev:server:alpaca

# Twelve Data stocks + forex (TWELVE_DATA_API_KEY in .env; max 8 symbols on free tier)
npm run dev:server:twelvedata
```

---

## Data sources index

Full specifications for each adapter (endpoints, reconnection, symbol mapping, volume scaling, session rules, official vendor docs) live in **[DATA_SOURCES.md](./DATA_SOURCES.md)**. Quick index:

| Source id | Module | Transport | Key env vars |
| --------- | ------ | --------- | ------------- |
| `simulated` | `sources/simulated.js` | Timer | `TICK_MS`, collision via other sources |
| `binance` | `sources/binance.js` | WebSocket | `BINANCE_PAIRS` |
| `coinbase` | `sources/coinbase.js` | WebSocket | `COINBASE_PRODUCTS` |
| `kraken` | `sources/kraken.js` | WebSocket | `KRAKEN_PAIRS` |
| `yahoo` | `sources/yahoo.js` | HTTP poll | `YAHOO_SYMBOLS`, `YAHOO_POLL_MS` |
| `stooq` | `sources/stooq.js` | HTTP poll | `STOOQ_SYMBOLS`, `STOOQ_POLL_MS` |
| `finnhub` | `sources/finnhub.js` | WebSocket | `FINNHUB_API_KEY`, `FINNHUB_SYMBOLS` |
| `okx` | `sources/okx.js` | WebSocket | `OKX_INSTRUMENTS` |
| `alpaca` | `sources/alpaca.js` | WebSocket | `ALPACA_API_KEY`, `ALPACA_API_SECRET`, `ALPACA_SYMBOLS` |
| `twelvedata` | `sources/twelvedata.js` | WebSocket | `TWELVE_DATA_API_KEY`, `TWELVE_DATA_SYMBOLS` |

---

## REST API

Base URL in development: `http://localhost:4000`. All responses are **JSON**. CORS is enabled on the server for development.

### `GET /api/health`

**Response**

```json
{ "ok": true, "uptime": 123.45 }
```

- `uptime`: server process uptime in seconds (`process.uptime()`).

---

### `GET /api/sources`

Returns each **enabled** adapter’s metadata and live status.

**Response shape**

```json
{
  "sources": [
    {
      "id": "yahoo",
      "name": "Yahoo Finance",
      "status": "live",
      "detail": "…",
      "symbols": 9,
      "available": true
    }
  ],
  "enabled": ["simulated", "binance", "coinbase", "kraken", "yahoo"]
}
```

- `status`: adapter-dependent (e.g. `idle`, `connecting`, `live`, `error`, `disabled`).
- `detail`: human-readable subtext for UIs and logs.
- `enabled`: raw list from `SOURCES` env after trim/split.

---

### `GET /api/symbols`

Bootstrap list for the client watchlist.

**Response shape**

```json
{
  "symbols": [
    { "symbol": "BTC-USDT", "name": "Bitcoin / Tether", "source": "binance" }
  ],
  "intervals": ["1s", "5s", "15s", "1m"],
  "sources": [ /* same shape as /api/sources sources[] */ ]
}
```

---

### `GET /api/history`

**Query parameters**

| Name | Required | Description |
| ------ | --------- | ----------- |
| `symbol` | Yes | Instrument id as used by the source (e.g. `AAPL`, `BTC-USDT`). |
| `source` | No | When omitted, the server picks the **first** symbol entry matching `symbol`. Prefer passing `source` when multiple sources could share similar labels. |
| `interval` | No | One of `1s`, `5s`, `15s`, `1m`. Default `1s`. |
| `limit` | No | Max candles to return; capped at **600** server-side. Default **240**. |

**Errors**

- `400` — invalid `interval`.
- `404` — unknown `(source, symbol)` or empty `symbol`.

**Success response**

```json
{
  "source": "yahoo",
  "symbol": "AAPL",
  "interval": "1m",
  "candles": [
    {
      "time": 1714510800000,
      "open": 180.12,
      "high": 180.55,
      "low": 180.01,
      "close": 180.4,
      "volume": 120345,
      "session": "regular"
    }
  ]
}
```

- `time`: **Unix milliseconds** at **bucket start** (aligned to interval boundary).

---

## WebSocket API

**URL:** `ws://localhost:4000/ws` (or `wss://` behind TLS).

On connect, the server sends a **`hello`** message. It then pushes **`tick`**, **`candle`**, and **`source-status`** events according to subscription filters.

### Default subscription

Until the client sends **`subscribe`**, the connection receives:

- All **sources** currently in `manager.describe()`
- All **symbols** from `manager.getSymbols()`
- All **intervals**: `1s`, `5s`, `15s`, `1m`

### Client → server messages

#### `subscribe` (optional)

Narrow the stream. For each of `sources`, `symbols`, and `intervals`, if the client sends that key as an **array**, the server **replaces** its subscription set for that dimension with the array contents. Omitted keys leave the previous set unchanged (initially “everything”).

```json
{
  "type": "subscribe",
  "sources": ["binance"],
  "symbols": ["BTC-USDT"],
  "intervals": ["1s", "1m"]
}
```

**Server ack**

```json
{
  "type": "subscribed",
  "sources": ["binance"],
  "symbols": ["BTC-USDT"],
  "intervals": ["1s", "1m"]
}
```

#### `ping`

```json
{ "type": "ping" }
```

**Server response**

```json
{ "type": "pong", "t": 1714510800123 }
```

### Server → client messages

#### `hello` (initial)

```json
{
  "type": "hello",
  "sources": [ /* SourceManager.describe() entries */ ],
  "symbols": [ /* { symbol, name, source } */ ],
  "intervals": ["1s", "5s", "15s", "1m"],
  "tickIntervalMs": 250
}
```

`tickIntervalMs` reflects **`TICK_MS`** env (simulator cadence hint; live sources emit at their own natural rate).

#### `tick`

```json
{
  "type": "tick",
  "source": "coinbase",
  "symbol": "BTC-USD",
  "time": 1714510800123,
  "price": 67212.5,
  "volume": 0.04,
  "session": "regular"
}
```

- `session`: `pre` | `regular` | `post` | `closed` for US equity feeds; crypto/simulator use `regular` semantic via `SESSION_ALWAYS_OPEN`.

#### `candle`

```json
{
  "type": "candle",
  "source": "yahoo",
  "symbol": "AAPL",
  "interval": "1m",
  "closed": false,
  "candle": {
    "time": 1714510740000,
    "open": 180.1,
    "high": 180.6,
    "low": 180.0,
    "close": 180.4,
    "volume": 123456,
    "session": "pre"
  }
}
```

- `closed`: from `CandleAggregator`: `true` on the first `candle` event **after** the time bucket advances (the payload is the **new** bar’s first update; the prior bar was pushed to history). `false` on in-progress updates within the same bucket.

#### `source-status`

```json
{
  "type": "source-status",
  "id": "yahoo",
  "status": "error",
  "detail": "rate-limited",
  "name": "Yahoo Finance"
}
```

---

## Data model

### Normalized tick

Produced by each `Source` adapter and consumed by `CandleAggregator`:

| Field | Type | Description |
| ------ | ----- | ----------- |
| `source` | string | Source id (`yahoo`, `binance`, …). |
| `symbol` | string | Source-native symbol. |
| `time` | number | Event time, **epoch ms**. |
| `price` | number | Last trade or mid-derived price (provider-specific). |
| `volume` | number | Volume increment for that tick (provider-specific scaling). |
| `session` | string | `pre` \| `regular` \| `post` \| `closed` (equities) or `regular` for 24/7 feeds. |

### Candle

| Field | Type | Description |
| ------ | ----- | ----------- |
| `time` | number | Bucket **start** time in **epoch ms**. |
| `open`, `high`, `low`, `close` | number | OHLC. |
| `volume` | number | Cumulative volume in bucket. |
| `session` | string | **Locked at bucket creation** from the first tick that opens the bucket; not recomputed when subsequent ticks arrive. |

### Supported intervals

| Key | Duration |
| ----- | --------- |
| `1s` | 1 second |
| `5s` | 5 seconds |
| `15s` | 15 seconds |
| `1m` | 60 seconds |

---

## Aggregation and history

- Implemented in `server/src/aggregator.js` (`CandleAggregator`).
- **Per key:** `(source, symbol, interval)`.
- **Retention:** up to **600** finalized candles per key in memory; REST `limit` is clamped to that maximum.
- **Bucket boundary:** `floor(timeMs / (intervalSec * 1000)) * (intervalSec * 1000)`.
- **Late ticks** (timestamp before current bucket start): blended into the **current** bar without rolling back time.
- **Simulator priming:** on startup, if the simulated source exists, the server replays ~**300 seconds** of synthetic ticks into the aggregator so charts have immediate history. Real adapters rely on live flow (no long synthetic backfill).

---

## Client development proxy

`client/vite.config.js` dev server:

| Path | Target |
| ----- | -------- |
| `/api` | `http://localhost:4000` |
| `/ws` | WebSocket `ws://localhost:4000` |

The browser should use **relative** URLs (`/api/...`, `ws(s)://<host>/ws`) so the same build works behind a proxy.

---

## Testing

| Scope | Command |
| ------- | --------- |
| Server | `npm run test:server` or `npm --prefix server test` |
| Client | `npm run test:client` or `npm --prefix client test` |
| Both | `npm test` |

Client tests use **Vitest** with **jsdom** (`vite.config.js` `test` section).

---

## Frontend reference (indicators)

MACD computation (`client/src/indicators.js`):

- **EMA** seeded with SMA over the first `period` closes.
- **MACD line** = EMA(fast) − EMA(slow) on closes.
- **Signal line** = EMA(signalPeriod) on the MACD line, starting from first non-null MACD.
- **Histogram** = MACD − Signal.

Trend states used in the UI include bullish/bearish **crossovers** (MACD vs signal) and **histogram expanding/contracting** classification.

---

## Related documentation

- [Documentation index](./README.md)
- [USER_GUIDE.md](./USER_GUIDE.md)
- [DATA_SOURCES.md](./DATA_SOURCES.md) — All adapters: endpoints, semantics, vendor links.
- [../README.md](../README.md)
- [../DESIGN_SPEC.md](../DESIGN_SPEC.md)
