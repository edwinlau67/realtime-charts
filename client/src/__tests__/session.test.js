import { describe, it, expect } from "vitest";
import {
  sessionForUSEquity,
  liveSessionFor,
  sessionLabel,
  isAlwaysOpenSource,
} from "../session.js";

describe("session helpers", () => {
  it("classifies known ET boundaries", () => {
    expect(sessionForUSEquity(Date.parse("2026-04-30T08:00:00Z"))).toBe("pre");
    expect(sessionForUSEquity(Date.parse("2026-04-30T13:30:00Z"))).toBe("regular");
    expect(sessionForUSEquity(Date.parse("2026-04-30T20:00:00Z"))).toBe("post");
  });

  it("maps always-open sources to always-open live session", () => {
    expect(isAlwaysOpenSource("binance")).toBe(true);
    expect(liveSessionFor("binance")).toBe("always-open");
  });

  it("provides user-facing labels", () => {
    expect(sessionLabel("pre")).toBe("Pre-Market");
    expect(sessionLabel("always-open")).toBe("24/7 Open");
  });
});
