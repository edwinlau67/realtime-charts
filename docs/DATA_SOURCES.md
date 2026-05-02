# Data sources — technical reference

This document describes **every** market data adapter in `server/src/sources/`: protocols, URLs, configuration, normalized output, and operational constraints. For generic REST/WebSocket contracts, see [REFERENCE.md](./REFERENCE.md).

---

## Shared adapter contract

All sources extend `Source` (`server/src/sources/base.js`) and emit:

### `tick` event (normalized)

| Field | Type | Notes |
| ----- | ---- | ----- |
| `source` | `string` | Adapter id: `simulated`, `binance`, `coinbase`, `kraken`, `okx`, `yahoo`, `stooq`, `finnhub`, `alpaca`, `twelvedata`. |
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
| `okx` | WebSocket | No | No (opt-in) | `regular` |
| `alpaca` | WebSocket | Yes (`ALPACA_API_KEY` + `ALPACA_API_SECRET`) | No (opt-in) | `sessionForUSEquity(trade time)` |
| `twelvedata` | WebSocket | Yes (`TWELVE_DATA_API_KEY`) | No (opt-in) | `sessionForUSEquity(trade time)` or `regular` for forex |

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

### Process-wide DNS

`server/src/index.js` calls `dns.setDefaultResultOrder("ipv4first")` so slow or broken IPv6 routes are less likely to leave HTTPS fetches hanging until the per-request timeout (applies to Yahoo, Stooq, and any other `fetch` from the server).

### HTTP endpoints

**Per symbol**, hosts are tried in order:

`https://{host}/v8/finance/chart/{symbol}?interval=1m&range=1d&includePrePost=true`

- **Hosts**: `query1.finance.yahoo.com`, then `query2.finance.yahoo.com`.
- If a host returns **429** or **401**, the client tries the **next** host. Other HTTP statuses stop host rotation for that symbol.
- Each host request uses a **timeout** (`YAHOO_FETCH_TIMEOUT_MS`, default **15000** ms). On **AbortError** (timeout), the client **retries once** after a short delay, then may try the next host.

There is **no automatic Stooq (or other) failover** from Yahoo; use the **`stooq`** or **`finnhub`** source separately if Yahoo is unavailable or rate-limited.

### Request headers

Browser-like **User-Agent**, **Accept**, **Accept-Language**, **Referer** (`https://finance.yahoo.com/`), and **Origin** — bare Node defaults often see **401/403/429** more often.

### Configuration

| Env | Default | Description |
| --- | ------- | ----------- |
| `YAHOO_SYMBOLS` | 9 symbols (AAPL, MSFT, … QQQ) | Comma list; uppercased if strings. |
| `YAHOO_POLL_MS` | `3000` | Poll interval. |
| `YAHOO_FETCH_TIMEOUT_MS` | `15000` | Per-request HTTP timeout (ms); minimum **5000** if set lower. |
| `YAHOO_POLL_CONCURRENCY` | `4` | Max symbols polled in parallel per cycle (clamped **1–4**). |

### Polling behavior

- Symbols are fetched in **batches** of up to `YAHOO_POLL_CONCURRENCY` (not one giant `Promise.all` for all symbols).
- If a poll is still running when the next interval fires, the overlapping run is **skipped** (`_pollInFlight` guard).
- Uses latest **valid 1m bar close** in the last few slots, or falls back to `meta.regularMarketPrice` / `regularMarketTime`.
- **Volume**: delta of cumulative bar volume vs previous poll in the **same** bar; new bar sends full bar volume delta logic.
- **`includePrePost=true`**: extended hours reflected in bar data where Yahoo provides it.

### Tick semantics (important)

- **`time`**: **`Date.now()`** at poll time — not the bar timestamp — so sub-minute candles get distributed across the minute when aggregating.
- **`session`**: `sessionForUSEquity(Date.now())` — tied to **poll wall-clock**, not the Yahoo bar’s `timestamp`, so the ET session pill and tick labeling stay aligned with “now” while OHLC still comes from the latest 1m bar close.

### Failure modes

