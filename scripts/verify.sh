#!/usr/bin/env bash
set -euo pipefail

# Lightweight release verification helper for the realtime charts project.
# Runs local checks only (no paid credentials required).

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${VERIFY_PORT:-4010}"
SERVER_PID=""

cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

log() {
  printf "\n==> %s\n" "$1"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: required command '$1' not found"
    exit 1
  }
}

require_cmd node
require_cmd npm
require_cmd curl

log "Build frontend"
npm --prefix client run build >/dev/null
echo "PASS: frontend build"

log "Start server (simulated-only profile)"
SOURCES=simulated PORT="$PORT" node server/src/index.js >/tmp/realtime-charts-verify-server.log 2>&1 &
SERVER_PID="$!"

# Wait up to ~8s for health endpoint.
for _ in {1..40}; do
  if curl -fsS "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

curl -fsS "http://localhost:${PORT}/api/health" >/dev/null
echo "PASS: server health endpoint"

log "REST contract checks"
symbols_json="$(curl -fsS "http://localhost:${PORT}/api/symbols")"
echo "$symbols_json" | node -e '
  let d=""; process.stdin.on("data", c => d += c).on("end", () => {
    const x = JSON.parse(d);
    if (!Array.isArray(x.symbols) || x.symbols.length === 0) {
      console.error("FAIL: /api/symbols missing symbols");
      process.exit(1);
    }
    if (!x.symbols[0].source) {
      console.error("FAIL: /api/symbols entries missing source");
      process.exit(1);
    }
    console.log("PASS: /api/symbols schema");
  });
'

sources_json="$(curl -fsS "http://localhost:${PORT}/api/sources")"
echo "$sources_json" | node -e '
  let d=""; process.stdin.on("data", c => d += c).on("end", () => {
    const x = JSON.parse(d);
    if (!Array.isArray(x.sources) || x.sources.length === 0) {
      console.error("FAIL: /api/sources missing sources");
      process.exit(1);
    }
    console.log("PASS: /api/sources schema");
  });
'

first_symbol="$(echo "$symbols_json" | node -e '
  let d=""; process.stdin.on("data", c => d += c).on("end", () => {
    const x = JSON.parse(d);
    const s = x.symbols[0];
    process.stdout.write(`${s.source}|${s.symbol}`);
  });
')"
src="${first_symbol%%|*}"
sym="${first_symbol##*|}"

history_json="$(curl -fsS "http://localhost:${PORT}/api/history?source=${src}&symbol=${sym}&interval=1m&limit=3")"
echo "$history_json" | node -e '
  let d=""; process.stdin.on("data", c => d += c).on("end", () => {
    const x = JSON.parse(d);
    if (!Array.isArray(x.candles) || x.candles.length === 0) {
      console.error("FAIL: /api/history missing candles");
      process.exit(1);
    }
    const c = x.candles[x.candles.length - 1];
    if (typeof c.session !== "string") {
      console.error("FAIL: candle missing session");
      process.exit(1);
    }
    console.log("PASS: /api/history schema + candle session");
  });
'

if curl -fsS "http://localhost:${PORT}/api/history?source=nope&symbol=BAD&interval=1m" >/dev/null 2>&1; then
  echo "FAIL: invalid history query unexpectedly succeeded"
  exit 1
else
  echo "PASS: invalid history query fails cleanly"
fi

log "WebSocket smoke check"
node -e "
const WS = require('./server/node_modules/ws');
const ws = new WS('ws://localhost:${PORT}/ws');
let sawHello = false, sawTick = false, sawCandle = false;
const fail = (msg) => { console.error('FAIL:', msg); process.exit(1); };
ws.on('message', (buf) => {
  const m = JSON.parse(buf.toString());
  if (m.type === 'hello') sawHello = true;
  if (m.type === 'tick' && m.source && m.symbol && m.session) sawTick = true;
  if (m.type === 'candle' && m.candle && m.candle.session) sawCandle = true;
  if (sawHello && sawTick && sawCandle) {
    console.log('PASS: websocket hello/tick/candle contract');
    ws.close();
    process.exit(0);
  }
});
ws.on('error', (e) => fail(e.message));
setTimeout(() => fail('timeout waiting for ws events'), 5000);
"

log "Done"
echo "All automated verification checks passed."
