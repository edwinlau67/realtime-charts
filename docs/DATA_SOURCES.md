# Data sources — technical reference

This document describes **every** market data adapter in `server/src/sources/`: protocols, URLs, configuration, normalized output, and operational constraints. For generic REST/WebSocket contracts, see [REFERENCE.md](./REFERENCE.md).

---

## Shared adapter contract

All sources extend `Source` (`server/src/sources/base.js`) and emit:

### `tick` event (normalized)

| Field | Type | Notes |
| ----- | ---- | ----- |
| `source` | `string` | Adapter id: `simulated`, `binance`, `coinbase`, `kraken`, `yahoo`, `stooq`, `finnhub`. |
| `symbol` | `string` | Canonical symbol for this app (may differ from exchange-native id). |
| `time` | `number` | Epoch **milliseconds**. Semantics vary by source (trade time vs poll time — see each section). |
| `price` | `number` | Last trade price or best available quote-derived value. |
| `volume` | `number` | Non-negative increment; scaled for visibility on some sources. |
| `session` | `string` | `pre` \| `regular` \| `post` \| `closed` for US-equity time classification, or `regular` for 24/7 feeds (`SESSION_ALWAYS_OPEN`). |

### `status` event

Emitted via `setStatus(status, detail)`:

| `status` | Typical meaning |
| -------- | ---------------- |
| `idle` | Stopped or not started. |
| `connecting` | Connecting or first poll in flight. |
| `live` | Streaming or polling successfully. |
| `error` | Recoverable failure; many adapters schedule reconnect. |
| `disabled` | Not usable (missing API key, missing `fetch`, etc.). |

---

## Quick comparison

| Id | Transport | API key | Default in `SOURCES` | Session on ticks |
| -- | --------- | ------- | -------------------- | ---------------- |
| `simulated` | In-process timer | No | Yes | `regular` |
| `binance` | WebSocket | No | Yes | `regular` |
| `coinbase` | WebSocket | No | Yes | `regular` |
| `kraken` | WebSocket | No | Yes | `regular` |
| `yahoo` | HTTP polling | No | Yes | `sessionForUSEquity(time)` using **poll-time** `Date.now()` |
| `stooq` | HTTP polling | No | No (opt-in) | `sessionForUSEquity(bar time)` |
| `finnhub` | WebSocket | Yes (`FINNHUB_API_KEY`) | No (opt-in) | `sessionForUSEquity(trade time)` |

---

## `simulated` — Geometric Brownian Motion

| | |
| --- | --- |
| **Class** | `SimulatedSource` (`server/src/sources/simulated.js`) |
| **Purpose** | Offline-safe synthetic ticks; fills gaps when real feeds are disabled or excluded symbols need data. |
| **Availability** | `isAvailable()` is true if at least one symbol remains after collision exclusion. |

### Configuration

| Env / ctor | Default | Description |
| ---------- | ------- | ----------- |
| `TICK_MS` | `250` | Interval between `_tick()` runs (ms). |
| `excludeSymbols` | *(from SourceManager)* | Set of symbol strings **not** simulated because another source owns them. |

### Symbol universe

Defined in `server/src/symbols.js` (8 names: AAPL, MSFT, GOOGL, AMZN, NVDA, TSLA, META, BTC — each with `price`, `drift`, `vol`, `vps`).

### Algorithm

- **GBM** step per tick: Box-Muller Gaussian, annualized drift/vol scaled with `252 * 6.5 * 3600` seconds per “year” for intraday steps.
- **Volume**: Poisson-like scaling from `vps` (volume per second) × tick duration × random factor.

### Tick semantics

- `time`: `Date.now()` at tick emission.
- `session`: always `regular` (`SESSION_ALWAYS_OPEN`).
- **Startup priming**: `server/src/index.js` replays ~300s of synthetic ticks at boot so OHLCV history is non-empty before the first client connects.

### Official reference

N/A (internal simulator).

---

## `binance` — Spot public trade stream

| | |
| --- | --- |
| **Class** | `BinanceSource` (`server/src/sources/binance.js`) |
| **Purpose** | Live crypto **trades** (not book), USDT spot pairs. |

