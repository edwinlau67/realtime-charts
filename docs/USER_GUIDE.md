# Realtime Stock Charts — User Guide

This guide explains how to **install**, **run**, and **use** the Realtime Stock Charts application from an operator or analyst perspective. For HTTP/WebSocket contracts and environment variables, see [REFERENCE.md](./REFERENCE.md). For **each data source** (Binance, Yahoo, Stooq, etc.) — URLs, behavior, limits — see [DATA_SOURCES.md](./DATA_SOURCES.md).

---

## What this application does

Realtime Stock Charts is a **local web dashboard** that:

- Ingests market **ticks** from one or more configurable **data sources** (simulated, crypto exchanges, Yahoo Finance, optional Stooq/Finnhub).
- Aggregates ticks into **OHLCV candles** at **1 second**, **5 seconds**, **15 seconds**, and **1 minute**.
- Streams updates to your browser over **WebSocket** so charts and prices update continuously.
- Shows **pre-market**, **regular**, and **after-hours** context for US-listed instruments when the data supports it.

It does **not** place trades, store long-term history in a database, or provide authenticated multi-user accounts.

---

## System requirements

- **Node.js** (current LTS recommended) with **npm**.
- Two terminal windows (or tabs) for local development: one for the **server**, one for the **client**.
- A modern desktop browser (Chrome, Firefox, Safari, Edge).

---

## Automated checks (optional)

From the repo root:

```bash
npm test       # server unit tests + client Vitest suite
npm run verify # production client build + simulated server smoke (REST + WebSocket)
```

`verify` starts the server on **`VERIFY_PORT`** (default **4010**) so it does not collide with a dev server on **4000**. Requires `curl` and a successful `npm --prefix client run build`.

---

## Installation

From the repository root:

```bash
npm run install:all
```

This installs dependencies for both `server/` and `client/`.

---

## Starting the application

### 1. Start the backend server

```bash
npm run dev:server
```

By default the server listens on **http://localhost:4000** and exposes WebSocket at **ws://localhost:4000/ws**.

### 2. Start the frontend

In a second terminal:

```bash
npm run dev:client
```

The UI is served at **http://localhost:5173**. The Vite dev server **proxies** `/api` and `/ws` to the backend, so you open **only** the client URL in the browser; you do not need to configure CORS or API base URLs.

### 3. Open the dashboard

Navigate to **http://localhost:5173**.

---

## Understanding the user interface

### Top bar

| Element | Meaning |
| -------- | -------- |
| **Auto / Light / Dark** | **Appearance**: Auto follows your OS preference; Light and Dark force a theme. The choice is stored in **localStorage** (`realtime-charts-appearance`) and applied on `<html>` as `data-theme` (`light` or `dark`) plus matching `color-scheme`, so charts and CSS stay in sync. |
| **LIVE** (green) / **CONNECTING** / **CLOSED** | **WebSocket** connection to the server. If the server stops, you may see **CLOSED** until automatic reconnect succeeds. |
| **HH:MM:SS ET** | Live clock in **US Eastern Time**, used consistently with equity session rules. |
| **N symbols** | Count of instruments currently known from the server (sum across enabled sources). |

### Data Sources (sidebar)

Each chip represents one **enabled** backend source (for example Sim, Binance, Yahoo).

| Chip state | What it usually means |
| ----------- | ---------------------- |
| Count badge | How many symbols that source contributes. |
| Status styling | Reflects adapter state (for example connecting, live, or error). Hover the chip for **detail** text from the server. |
| **All** | Shows every symbol from every source in the watchlist. |
| A specific source | **Filters** the watchlist to only symbols from that source. |

**Tip:** If a source shows an error, others can still work. The simulator is often still available unless the server was started with `SOURCES` that omits it entirely.

### Watchlist

- Lists **symbol**, **short source label**, **last known price**, and **display name** where provided.
- **Click a row** to make that `(source, symbol)` the **active** chart selection. The same ticker string from two sources (for example different exchanges) is treated as two distinct rows because the **source** differs.
- **Price flashes** (brief highlight) and **▲ / ▼** indicate direction of the most recent tick relative to the prior price for that row.

### Main header (chart area)

| Element | Meaning |
| -------- | -------- |
| **Title** | Active symbol, human-readable name, and source badge. |
| **Session pill** | For **US equity-style** sources: **Pre-Market**, **Market Open**, **After-Hours**, or **Market Closed** based on **Eastern Time** windows (see below). For **crypto** and **simulated** data: **24/7 Open**. |
| **Subtitle** | Short description of whether the feed is synthetic or live. |
| **Large price** | Latest price from the live tick stream when available; otherwise falls back to the last candle close in the loaded history. |
| **Change** | Difference vs. the **open** of the **first candle** in the currently loaded window (not necessarily “today’s open” if history is short). Shown as absolute and percent. |
| **Trend badge** (when MACD is enabled) | Summarizes **MACD vs signal** and **histogram** behavior (for example bullish crossover, fading momentum). |

### Interval buttons: 1s · 5s · 15s · 1m

- Switch the **candle resolution** for the main chart (and MACD, which is computed from the same candle series).
- Changing interval triggers a **new history fetch** from the server for the active symbol; WebSocket updates then keep the **last bar** live.

### Price and volume chart

- **Candlesticks** with **volume** below.
- **Legend** explains **session coloring**:
  - **Regular** — default green/red bodies.
  - **Pre-Market** — **amber** border emphasis (extended hours).
  - **After-Hours** — **purple** border emphasis.

