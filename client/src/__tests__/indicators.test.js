import { describe, it, expect } from "vitest";
import { ema, macd, macdTrend } from "../indicators.js";

describe("indicators", () => {
  it("ema converges to constant series value", () => {
    const values = Array.from({ length: 20 }, () => 5);
    const out = ema(values, 5);
    expect(out[out.length - 1]).toBe(5);
  });

  it("macd output arrays align with input length", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i * 0.2);
    const m = macd(closes, 12, 26, 9);
    expect(m.macd.length).toBe(closes.length);
    expect(m.signal.length).toBe(closes.length);
    expect(m.hist.length).toBe(closes.length);
  });

  it("macdTrend returns warming when candles are insufficient", () => {
    const candles = Array.from({ length: 10 }, (_, i) => ({
      time: i * 1000,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1,
    }));
    const t = macdTrend(candles, 12, 26, 9);
    expect(t.state).toBe("warming");
  });
});
