# Realtime Charts Design Specification

## 1. Purpose

Define the technical design for a realtime market monitoring system that:
- streams multi-source market ticks,
- aggregates OHLCV candles up to 1-minute resolution,
- supports pre-market and post-market session awareness,
- provides a browser UI with live charting and MACD trend analysis,
- degrades gracefully when external data providers are unavailable.

## 2. Scope

In scope:
- Backend source adapters, aggregation, REST API, WebSocket broadcast.
- Frontend watchlist, source filtering, candlestick/volume chart, MACD panel.
- Session classification for US equity trading windows.
- Free-source resilience patterns (reconnect, fallback, status reporting).

Out of scope:
- Brokerage order placement.
- User accounts, auth, and multi-tenant data isolation.
- Historical backfill beyond rolling in-memory windows.
- Exchange-grade guaranteed delivery semantics.

## 3. Goals and Non-Goals

Goals:
- Near realtime visual monitoring.
- Pluggable source model.
- Single normalized message contract across providers.
- Clear observability of source health and session state.
- Fast local startup with safe offline fallback (simulated mode).

Non-goals:
- Tick-level persistence to database.
- Millisecond-perfect clock synchronization across all sources.
- Full holiday calendar compliance (weekends supported; holidays not modeled).

## 4. High-Level Architecture

Logical flow:
1. Source adapters emit normalized `tick` events.
2. `SourceManager` multiplexes source events and statuses.
3. `CandleAggregator` computes rolling OHLCV candles per `(source, symbol, interval)`.
4. Express REST provides bootstrap metadata and history snapshots.
5. WebSocket server pushes live `tick`, `candle`, and `source-status` events.
6. React client hydrates from REST, then streams incremental updates via WS.

Core backend modules:
- `server/src/sources/*` (provider adapters)
- `server/src/sources/manager.js` (orchestration)
- `server/src/aggregator.js` (OHLCV)
- `server/src/session.js` (US-equity session resolver)
- `server/src/index.js` (REST + WS integration)

Core frontend modules:
- `client/src/App.jsx` (state orchestration + UI composition)
- `client/src/components/SourceChip.jsx` (data-source filter chips + status)
- `client/src/Chart.jsx` (candlestick + volume)
- `client/src/MacdChart.jsx` (MACD panel)
- `client/src/chartTheme.js` (lightweight-charts theming)
- `client/src/indicators.js` (EMA/MACD math)
- `client/src/useAppearance.js` (Auto/Light/Dark preference, `localStorage`, `data-theme`)
- `client/src/useMarketSocket.js` (reconnecting WS hook)
- `client/src/session.js` (live client-side session labeling)

## 5. Data Model and Contracts

### 5.1 Normalized Tick

All sources must emit:
- `source: string`
- `symbol: string`
- `time: number` (epoch ms)
- `price: number`
- `volume: number`
- `session: "pre" | "regular" | "post" | "closed"`

Notes:
- Crypto/simulator are treated as `regular` (24/7 open semantic).
- US-equity sources classify session by ET time windows on the server tick.
- **Yahoo** sets tick `session` from **poll wall-clock** (`Date.now()`), not the
  intraday bar timestamp, so sub-minute aggregation aligns with “now” in ET;
  **Stooq** and **Finnhub** use quote/trade time for `session`.

### 5.2 Candle

Aggregated candle shape:
- `time: number` (bucket start ms)
- `open: number`
- `high: number`
- `low: number`
- `close: number`
- `volume: number`
- `session: string`

Session locking rule:
- Candle session is set at bucket creation and not reclassified later.

### 5.3 Intervals

Supported intervals:
- `1s`, `5s`, `15s`, `1m`

History retention:
- Rolling in-memory history capped per key and interval.

## 6. Source Layer Design

Each adapter implements the `Source` interface:
- lifecycle: `start()`, `stop()`
- metadata: `id`, `name`, `getSymbols()`, `isAvailable()`
- events: `tick`, `status`

Status states:
- `idle`, `connecting`, `live`, `error`, `disabled`

Built-in adapters:
- `simulated` (GBM synthetic ticks)
- `binance` (public WS)
- `coinbase` (public WS)
- `kraken` (public WS v2)
- `yahoo` (public polling, includes pre/post bars)
- `stooq` (CSV polling, often delayed)
- `finnhub` (WS with API key)

Collision policy:
- Real sources register first.
- Simulator excludes symbols claimed by real sources.