These styles reflect each candle’s **session** label assigned **when the time bucket started**; the bar is not re-labeled mid-bar if the clock crosses a session boundary.

### MACD panel

- Optional panel below (or beside) the price chart, **time-scale synced** with the main chart when both are visible (pan/zoom one, the other follows).
- **MACD line**, **Signal line**, **Histogram** with **green/red** bars; histogram intensity can reflect whether momentum is **expanding** or **contracting**.
- **Indicators** section in the sidebar:
  - Toggle **MACD** on/off.
  - Adjust **Fast**, **Slow**, and **Signal** periods (defaults **12 / 26 / 9**).
  - **Reset 12/26/9** restores defaults.

When there are not enough candles for stable MACD values, the trend badge may show **Warming up**.

### Statistics row

Tiles for **Open**, **High**, **Low**, **Close** (from the visible candle set), **Volume** (sum over visible candles), and **Candles** (count loaded). These are **derived from the chart data in memory**, not a full trading day unless your history spans it.

---

## Eastern Time sessions (US equities)

For sources that use US equity clock semantics, the UI and server use **America/New_York** (DST-aware) with these **weekday** windows:

| Session | ET time |
| -------- | -------- |
| **Closed** | Before 04:00, after 20:00, and all weekend |
| **Pre-Market** | 04:00 – 09:30 |
| **Regular** | 09:30 – 16:00 |
| **After-Hours** | 16:00 – 20:00 |

**Caveats:**

- **US market holidays** are **not** modeled; a holiday Monday at 11:00 ET may still show **Market Open** in the pill even though the exchange is closed.
- **Yahoo** and **Finnhub** can surface extended-hours activity when the upstream feed includes it; **Stooq** free data is often **delayed** (~15 minutes during US hours) and may not match “live” venues.

Crypto feeds and the simulator are treated as **always regular / 24/7** for session display.

---

## Choosing what data you see (server configuration)

The **symbols and sources** in the UI come from the **server’s** environment. Typical cases:

- **Default:** simulated plus Binance, Coinbase, Kraken, Yahoo (no API keys).
- **Simulator only (offline demo):** `SOURCES=simulated` — no outbound network to market data APIs.
- **Finnhub (recommended for reliable US equities):** set `FINNHUB_API_KEY` and add `finnhub` to `SOURCES`, or run the repo preset from the project root: `FINNHUB_API_KEY=xxx npm run dev:server:finnhub` (bundled `FINNHUB_SYMBOLS` — see root `package.json`).
- **Stooq:** add `stooq` to `SOURCES`; optionally set `STOOQ_SYMBOLS`, `STOOQ_POLL_MS`, `STOOQ_FETCH_TIMEOUT_MS`, and `STOOQ_POLL_CONCURRENCY`. Your network must reach **stooq.com**.

When a **real** source registers a symbol, the **simulator** drops that symbol so you do not get duplicate streams for the same display name.

Full variable list and examples are in [REFERENCE.md](./REFERENCE.md). Feed-specific behavior and vendor documentation links are in [DATA_SOURCES.md](./DATA_SOURCES.md).

---

## Troubleshooting

| Symptom | Things to check |
| -------- | ---------------- |
| **CONNECTING** or **CLOSED** in the top bar | Server running on port **4000**? Firewall? Restart `npm run dev:server`. The client retries with exponential backoff (up to 8 seconds between attempts). |
| Blank or empty chart | Select a symbol in the watchlist. Confirm `/api/history` returns data (server logs, or open browser devtools **Network**). |
| Yahoo **HTTP 429** or stale stocks | Yahoo rate-limits many non-residential IPs. Try `YAHOO_POLL_MS=15000`, fewer `YAHOO_SYMBOLS`, or a residential network. For stable live equities, use **Finnhub** (`FINNHUB_API_KEY` + `finnhub` source, or `npm run dev:server:finnhub`). **Stooq** is a separate opt-in source (delayed CSV), not an automatic Yahoo fallback. |
| Stooq errors or timeouts | Confirm `stooq.com` resolves and is reachable (VPN/firewall/DNS). Increase `STOOQ_FETCH_TIMEOUT_MS` or lower `STOOQ_POLL_CONCURRENCY`. |
| Source chip shows **error** | Read the hover **detail**. One failed adapter does not stop others. |
| MACD says **Warming up** | Wait for more candles at the selected interval, or switch to a coarser interval temporarily. |
| Wrong port | Change `PORT` on the server and ensure `client/vite.config.js` proxy target matches if you deviate from 4000/5173. |

---

## Production-style deployment notes

This project is optimized for **local development**. If you expose it to a network:

- Serve the built client (`npm --prefix client run build`) behind a reverse proxy that also upgrades **WebSocket** for `/ws`.
- Tighten **CORS** and avoid exposing unsecured market dashboards on the public internet without authentication.

---

## Related documentation

- [Documentation index](./README.md) — list of guides in `docs/`.
- [REFERENCE.md](./REFERENCE.md) — REST & WebSocket API, message types, environment variables, data shapes.
- [DATA_SOURCES.md](./DATA_SOURCES.md) — Per-source technical reference (protocols, endpoints, defaults, support notes).
- [Project README](../README.md) — Quick start and feature overview.
- [DESIGN_SPEC.md](../DESIGN_SPEC.md) — Architecture and requirement traceability for contributors.
