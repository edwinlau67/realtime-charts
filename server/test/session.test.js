import test from "node:test";
import assert from "node:assert/strict";
import { sessionForUSEquity } from "../src/session.js";

test("session boundaries are classified correctly in ET", () => {
  const cases = [
    ["2026-04-30T07:59:00Z", "closed"],   // 03:59 ET
    ["2026-04-30T08:00:00Z", "pre"],      // 04:00 ET
    ["2026-04-30T13:29:00Z", "pre"],      // 09:29 ET
    ["2026-04-30T13:30:00Z", "regular"],  // 09:30 ET
    ["2026-04-30T19:59:00Z", "regular"],  // 15:59 ET
    ["2026-04-30T20:00:00Z", "post"],     // 16:00 ET
    ["2026-04-30T23:59:00Z", "post"],     // 19:59 ET
    ["2026-05-01T00:00:00Z", "closed"],   // 20:00 ET
  ];

  for (const [iso, expected] of cases) {
    assert.equal(sessionForUSEquity(Date.parse(iso)), expected, iso);
  }
});

test("weekends are always closed", () => {
  // Saturday and Sunday noon ET during DST.
  assert.equal(sessionForUSEquity(Date.parse("2026-05-02T16:00:00Z")), "closed");
  assert.equal(sessionForUSEquity(Date.parse("2026-05-03T16:00:00Z")), "closed");
});
