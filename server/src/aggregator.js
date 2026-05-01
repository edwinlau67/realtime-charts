import { EventEmitter } from "node:events";

// Supported candle intervals (in seconds). Cap is 60s (1 minute) per spec.
export const INTERVALS = {
  "1s":  1,
  "5s":  5,
  "15s": 15,
  "1m":  60,
};

export const INTERVAL_KEYS = Object.keys(INTERVALS);

const HISTORY_LIMIT = 600;

function bucketStart(timeMs, intervalSec) {
  const intervalMs = intervalSec * 1000;
  return Math.floor(timeMs / intervalMs) * intervalMs;
}

function newCandle(time, price, session) {
  // The candle's `session` is locked at bucket creation: it reflects the
  // session active when the bucket first received a tick. Subsequent ticks
  // update O/H/L/C/V but never reclassify the bar, so the chart can color
  // historical pre-market / after-hours bars distinctly.
  return { time, open: price, high: price, low: price, close: price, volume: 0, session };
}

const key = (source, symbol) => `${source}::${symbol}`;

// OHLCV aggregator keyed by (source, symbol). Emits:
//   "update" -> { source, symbol, interval, candle, closed }
//   "close"  -> { source, symbol, interval, candle }
export class CandleAggregator extends EventEmitter {
  constructor() {
    super();
    this.store = new Map(); // Map<key, Map<interval, { current, history }>>
  }

  _slot(source, symbol, interval) {
    const k = key(source, symbol);
    let byKey = this.store.get(k);
    if (!byKey) {
      byKey = new Map();
      this.store.set(k, byKey);
    }
    let slot = byKey.get(interval);
    if (!slot) {
      slot = { current: null, history: [] };
      byKey.set(interval, slot);
    }
    return slot;
  }

  ingest(tick) {
    const { source, symbol, time, price, volume, session } = tick;
    if (!source || !symbol || !Number.isFinite(price)) return;

    // Volume is added to a running sum on the current bar; a single NaN or
    // negative value would permanently poison the bar, so coerce defensively.
    // (Some upstream feeds occasionally send non-numeric quantities.)
    const safeVolume = Number.isFinite(volume) && volume > 0 ? volume : 0;
    // Reject ticks with a non-finite timestamp before they index into a
    // bucket — Math.floor(NaN/1000)*1000 = NaN which corrupts the slot.
    const safeTime = Number.isFinite(time) ? time : Date.now();

    for (const interval of INTERVAL_KEYS) {
      const sec = INTERVALS[interval];
      const slot = this._slot(source, symbol, interval);
      const start = bucketStart(safeTime, sec);

      let closed = false;
      if (!slot.current) {
        slot.current = newCandle(start, price, session);
      } else if (start > slot.current.time) {
        const finalized = slot.current;
        slot.history.push(finalized);
        if (slot.history.length > HISTORY_LIMIT) slot.history.shift();
        this.emit("close", { source, symbol, interval, candle: finalized });
        slot.current = newCandle(start, price, session);
        closed = true;
      } else if (start < slot.current.time) {
        // Late tick (clock skew); just blend into current bar without rolling back.
      }

      const c = slot.current;
      if (price > c.high) c.high = price;
      if (price < c.low)  c.low  = price;
      c.close = price;
      c.volume += safeVolume;

      this.emit("update", { source, symbol, interval, candle: { ...c }, closed });
    }
  }

  history(source, symbol, interval, limit = 240) {
    const slot = this._slot(source, symbol, interval);
    const tail = slot.history.slice(-limit);
    return slot.current ? [...tail, { ...slot.current }] : tail;
  }
}