Yahoo resilience:
- host rotation: try `query1.finance.yahoo.com`, then `query2.finance.yahoo.com` when a host returns **401** or **429**
- per-host timeout + one retry on abort; bounded poll concurrency; no overlapping polls (`_pollInFlight`)
- **no** automatic cross-source failover (Stooq/Finnhub are separate enabled sources)

Server bootstrap:
- `dns.setDefaultResultOrder("ipv4first")` in `server/src/index.js` for outbound `fetch` stability

## 7. Session Model

US-equity session boundaries (ET):
- `pre`: 04:00-09:30
- `regular`: 09:30-16:00
- `post`: 16:00-20:00
- `closed`: all other times + weekends

Implementation:
- `Intl.DateTimeFormat` with `America/New_York` for DST correctness.
- No exchange holiday calendar integration in this version.

## 8. Aggregation Engine

Keyed by:
- `(source, symbol, interval)`

Algorithm per tick:
1. Compute interval bucket start.
2. If no active candle, open new candle.
3. If new bucket, finalize old candle and open next candle.
4. Update OHLCV fields for active candle.
5. Emit incremental `update` event each tick.

Output semantics:
- REST history includes finalized + in-progress candle.
- WS candle updates keep chart tail live.

## 9. API Design

### 9.1 REST

- `GET /api/health`
- `GET /api/sources`
- `GET /api/symbols`
- `GET /api/history?source=...&symbol=...&interval=...&limit=...`

REST is used for:
- initial metadata/bootstrap
- initial chart history window

### 9.2 WebSocket

Server -> client:
- `hello`
- `tick`
- `candle`
- `source-status`
- `pong`

Client -> server:
- `subscribe` (optional narrowing of sources/symbols/intervals)
- `ping`

Default subscription:
- all sources, all symbols, all intervals.

## 10. Frontend Design

UI zones:
- top status bar (connection + ET clock + appearance: Auto/Light/Dark)
- source filter chips + watchlist
- primary candlestick chart + volume
- optional MACD panel
- stats cards + trend/session badges

State strategy:
- bootstrap from REST
- mutate from WS incremental events
- maintain lightweight local maps keyed by `source:symbol`

Chart semantics:
- pre-market candles: amber border/wick tint
- after-hours candles: purple border/wick tint
- regular session: standard green/red palette

MACD:
- configurable fast/slow/signal periods
- line/signal/histogram series
- trend classification and crossover badge

## 11. Reliability and Failure Handling

Source-level resilience:
- exponential reconnect for WS adapters
- status emission on transitions
- partial availability tolerated (one source failing does not block others)

Degraded mode behavior:
- if all external feeds fail, simulator can still provide data
- fallback statuses are visible to clients via `source-status`

Known constraints:
- Yahoo 429 from shared/cloud IPs
- Stooq delayed quotes in free tier
- no persistent replay after restart

## 12. Performance Characteristics

Designed for:
- small-to-medium symbol sets (tens to low hundreds)
- second/sub-second update rendering
- in-memory rolling windows only

Key choices:
- no DB writes in hot path
- interval aggregation done once server-side
- clients receive normalized updates, not raw provider payloads

## 13. Security and Compliance Notes

- No credentials required for default free sources.
- Optional `FINNHUB_API_KEY` via environment variable.
- CORS is enabled for local dev use; production tightening recommended.
- No authn/authz in current architecture.

## 14. Deployment and Configuration

Primary runtime env:
- `PORT`, `TICK_MS`, `SOURCES`
- source-specific symbol/poll/timeout/concurrency vars (`YAHOO_*`, `STOOQ_*`, `FINNHUB_*`, etc.)

Recommended profiles:
- local demo: `SOURCES=simulated`
- free live mixed: default sources (`simulated`, crypto WS feeds, Yahoo)
- equities-focused (no API key): `SOURCES=yahoo` or `SOURCES=stooq` (Stooq requires reachability to stooq.com)
- key-backed equities (recommended when Yahoo returns 429): `finnhub` with `FINNHUB_API_KEY`; repo preset `npm run dev:server:finnhub` from project root

## 15. Testing Strategy

Implemented checks:
- **Unit tests**: `npm run test:server` (Node test runner: `server/test/*.test.js` —
  session resolver, aggregator), `npm run test:client` (**Vitest** + Testing Library:
  `client/src/__tests__/*.test.{js,jsx}` — indicators, session helpers, `SourceChip`, UI smoke).
- **Unified entrypoint**: `npm test` runs server then client tests.
- **Release helper**: `npm run verify` runs `scripts/verify.sh` — `vite build`, starts
  `SOURCES=simulated` server on `VERIFY_PORT` (default **4010**), validates `/api/health`,
  `/api/symbols`, `/api/sources`, `/api/history` (including `candle.session`), rejects bad
  history queries, and smoke-checks WebSocket `hello` / `tick` / `candle` with `session`.

