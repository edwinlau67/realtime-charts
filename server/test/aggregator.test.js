import test from "node:test";
import assert from "node:assert/strict";
import { CandleAggregator } from "../src/aggregator.js";

test("aggregator rolls 1s candles and preserves session lock", () => {
  const agg = new CandleAggregator();
  const updates = [];
  const closes = [];
  agg.on("update", (e) => {
    if (e.interval === "1s") updates.push(e);
  });
  agg.on("close", (e) => {
    if (e.interval === "1s") closes.push(e);
  });

  // First second (1000ms bucket): two ticks, session locked to "pre".
  agg.ingest({ source: "yahoo", symbol: "AAPL", time: 1100, price: 100, volume: 5, session: "pre" });
  agg.ingest({ source: "yahoo", symbol: "AAPL", time: 1900, price: 105, volume: 7, session: "pre" });

  // Next second (2000ms bucket): new candle should be opened with "regular".
  agg.ingest({ source: "yahoo", symbol: "AAPL", time: 2100, price: 103, volume: 3, session: "regular" });

  assert.equal(closes.length, 1, "one 1s candle should be finalized");
  assert.equal(closes[0].candle.time, 1000);
  assert.equal(closes[0].candle.open, 100);
  assert.equal(closes[0].candle.high, 105);
  assert.equal(closes[0].candle.low, 100);
  assert.equal(closes[0].candle.close, 105);
  assert.equal(closes[0].candle.volume, 12);
  assert.equal(closes[0].candle.session, "pre");

  const history = agg.history("yahoo", "AAPL", "1s", 10);
  assert.equal(history.length, 2, "history should include finalized + current candle");
  assert.equal(history[0].session, "pre");
  assert.equal(history[1].time, 2000);
  assert.equal(history[1].session, "regular");
  assert.equal(history[1].open, 103);

  assert.ok(updates.length >= 3, "should emit update per tick");
  assert.equal(updates[2].closed, true, "third tick starts new bucket and marks closed");
});

test("aggregator keeps source/symbol isolated", () => {
  const agg = new CandleAggregator();

  agg.ingest({ source: "simulated", symbol: "BTC", time: 1000, price: 10, volume: 1, session: "regular" });
  agg.ingest({ source: "yahoo", symbol: "BTC", time: 1000, price: 20, volume: 2, session: "regular" });

  const sim = agg.history("simulated", "BTC", "1s", 5);
  const yho = agg.history("yahoo", "BTC", "1s", 5);
  assert.equal(sim.length, 1);
  assert.equal(yho.length, 1);
  assert.equal(sim[0].close, 10);
  assert.equal(yho[0].close, 20);
});
