// Session classification for US equities. DST-correct via Intl.DateTimeFormat
// against the America/New_York zone. Does NOT account for US market holidays
// (so e.g. Thanksgiving is reported as "regular" if you check at 11am ET).
//
// Returned values:
//   "pre"     04:00 – 09:30 ET   (pre-market)
//   "regular" 09:30 – 16:00 ET   (regular trading hours)
//   "post"    16:00 – 20:00 ET   (after-hours)
//   "closed"  outside the above, or any Saturday/Sunday
//
// Crypto / FX / synthetic markets are always "regular" — see SESSION_ALWAYS_OPEN.
const ET_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour12: false,
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
});

export function sessionForUSEquity(timeMs) {
  const parts = ET_FMT.formatToParts(new Date(timeMs ?? Date.now()));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const wd = get("weekday");
  if (wd === "Sat" || wd === "Sun") return "closed";

  // Intl returns "24" at midnight in some locales; fold that down to 0.
  const hour   = parseInt(get("hour"), 10) % 24;
  const minute = parseInt(get("minute"), 10);
  const minutes = hour * 60 + minute;

  if (minutes < 240)  return "closed";  // < 04:00
  if (minutes < 570)  return "pre";     // < 09:30
  if (minutes < 960)  return "regular"; // < 16:00
  if (minutes < 1200) return "post";    // < 20:00
  return "closed";
}

export const SESSION_ALWAYS_OPEN = "regular";
