// Mirror of server/src/session.js so the client can derive "what session is
// it right now?" without an extra round-trip. Used to drive the live session
// pill in the header and to label crypto sources distinctly.
const ET_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour12: false,
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
});

export function sessionForUSEquity(timeMs = Date.now()) {
  const parts = ET_FMT.formatToParts(new Date(timeMs));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const wd = get("weekday");
  if (wd === "Sat" || wd === "Sun") return "closed";

  const hour   = parseInt(get("hour"), 10) % 24;
  const minute = parseInt(get("minute"), 10);
  const minutes = hour * 60 + minute;
  if (minutes < 240)  return "closed";
  if (minutes < 570)  return "pre";
  if (minutes < 960)  return "regular";
  if (minutes < 1200) return "post";
  return "closed";
}

// Sources whose market is open 24/7 (crypto + simulated GBM feed).
const ALWAYS_ON = new Set(["binance", "coinbase", "kraken", "simulated"]);

export function isAlwaysOpenSource(sourceId) {
  return ALWAYS_ON.has(sourceId);
}

// Resolve the live session for a given source. Returns one of
// "pre", "regular", "post", "closed", or "always-open".
export function liveSessionFor(sourceId, nowMs = Date.now()) {
  if (isAlwaysOpenSource(sourceId)) return "always-open";
  return sessionForUSEquity(nowMs);
}

export function sessionLabel(session) {
  switch (session) {
    case "pre":         return "Pre-Market";
    case "regular":     return "Market Open";
    case "post":        return "After-Hours";
    case "closed":      return "Market Closed";
    case "always-open": return "24/7 Open";
    default:            return "—";
  }
}

// Returns ms until the next session boundary (used to refresh the badge).
export function msUntilNextBoundary(nowMs = Date.now()) {
  const cur = sessionForUSEquity(nowMs);
  // Probe forward at 1-minute granularity. We won't iterate more than 24*60
  // times (one full day) so this is O(<=1440) once a day.
  for (let m = 1; m <= 24 * 60; m++) {
    const t = nowMs + m * 60_000;
    if (sessionForUSEquity(t) !== cur) return m * 60_000;
  }
  return 60 * 60_000; // fallback: re-check in an hour
}

// Formatted "HH:MM ET" current time, for the market clock.
const CLOCK_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour12: false,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export function formatEtClock(nowMs = Date.now()) {
  return CLOCK_FMT.format(new Date(nowMs)) + " ET";
}