Recommended next tests:
- contract tests for each source adapter payload normalization (mocked HTTP/WS)
- integration test for WS `subscribe` filtering beyond manual checklist
- visual regression snapshots for session coloring and MACD overlays

## 16. Future Enhancements

- Holiday-aware session calendar.
- Persistent candle/tick storage with replay on restart.
- Circuit-breaker policy per source (cooldowns, jittered retries).
- Automatic source priority/failover routing per symbol.
- Alerting rules (price thresholds, crossover triggers).
- Horizontal fanout layer for multi-client scale.

## 17. Requirement Traceability Matrix

- **R1: Multi-source pluggable ingestion**
  - **Implementation**: `server/src/sources/base.js`, `server/src/sources/manager.js`, `server/src/sources/*.js`, `server/src/index.js`
  - **Verification evidence**:
    - `GET /api/symbols` returns symbols tagged by `source`
    - `GET /api/sources` lists all enabled adapters and statuses

- **R2: Realtime tick streaming to clients**
  - **Implementation**: `server/src/index.js` (WebSocket `tick` events), `client/src/useMarketSocket.js`, `client/src/App.jsx`
  - **Verification evidence**:
    - WS smoke test receives `hello`, then `tick` events
    - UI watchlist prices update live without full-page refresh

- **R3: OHLCV aggregation up to 1-minute**
  - **Implementation**: `server/src/aggregator.js`, `server/src/index.js` (`GET /api/history`), `client/src/Chart.jsx`
  - **Verification evidence**:
    - `GET /api/history?...&interval=1m` returns correctly bucketed candles
    - WS `candle` updates mutate in-progress last bar and roll on boundary

- **R4: Session awareness (pre/regular/post/closed)**
  - **Implementation**: `server/src/session.js`, equity adapters (`yahoo.js`, `stooq.js`, `finnhub.js`), `server/src/aggregator.js`, `client/src/session.js`
  - **Verification evidence**:
    - Boundary checks confirmed 04:00/09:30/16:00/20:00 ET transitions
    - WS `tick` and `candle` payloads include `session` field

- **R5: Pre-market and after-hours visual distinction**
  - **Implementation**: `client/src/Chart.jsx`, `client/src/App.jsx`, `client/src/styles.css`
  - **Verification evidence**:
    - Session legend rendered in chart area
    - Candle coloring differs by session (amber pre, purple post, default regular)

- **R6: MACD trend analysis**
  - **Implementation**: `client/src/indicators.js`, `client/src/MacdChart.jsx`, `client/src/App.jsx`, `client/src/styles.css`
  - **Verification evidence**:
    - Build-time and runtime checks for MACD line/signal/histogram rendering
    - Trend badge states update from live candle stream

- **R7: Source health visibility and degraded-mode behavior**
  - **Implementation**: adapter status emissions (`server/src/sources/base.js` + sources), WS `source-status` and REST `/api/sources` in `server/src/index.js`, `client/src/components/SourceChip.jsx` + sidebar wiring in `client/src/App.jsx`
  - **Verification evidence**:
    - Source state transitions observed (`connecting` -> `live`/`error`)
    - UI source chips reflect live status changes

- **R8: External feed resilience and fallback**
  - **Implementation**: reconnect loops in WS adapters; Yahoo host rotation + timeouts/retries in `server/src/sources/yahoo.js`; defensive Stooq response parsing, timeouts, and bounded concurrency in `server/src/sources/stooq.js`
  - **Verification evidence**:
    - Reconnect backoff observed in source logs under network failure
    - Yahoo **429** surfaces actionable status text (slower poll, fewer symbols, or Finnhub); no hidden cross-source failover from Yahoo

- **R9: Bootstrap and discovery contracts**
  - **Implementation**: `server/src/index.js` REST endpoints (`/api/health`, `/api/sources`, `/api/symbols`, `/api/history`), initial fetch flow in `client/src/App.jsx`
  - **Verification evidence**:
    - Client starts from REST bootstrap before WS incremental updates
    - Health and metadata endpoints return valid JSON contracts

- **R10: Configurable deployment/runtime behavior**
  - **Implementation**: env parsing in `server/src/index.js`, source wiring in `server/src/sources/manager.js`, operational docs in `README.md` and `docs/*.md`
  - **Verification evidence**:
    - Launch profiles validated with `SOURCES=...` variations
    - Source counts and enabled set reflected by `/api/sources`

