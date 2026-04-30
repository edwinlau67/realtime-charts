// Technical indicator math. Pure functions over candle arrays so they can be
// memoized and recomputed cheaply on every tick.

// Exponential Moving Average. Seeded with the first `period` SMA so the
// resulting series is well-defined the moment we have `period` samples.
export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;

  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// MACD: returns aligned arrays { macd, signal, hist } indexed against `closes`.
// Standard params are fast=12, slow=26, signal=9.
export function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);

  const macdLine = closes.map((_, i) =>
    fastEma[i] != null && slowEma[i] != null ? fastEma[i] - slowEma[i] : null
  );

  // Compute signal line on the *defined* portion of the MACD line so the EMA
  // seed isn't poisoned by the leading null prefix.
  const firstValid = macdLine.findIndex((v) => v != null);
  const signal = new Array(closes.length).fill(null);
  if (firstValid !== -1) {
    const tail = macdLine.slice(firstValid);
    const sigTail = ema(tail, signalPeriod);
    for (let i = 0; i < sigTail.length; i++) signal[firstValid + i] = sigTail[i];
  }

  const hist = macdLine.map((m, i) =>
    m != null && signal[i] != null ? m - signal[i] : null
  );

  return { macd: macdLine, signal, hist };
}

// Build chart-ready point arrays from candles + macd output.
// Skips leading nulls so lightweight-charts doesn't warn.
export function macdSeriesData(candles, fast = 12, slow = 26, signalPeriod = 9) {
  const closes = candles.map((c) => c.close);
  const { macd: m, signal: s, hist: h } = macd(closes, fast, slow, signalPeriod);

  const macdLine = [];
  const signalLine = [];
  const histBars = [];

  for (let i = 0; i < candles.length; i++) {
    const t = Math.floor(candles[i].time / 1000);
    if (m[i] != null) macdLine.push({ time: t, value: m[i] });
    if (s[i] != null) signalLine.push({ time: t, value: s[i] });
    if (h[i] != null) {
      // Color: rising green / falling red; lighter shade when on opposite side
      // of zero from previous bar to highlight momentum shifts.
      const prev = h[i - 1];
      const rising = prev == null ? h[i] >= 0 : h[i] >= prev;
      const positive = h[i] >= 0;
      const color = positive
        ? rising ? "rgba(34,197,94,0.85)"  : "rgba(34,197,94,0.40)"
        : rising ? "rgba(239,68,68,0.40)"  : "rgba(239,68,68,0.85)";
      histBars.push({ time: t, value: h[i], color });
    }
  }
  return { macdLine, signalLine, histBars };
}

// Trend classification from the latest two MACD samples. Used to drive the
// status badge in the header.
export function macdTrend(candles, fast = 12, slow = 26, signalPeriod = 9) {
  if (candles.length < slow + signalPeriod) {
    return { state: "warming", label: "Warming up", detail: "Need more candles" };
  }
  const closes = candles.map((c) => c.close);
  const { macd: m, signal: s, hist: h } = macd(closes, fast, slow, signalPeriod);
  const i = closes.length - 1;
  const prev = i - 1;

  const mNow = m[i], sNow = s[i], hNow = h[i];
  const mPrev = m[prev], sPrev = s[prev], hPrev = h[prev];
  if (mNow == null || sNow == null) {
    return { state: "warming", label: "Warming up", detail: "Need more candles" };
  }

  const crossedUp   = mPrev != null && sPrev != null && mPrev <= sPrev && mNow > sNow;
  const crossedDown = mPrev != null && sPrev != null && mPrev >= sPrev && mNow < sNow;

  if (crossedUp)   return { state: "cross-up",   label: "Bullish crossover",  detail: "MACD crossed above signal" };
  if (crossedDown) return { state: "cross-down", label: "Bearish crossover",  detail: "MACD crossed below signal" };

  const above = mNow > sNow;
  const strengthening = hPrev != null && Math.abs(hNow) > Math.abs(hPrev);

  if (above && strengthening)  return { state: "bullish-strong", label: "Bullish", detail: "Histogram expanding" };
  if (above && !strengthening) return { state: "bullish-weak",   label: "Bullish (fading)", detail: "Histogram contracting" };
  if (!above && strengthening) return { state: "bearish-strong", label: "Bearish", detail: "Histogram expanding" };
  return                              { state: "bearish-weak",   label: "Bearish (fading)", detail: "Histogram contracting" };
}