### Provider documentation

- [Binance Spot WebSocket — Trade streams](https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams#trade-streams)

### Connection

- **URL**: `wss://stream.binance.com:9443/stream?streams=<pair1>@trade/<pair2>@trade/...`
- **Combined stream** JSON wrapper: each message has `data.e === "trade"`.

### Configuration

| Env | Default | Description |
| --- | ------- | ----------- |
| `BINANCE_PAIRS` | Built-in 6 pairs | Comma-separated **lowercase** stream ids (e.g. `btcusdt,ethusdt`). Strings are mapped to `{ pair, display, name }` with `display = pair.toUpperCase()` if not using the rich default objects. |

### Default pairs (stream id → display symbol)

| Stream `pair` | Display `symbol` | Display name |
| ------------- | ------------------ | ------------ |
| `btcusdt` | `BTC-USDT` | Bitcoin / USDT |
| `ethusdt` | `ETH-USDT` | Ethereum / USDT |
| `solusdt` | `SOL-USDT` | Solana / USDT |
| `bnbusdt` | `BNB-USDT` | BNB / USDT |
| `xrpusdt` | `XRP-USDT` | Ripple / USDT |
| `dogeusdt` | `DOGE-USDT` | Dogecoin / USDT |

**Naming rule:** Binance native `BTCUSDT` is exposed as **`BTC-USDT`** so it does not collide with Coinbase `BTC-USD`.

### Tick mapping

- `time`: Binance field `T` (trade time ms) or `Date.now()`.
- `price`: `p`; `volume`: `q` (rounded, min 1).
- `session`: `regular`.

### Resilience

- On socket **close** (not user stop): exponential backoff reconnect, delay `min(1000 * 2^attempts, 30000)` ms.
- **Error** handler closes socket and relies on close/reconnect path.

---

## `coinbase` — Exchange public matches

| | |
| --- | --- |
| **Class** | `CoinbaseSource` (`server/src/sources/coinbase.js`) |
| **Purpose** | Live **matches** (trades) on Coinbase Exchange. |

### Provider documentation

- [Coinbase Developer Platform — Exchange WebSocket overview](https://docs.cdp.coinbase.com/exchange/docs/websocket-overview)

### Connection

- **URL**: `wss://ws-feed.exchange.coinbase.com`
- **Subscribe** (on open): `{ type: "subscribe", product_ids: [...], channels: ["matches"] }`

### Configuration

| Env | Default | Description |
| --- | ------- | ----------- |
| `COINBASE_PRODUCTS` | 6 products | Comma-separated product ids (e.g. `BTC-USD,ETH-USD`). Uppercased when parsed from strings. |

### Default products

`BTC-USD`, `ETH-USD`, `SOL-USD`, `XRP-USD`, `LTC-USD`, `DOGE-USD` with human-readable names.

### Tick mapping

- Handles `type === "match"` and `type === "last_match"` (subscription snapshot).
- `symbol`: `product_id` unchanged.
- `time`: `Date.parse(msg.time)` or `Date.now()`.
- `price`: `price`; `volume`: `size` × **10⁴** rounded (comment in code: fractional BTC scaled for chart visibility).
- `session`: `regular`.

### Resilience

- Same backoff pattern as Binance (max 30s).

---

## `kraken` — WebSocket v2 trade channel

| | |
| --- | --- |
| **Class** | `KrakenSource` (`server/src/sources/kraken.js`) |
| **Purpose** | Live **trade** events, public v2 API. |

### Provider documentation

- [Kraken WebSocket v2 — Trade](https://docs.kraken.com/api/docs/websocket-v2/trade)

### Connection

- **URL**: `wss://ws.kraken.com/v2`
- **Subscribe**: `{ method: "subscribe", params: { channel: "trade", symbol: [...], snapshot: false } }`

### Configuration

| Env | Default | Description |
| --- | ------- | ----------- |
| `KRAKEN_PAIRS` | 6 pairs | Comma-separated Kraken pair symbols (e.g. `BTC/USD,ETH/USD`). |

### Default pairs

`BTC/USD`, `ETH/USD`, `SOL/USD`, `XRP/USD`, `ADA/USD`, `DOT/USD`.

### Symbol exposure (collision avoidance)

Kraken’s `BTC/USD` is published to the rest of the app as **`BTC/USD-K`** (suffix `-K`) so it is distinct from Coinbase **`BTC-USD`**.

### Tick mapping

- Listens for `channel === "trade"` and iterates `msg.data`.
- `symbol`: `{pair}-K`.
- `time`: `Date.parse(t.timestamp)` or `Date.now()`.
- `price`: `price`; `volume`: `qty` × **10⁴** rounded (min 1).
- `session`: `regular`.

### Heartbeat

- **Ping** every **30s** (`{ method: "ping" }`) because Kraken may idle-close ~60s without traffic.

### Resilience

- Exponential backoff reconnect (max 30s); heartbeat cleared on close.

---

## `yahoo` — Chart API polling

| | |
| --- | --- |
| **Class** | `YahooSource` (`server/src/sources/yahoo.js`) |
| **Purpose** | US equities, ETFs, indices, FX, funds, Yahoo crypto tickers — anything Yahoo’s **v8 chart** endpoint resolves. |

### Unofficial / community usage

The endpoint is widely used by open-source tooling; Yahoo may change or throttle it without notice.

### HTTP endpoints

**Primary** (tried in order for each symbol):

`https://{host}/v8/finance/chart/{symbol}?interval=1m&range=1d&includePrePost=true`

- **Hosts**: `query1.finance.yahoo.com`, then `query2.finance.yahoo.com` on **429** or **401** only (loop continues to next host or fails).

**Failover** (when last Yahoo response was 429 or 401):

`https://stooq.com/q/l/?s={stooqTicker}&f=sd2t2ohlcv&h&e=csv`

- US symbols mapped: `AAPL` → `aapl.us` via `toStooqSymbol`.

### Request headers

- Browser-like **User-Agent** and **Accept** (Node’s default UA often gets **401/403**).

### Configuration

| Env | Default | Description |
| --- | ------- | ----------- |
| `YAHOO_SYMBOLS` | 9 symbols (AAPL, MSFT, … QQQ) | Comma list; uppercased if strings. |
| `YAHOO_POLL_MS` | `3000` | Poll interval. |

### Polling behavior

- One **parallel** `Promise.all` over all symbols each cycle.
- Uses latest **valid 1m bar close** in the last few slots, or falls back to `meta.regularMarketPrice` / `regularMarketTime`.
- **Volume**: delta of cumulative bar volume vs previous poll in the **same** bar; new bar sends full bar volume delta logic.
- **`includePrePost=true`**: extended hours reflected in bar data where Yahoo provides it.

### Tick semantics (important)

- **`time`**: **`Date.now()`** at poll time — not the bar timestamp — so sub-minute candles get distributed across the minute when aggregating.
- **`session`**: `sessionForUSEquity(Date.now())` — tied to **poll wall-clock**, not the Yahoo bar’s `timestamp`, so the ET session pill and tick labeling stay aligned with “now” while OHLC still comes from the latest 1m bar close.
- Status detail may include **`failover: stooq`** when Yahoo throttled and CSV fallback succeeded.

### Failure modes

- All symbols fail: status **error**, consecutive error count; **429** hints suggest `YAHOO_POLL_MS=10000` or Stooq.
- Requires **Node 18+** `global fetch`; otherwise **disabled**.

### Official reference

Yahoo does not publish a supported public API for this use; treat as best-effort. Chart endpoint behavior is described in many third-party docs (e.g. libraries wrapping the same URL pattern).

---

## `stooq` — CSV quote polling

| | |
| --- | --- |
| **Class** | `StooqSource` (`server/src/sources/stooq.js`) |
| **Purpose** | Reliable **HTTP** quotes from environments where Yahoo returns **429** (datacenters, shared egress). |

### Provider

- **Endpoint** (per symbol): `https://stooq.com/q/l/?s={stooqSymbol}&f=sd2t2ohlcv&h&e=csv`
- **No API key.**

### Configuration

| Env | Default | Description |
| --- | ------- | ----------- |
| `STOOQ_SYMBOLS` | 9 US names | Comma list. **Stooq format**: lowercase ticker + market suffix, e.g. `aapl.us`, `msft.us`. Bare `AAPL` normalizes to `aapl.us`. |
| `STOOQ_POLL_MS` | `5000` | Poll interval. |

### Symbol rules

- **Suffix required** for Stooq: `.us` (US), `.uk`, `.de`, etc.
- **UI symbol** (`getSymbols`): base ticker uppercased (e.g. `AAPL`), not the Stooq id.

### Polling behavior

- **One HTTP request per symbol** in parallel (bulk `?s=a,b` noted as broken in code comments).
- Emits a tick **only when Close changes** vs last emit (avoids spamming identical values).

### Tick semantics

- `time`: parsed from CSV **Date** / **Time** (UTC `Z` parse) or `Date.now()`.
- `session`: `sessionForUSEquity(time)` — uses **quote row time**.
- `volume`: row volume / **60** rounded (min 1).

### Latency / accuracy

- Free tier often **~15–20 minutes delayed** during US hours; after hours, last close.
- Non-CSV body (e.g. rate/limit message) throws with snippet for observability.

### Requirements

- Node 18+ `fetch`.

### Official reference

- [Stooq](https://stooq.com/) — data terms and limits are defined by Stooq; this app uses the public `q/l` CSV line endpoint.

---

## `finnhub` — WebSocket trades

| | |
| --- | --- |
| **Class** | `FinnhubSource` (`server/src/sources/finnhub.js`) |
| **Purpose** | Live **US equity trades** (push stream). |

### Provider documentation

- [Finnhub WebSocket — Trades](https://finnhub.io/docs/api/websocket-trades)

### Connection

- **URL**: `wss://ws.finnhub.io?token={FINNHUB_API_KEY}`
- On open: for each symbol, `{"type":"subscribe","symbol":"AAPL"}` (etc.)

### Configuration

| Env | Default | Description |
| --- | ------- | ----------- |
| `FINNHUB_API_KEY` | *(required)* | Free/developer keys available from Finnhub; without it adapter is **disabled**. |
| `FINNHUB_SYMBOLS` | 7 US equities | Comma list of tickers. |

### Default symbols

AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA.

### Tick mapping

- Message: `type === "trade"`, `data` array.
- `time`: `t` (ms) or `Date.now()`.
- `symbol`: `s` (exchange ticker as returned).
- `price`: `p`; `volume`: `v` rounded (min 1).
- `session`: `sessionForUSEquity(time)`.

### Availability

- `start()` no-ops with status **disabled** if key missing; symbols may still appear in `/api/symbols`.

### Resilience

- Exponential backoff reconnect (max 30s).

### Support / compliance

- Usage subject to [Finnhub](https://finnhub.io/) terms, rate limits, and key tier. This app does not embed billing or quota UI.

---

## Source orchestration (`SourceManager`)

File: `server/src/sources/manager.js`.

### Enable list

Environment variable **`SOURCES`**: comma-separated subset of  
`simulated`, `binance`, `coinbase`, `kraken`, `yahoo`, `stooq`, `finnhub`.

### Start order

1. Real adapters (binance → coinbase → kraken → yahoo → stooq → finnhub) in fixed code order.
2. **Simulated** last, with `excludeSymbols` = all `symbol` strings from prior sources’ `getSymbols()`.

### Collision policy

- No two adapters should emit the **same** `symbol` string for different instruments; crypto ids are intentionally distinct (`BTC-USDT` vs `BTC-USD` vs `BTC/USD-K`).
- Simulated drops any symbol **string** already claimed by a real source.

---

## Related documentation

- [Documentation index](./README.md)
- [REFERENCE.md](./REFERENCE.md) — REST, WebSocket, env summary.
- [USER_GUIDE.md](./USER_GUIDE.md) — Using the UI and sessions.
- [DESIGN_SPEC.md](../DESIGN_SPEC.md) — Architecture and traceability.