- **R11: Theme / appearance preference**
  - **Implementation**: `client/src/useAppearance.js` (`localStorage` key `realtime-charts-appearance`), `client/src/chartTheme.js`, `client/src/App.jsx`, `client/src/styles.css`
  - **Verification evidence**:
    - Manual: Auto follows OS; Light/Dark persist across reload
    - Client tests cover appearance hook behavior where applicable

## 18. Verification Checklist (Release Sign-off)

Run this checklist before tagging a release.

### 18.1 Build and startup

- [ ] `npm run install:all` succeeds with no fatal errors.
- [ ] `npm run dev:server` starts and prints server URL + enabled source set.
- [ ] `npm run dev:client` starts and loads UI at `http://localhost:5173`.
- [ ] `npm --prefix client run build` succeeds.
- [ ] `npm test` passes (server + client unit tests).
- [ ] `npm run verify` passes (or `VERIFY_PORT` adjusted if 4010 is in use).

### 18.2 REST contract checks

- [ ] `GET /api/health` returns `{ ok: true }`.
- [ ] `GET /api/sources` returns `sources[]` with `id`, `status`, `symbols`.
- [ ] `GET /api/symbols` returns `symbols[]` with `source` tags.
- [ ] `GET /api/history?source=<s>&symbol=<sym>&interval=1m&limit=3` returns candles.
- [ ] Invalid `(source, symbol)` returns a clean error payload (not a crash).

### 18.3 WebSocket checks

- [ ] WS connect receives `hello` event.
- [ ] `tick` events stream with `source`, `symbol`, `time`, `price`, `volume`, `session`.
- [ ] `candle` events stream with interval + `candle.session`.
- [ ] `source-status` events arrive when adapters transition state.
- [ ] `subscribe` narrowing by source/symbol/interval is honored.

### 18.4 Aggregation correctness

- [ ] 1s/5s/15s/1m intervals all produce candles.
- [ ] In-progress candle updates mutate last bar without duplicating buckets.
- [ ] Bucket rollover closes prior candle and starts next at correct boundary.
- [ ] Candle `session` remains stable for the candle lifetime.

### 18.5 Session model checks

- [ ] Session boundaries map correctly to ET windows:
  - pre: 04:00–09:30
  - regular: 09:30–16:00
  - post: 16:00–20:00
  - closed: outside + weekends
- [ ] Equity sources emit session by trade/poll time.
- [ ] Crypto/simulated sources emit `regular` (24/7 semantic).

### 18.6 UI behavior checks

- [ ] Watchlist updates live and source badges render correctly.
- [ ] Source filter chips narrow watchlist (`SourceChip` states match `/api/sources`).
- [ ] Appearance **Auto / Light / Dark** works and survives page reload.
- [ ] Session pill and ET clock update continuously.
- [ ] Session legend is visible and matches candle tint behavior.
- [ ] Candlestick + volume chart updates in realtime.
- [ ] MACD panel renders, updates live, and follows symbol/interval switches.
- [ ] MACD trend badge updates and crossover pulse appears on transitions.

### 18.7 Resilience/failover checks

- [ ] Disabling one source does not interrupt other active sources.
- [ ] WS adapters reconnect with backoff after forced disconnect.
- [ ] Yahoo 429/401 path reports meaningful status.
- [ ] Yahoo host fallback (`query1` -> `query2`) is exercised.
- [ ] Yahoo->Stooq fallback path keeps emitting ticks when Yahoo is throttled.
- [ ] Stooq non-CSV responses (e.g., limit message) are surfaced as explicit errors.

### 18.8 Configuration checks

- [ ] `SOURCES=simulated` runs cleanly with no external dependencies.
- [ ] Default `SOURCES` profile runs and shows expected adapters.
- [ ] Source-specific symbol env vars are honored (e.g., `YAHOO_SYMBOLS`, `BINANCE_PAIRS`).
- [ ] Poll interval env vars are honored (`YAHOO_POLL_MS`, `STOOQ_POLL_MS`).
- [ ] Optional `FINNHUB_API_KEY` enables/disables Finnhub adapter as expected.

### 18.9 Documentation checks

- [ ] `README.md` matches implemented endpoints and env vars.
- [ ] `DESIGN_SPEC.md` traceability entries match current file structure.
- [ ] `docs/USER_GUIDE.md`, `docs/REFERENCE.md`, and `docs/DATA_SOURCES.md` match current behavior.
- [ ] Any newly added source/feature is reflected in the docs above.
