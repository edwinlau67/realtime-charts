import { EventEmitter } from "node:events";
import { SimulatedSource } from "./simulated.js";
import { BinanceSource }   from "./binance.js";
import { CoinbaseSource }  from "./coinbase.js";
import { KrakenSource }    from "./kraken.js";
import { YahooSource }     from "./yahoo.js";
import { StooqSource }     from "./stooq.js";
import { FinnhubSource }   from "./finnhub.js";

// Builds and orchestrates the configured set of data sources. Resolves symbol
// collisions deterministically: a real feed always wins over the simulator.
// Real sources never collide with each other since each labels its symbols
// with an exchange-specific format (BTC-USDT vs BTC-USD vs BTC/USD-K).
//
// Configuration (env):
//   SOURCES                comma list of any of: simulated, binance, coinbase,
//                          kraken, yahoo, stooq, finnhub. Default: all zero-key
//                          sources except stooq and finnhub (stooq/finnhub are opt-in).
//   TICK_MS                simulator tick cadence (default 250)
//   FINNHUB_API_KEY        required to enable Finnhub
//   BINANCE_PAIRS          comma list, e.g. "btcusdt,ethusdt"
//   COINBASE_PRODUCTS      comma list, e.g. "BTC-USD,ETH-USD"
//   KRAKEN_PAIRS           comma list, e.g. "BTC/USD,ETH/USD"
//   YAHOO_SYMBOLS          comma list, e.g. "AAPL,MSFT,SPY,^GSPC,EURUSD=X"
//   YAHOO_POLL_MS          poll cadence for Yahoo (default 3000)
//   STOOQ_SYMBOLS          comma list of Stooq tickers, e.g. "aapl.us,msft.us"
//   STOOQ_POLL_MS          poll cadence for Stooq (default 5000)
//   FINNHUB_SYMBOLS        comma list, e.g. "AAPL,MSFT"
export class SourceManager extends EventEmitter {
  constructor({
    enabled, tickIntervalMs,
    finnhubApiKey,
    binancePairs, coinbaseProducts, krakenPairs,
    yahooSymbols, yahooPollMs,
    stooqSymbols, stooqPollMs,
    finnhubSymbols,
  }) {
    super();
    this.tickIntervalMs = tickIntervalMs;
    this._sources = [];

    const wanted = new Set(enabled);

    // Real sources first so the simulator can avoid colliding with them.
    if (wanted.has("binance")) {
      const src = new BinanceSource({ pairs: binancePairs });
      this._wire(src);
      this._sources.push(src);
    }
    if (wanted.has("coinbase")) {
      const src = new CoinbaseSource({ products: coinbaseProducts });
      this._wire(src);
      this._sources.push(src);
    }
    if (wanted.has("kraken")) {
      const src = new KrakenSource({ pairs: krakenPairs });
      this._wire(src);
      this._sources.push(src);
    }
    if (wanted.has("yahoo")) {
      const src = new YahooSource({ symbols: yahooSymbols, pollIntervalMs: yahooPollMs });
      this._wire(src);
      this._sources.push(src);
    }
    if (wanted.has("stooq")) {
      const src = new StooqSource({ symbols: stooqSymbols, pollIntervalMs: stooqPollMs });
      this._wire(src);
      this._sources.push(src);
    }
    if (wanted.has("finnhub")) {
      const src = new FinnhubSource({ apiKey: finnhubApiKey, symbols: finnhubSymbols });
      this._wire(src);
      this._sources.push(src);
    }
    if (wanted.has("simulated")) {
      const claimed = new Set();
      for (const s of this._sources) for (const sym of s.getSymbols()) claimed.add(sym.symbol);
      const sim = new SimulatedSource({ tickIntervalMs, excludeSymbols: claimed });
      this._wire(sim);
      this._sources.push(sim);
    }
  }

  _wire(src) {
    src.on("tick",   (t) => this.emit("tick",   t));
    src.on("status", (s) => this.emit("status", { ...s, name: src.name }));
  }

  start() { for (const s of this._sources) s.start(); }
  stop()  { for (const s of this._sources) s.stop();  }

  // Returns the simulated source instance (used for warmup priming).
  getSimulated() { return this._sources.find((s) => s.id === "simulated") || null; }

  describe() {
    return this._sources.map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      detail: s.statusDetail,
      symbols: s.getSymbols().length,
      available: s.isAvailable(),
    }));
  }

  getSymbols() {
    const out = [];
    for (const s of this._sources) out.push(...s.getSymbols());
    return out;
  }
}
