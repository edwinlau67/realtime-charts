# CLAUDE.md

We're building the app described in @DESIGN_SPEC.md. Read that file for general architectural tasks or to double-check the exact database structure, tech stack or application architecture.

Keep your replies extremely concise and focus on conveying the key information. No unnecessary fluff, no long code snippets.

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Setup
npm run install:all          # install server + client deps

# Development (run in separate terminals)
npm run dev:server            # server on :4000 (default: simulated + binance + coinbase + kraken + yahoo)
npm run dev:server:finnhub    # server with Finnhub preset — requires FINNHUB_API_KEY in .env
npm run dev:server:alpaca     # server with Alpaca preset — requires ALPACA_API_KEY + ALPACA_API_SECRET in .env
npm run dev:server:twelvedata # server with Twelve Data preset — requires TWELVE_DATA_API_KEY in .env
npm run dev:server:okx        # server with OKX only (no key)
npm run dev:client            # Vite dev server on :5173

# Tests
npm test                      # server (Node --test) + client (Vitest) in sequence
npm run test:server           # server tests only
npm run test:client           # client tests only

# Verification
npm run verify                # build + REST contract + WS smoke test (simulated source only, no keys needed)
# Optional: VERIFY_PORT=4010 npm run verify  (if port 4010 is free)
```

Running a single test file:
- Server: `node --test server/test/<file>.test.js`
- Client: `npm --prefix client run test -- <filename>` (Vitest filters by filename substring)

## Architecture

### Monorepo layout
- `server/` — Node.js ESM, Express + ws. No TypeScript.
- `client/` — React 18 + Vite + lightweight-charts. No TypeScript, no ESLint config.

Vite dev proxy routes `/api` and `/ws` to `:4000`, so no CORS config is needed in dev.

### Data flow
```
Source adapters → ticks → Aggregator → OHLCV candles → WebSocket broadcast
                                                       → REST /api/history
```

**Tick contract** — every source emits objects shaped `{ source, symbol, time, price, volume }`. The aggregator in `server/src/aggregator.js` buckets these into four resolutions (1s, 5s, 15s, 1m) with a 600-candle rolling history per symbol/interval.

### Source adapters (`server/src/sources/`)
Each adapter extends `base.js` and emits ticks. `manager.js` orchestrates start/stop and broadcasts ticks to the aggregator and WS clients. The simulator auto-yields any symbol claimed by a real source at startup.

To add a new source: subclass `base.js`, emit ticks, register in `manager.js`.

| Adapter | Protocol | Key required |
|---------|----------|-------------|
| `simulated` | internal GBM | no |
| `binance` | WS push | no |
| `coinbase` | WS push | no |
| `kraken` | WS push | no |
| `okx` | WS push | no |
| `yahoo` | HTTP poll (3 s) | no |
| `stooq` | HTTP poll (5 s) | no |
| `finnhub` | WS push | yes (`FINNHUB_API_KEY`) |
| `alpaca` | WS push | yes (`ALPACA_API_KEY` + `ALPACA_API_SECRET`) |
| `twelvedata` | WS push | yes (`TWELVE_DATA_API_KEY`) |

Active adapters are controlled by the `SOURCES` env var (default: `simulated,binance,coinbase,kraken,yahoo`).

### Session tagging (`server/src/session.js`)
Every tick and candle carries a `session` label: `pre` / `regular` / `post` / `closed`. The classifier uses DST-correct ET. Yahoo uses poll-time for session; Stooq and Finnhub use the trade timestamp; crypto sources always emit `regular`.

### Client bootstrap + streaming (`client/src/`)
On load, the client fetches `GET /api/symbols` and `GET /api/history` for initial candle history, then opens `ws://localhost:4000/ws`. The server sends a `hello` message listing sources/symbols/intervals, followed by `tick` and `candle` messages as data arrives.

- `useMarketSocket.js` — WS lifecycle with exponential backoff reconnection
- `App.jsx` — owns symbol/source filter state, wires socket data to chart components
- `Chart.jsx` / `MacdChart.jsx` — consume the candle series via lightweight-charts

### Key server env vars

| Var | Default | Notes |
|-----|---------|-------|
| `PORT` | `4000` | HTTP + WS port |
| `SOURCES` | `simulated,binance,coinbase,kraken,yahoo` | Comma list of enabled adapters |
| `FINNHUB_API_KEY` | *(unset)* | Required to enable finnhub |
| `TICK_MS` | `250` | Simulator tick cadence (ms) |
| `YAHOO_POLL_MS` | `3000` | Yahoo polling cadence |

See `README.md` for the full env var table and source-specific examples.