- All symbols fail: status **error**, consecutive error count. **HTTP 429** is common from cloud/datacenter or aggressive polling; status text suggests slower `YAHOO_POLL_MS`, residential IP, or **Finnhub**.
- **`fetch failed`**: underlying `cause` (e.g. **ENOTFOUND**, **ETIMEDOUT**) is surfaced in the error message when available.
- Requires **Node 18+** `global fetch`; otherwise **disabled**.

### Official reference

Yahoo does not publish a supported public API for this use; treat as best-effort. Chart endpoint behavior is described in many third-party docs (e.g. libraries wrapping the same URL pattern).

---

## `stooq` — CSV quote polling

| | |
| --- | --- |
| **Class** | `StooqSource` (`server/src/sources/stooq.js`) |
| **Purpose** | **HTTP** CSV quotes — opt-in alternative when Yahoo is rate-limited or unsuitable; reliability depends on network path to **stooq.com** (some VPNs/firewalls block or slow it). |

### Provider

- **Endpoint** (per symbol): `https://stooq.com/q/l/?s={stooqSymbol}&f=sd2t2ohlcv&h&e=csv`
- **No API key.**

### Request headers

Browser-like **User-Agent**, **Accept**, **Accept-Language**, and **Referer** (`https://stooq.com/`).

### Configuration

| Env | Default | Description |
| --- | ------- | ----------- |
| `STOOQ_SYMBOLS` | 9 US names | Comma list. **Stooq format**: lowercase ticker + market suffix, e.g. `aapl.us`, `msft.us`. Bare `AAPL` normalizes to `aapl.us`. |
| `STOOQ_POLL_MS` | `5000` | Poll interval. |
| `STOOQ_FETCH_TIMEOUT_MS` | `25000` | Per-request HTTP timeout (ms); minimum **8000** if set lower. |
| `STOOQ_POLL_CONCURRENCY` | `3` | Max symbols polled in parallel per cycle (clamped **1–3**). |

### Symbol rules

- **Suffix required** for Stooq: `.us` (US), `.uk`, `.de`, etc.
- **UI symbol** (`getSymbols`): base ticker uppercased (e.g. `AAPL`), not the Stooq id.

### Polling behavior

- Symbols are fetched in **batches** of up to `STOOQ_POLL_CONCURRENCY` (not all symbols at once).
- If a poll is still running when the next interval fires, the overlapping run is **skipped** (`_pollInFlight` guard).
- **Two attempts** per symbol on **AbortError** (timeout), with a short delay between attempts.
- Emits a tick **only when Close changes** vs last emit (avoids spamming identical values).
- Generic Node **`fetch failed`** errors are rewritten to include **`cause`** (e.g. DNS code) when present.

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

From the **repository root**, `FINNHUB_API_KEY=xxx npm run dev:server:finnhub` enables `SOURCES=finnhub` with a longer bundled symbol list (see root `package.json` script).

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

## `okx` — Public trade stream

| | |
| --- | --- |
| **Class** | `OkxSource` (`server/src/sources/okx.js`) |
| **Purpose** | Live crypto **trades**, USDT spot pairs. |

### Provider documentation

