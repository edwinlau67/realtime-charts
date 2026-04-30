import { Source } from "./base.js";
import { SYMBOLS } from "../symbols.js";
import { SESSION_ALWAYS_OPEN } from "../session.js";

// Box-Muller standard normal sample.
function randn() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const SECONDS_PER_YEAR = 252 * 6.5 * 3600;

// Per-symbol Geometric Brownian Motion driven simulator. Always available
// (no external dependencies) so it's the safe fallback when real feeds are
// unreachable or unconfigured.
export class SimulatedSource extends Source {
  constructor({ tickIntervalMs = 250, excludeSymbols = new Set() } = {}) {
    super({ id: "simulated", name: "Simulated (GBM)" });
    this.tickIntervalMs = tickIntervalMs;
    this.excludeSymbols = excludeSymbols;
    this.state = new Map();
    for (const s of SYMBOLS) {
      if (excludeSymbols.has(s.symbol)) continue;
      this.state.set(s.symbol, { ...s, lastPrice: s.price });
    }
    this._timer = null;
  }

  isAvailable() { return this.state.size > 0; }

  getSymbols() {
    return [...this.state.values()].map((s) => ({
      symbol: s.symbol,
      name: s.name,
      source: this.id,
    }));
  }

  start() {
    if (this._timer) return;
    this.setStatus("live", `${this.state.size} simulated symbols`);
    this._timer = setInterval(() => this._tick(), this.tickIntervalMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this.setStatus("idle", "");
  }

  // Used by index.js to prime history at startup.
  _tick() {
    const now = Date.now();
    const dt = this.tickIntervalMs / 1000 / SECONDS_PER_YEAR;

    for (const s of this.state.values()) {
      const z = randn();
      const driftTerm = (s.drift - 0.5 * s.vol * s.vol) * dt;
      const diffusion = s.vol * Math.sqrt(dt) * z;
      const next = s.lastPrice * Math.exp(driftTerm + diffusion);
      const lambda = s.vps * (this.tickIntervalMs / 1000);
      const volume = Math.max(1, Math.round(lambda * (0.5 + Math.random())));
      s.lastPrice = next;

      this.emit("tick", {
        source: this.id,
        symbol: s.symbol,
        time: now,
        price: round(next, next > 100 ? 2 : 4),
        volume,
        session: SESSION_ALWAYS_OPEN,
      });
    }
  }
}

function round(n, digits) {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}