- [OKX WebSocket — Subscribe](https://www.okx.com/docs-v5/en/#overview-websocket-subscribe)

### Connection

- **URL**: `wss://ws.okx.com:8443/ws/v5/public`
- **Subscribe** (on open): `{ op: "subscribe", args: [{ channel: "trades", instId: "BTC-USDT" }, ...] }`

### Configuration

| Env | Default | Description |
| --- | ------- | ----------- |
| `OKX_INSTRUMENTS` | Built-in 4 pairs | Comma-separated OKX instrument ids (e.g. `BTC-USDT,ETH-USDT`). |

### Default instruments

`BTC-USDT`, `ETH-USDT`, `SOL-USDT`, `XRP-USDT`.

### Symbol exposure (collision avoidance)

Each OKX symbol is published as **`{instId}-O`** (e.g. `BTC-USDT-O`) to avoid colliding with Binance's `BTC-USDT`.

### Tick mapping

- `time`: `t` field (epoch ms) or `Date.now()`.
- `price`: `px`; `volume`: `sz` × **10⁴** rounded (min 1).
- `session`: `regular`.

### Heartbeat

OKX closes idle connections after ~30 s without traffic. The adapter sends a plain-string **`"ping"`** every **25 s**; the server responds with `"pong"` (handled by skipping the string before JSON parse).

### Resilience

- Exponential backoff reconnect (max 30 s); heartbeat cleared on close.

---

## `alpaca` — IEX trade stream

| | |
| --- | --- |
| **Class** | `AlpacaSource` (`server/src/sources/alpaca.js`) |
| **Purpose** | Live **US equity trades** via Alpaca's IEX feed (free paper account). |

### Provider documentation

- [Alpaca WebSocket Streaming — Real-time Trades](https://docs.alpaca.markets/reference/websocket-streaming)

### Connection

- **URL**: `wss://stream.data.alpaca.markets/v2/iex`
- **Two-step auth**: send `{ action: "auth", key, secret }` on open; subscribe only after receiving `{ T: "success", msg: "authenticated" }`. Subscribing before the ack results in a silent drop.
- **Subscribe**: `{ action: "subscribe", trades: ["AAPL", ...] }`

### Configuration

| Env | Default | Description |
| --- | ------- | ----------- |
| `ALPACA_API_KEY` | *(required)* | Free paper-account key from Alpaca; without it adapter is **disabled**. |
| `ALPACA_API_SECRET` | *(required)* | Corresponding paper-account secret. |
| `ALPACA_SYMBOLS` | 9 US equities/ETFs | Comma list of tickers. |

### Default symbols

AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA, SPY, QQQ.

### Tick mapping

- `time`: `t` (ISO string → `Date.parse`) or `Date.now()`.
- `symbol`: `S`; `price`: `p`; `volume`: `s` rounded (min 1).
- `session`: `sessionForUSEquity(time)`.

### Availability

- `start()` no-ops with status **disabled** if either key is missing.

### Resilience

- Exponential backoff reconnect (max 30 s).

---

## `twelvedata` — WebSocket quotes

| | |
| --- | --- |
| **Class** | `TwelveDataSource` (`server/src/sources/twelvedata.js`) |
| **Purpose** | Live **US equities + forex** (push stream). Free tier: max **8** concurrent symbols. |

### Provider documentation

- [Twelve Data WebSocket](https://twelvedata.com/docs#websocket)

### Connection

- **URL**: `wss://ws.twelvedata.com/v1/quotes/price?apikey={TWELVE_DATA_API_KEY}`
- **Subscribe** (on open): `{ action: "subscribe", params: { symbols: "AAPL,EUR/USD,..." } }`

### Configuration

| Env | Default | Description |
| --- | ------- | ----------- |
| `TWELVE_DATA_API_KEY` | *(required)* | Free key from Twelve Data; without it adapter is **disabled**. |
| `TWELVE_DATA_SYMBOLS` | 8 symbols | Comma list of mixed equity + forex symbols. Free tier cap: **8** concurrent. |

### Default symbols

AAPL, MSFT, GOOGL, AMZN, NVDA (equities), EUR/USD, GBP/USD, USD/JPY (forex).

### Tick mapping

- Message: `event === "price"`.
- `time`: `timestamp` (Unix **seconds** → ms; Twelve Data uses seconds, not ms).
- `symbol`: `symbol`; `price`: `price`; `volume`: `day_volume` rounded (min 1).
- `session`: `regular` for forex symbols (detected by `/` in symbol), `sessionForUSEquity(time)` for equities.

### Heartbeat quirk

The server sends `{ event: "heartbeat" }` every ~10 s. The adapter **echoes it back** unchanged; missing heartbeats cause a silent disconnect after ~30 s.

### Availability

- `start()` no-ops with status **disabled** if key missing.

### Resilience

- Exponential backoff reconnect (max 30 s).

---

## Source orchestration (`SourceManager`)

File: `server/src/sources/manager.js`.

### Enable list

Environment variable **`SOURCES`**: comma-separated subset of  
`simulated`, `binance`, `coinbase`, `kraken`, `okx`, `yahoo`, `stooq`, `finnhub`, `alpaca`, `twelvedata`.

### Start order

1. Real adapters (binance → coinbase → kraken → okx → yahoo → stooq → finnhub → alpaca → twelvedata) in fixed code order.
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
