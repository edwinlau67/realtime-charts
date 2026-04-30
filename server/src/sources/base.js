import { EventEmitter } from "node:events";

// Common interface for any tick feed. Subclasses MUST emit "tick" events
// shaped like:
//   { source: "<id>", symbol, time, price, volume }
//
// Lifecycle:
//   start() -> begin emitting (idempotent)
//   stop()  -> stop emitting and release resources
//
// Status reflects connection health for UI display.
export class Source extends EventEmitter {
  constructor({ id, name }) {
    super();
    this.id = id;
    this.name = name;
    this.status = "idle"; // idle | connecting | live | error | disabled
    this.statusDetail = "";
  }

  setStatus(status, detail = "") {
    this.status = status;
    this.statusDetail = detail;
    this.emit("status", { id: this.id, status, detail });
  }

  // eslint-disable-next-line no-unused-vars
  start() { throw new Error("start() must be implemented"); }
  stop()  { /* optional override */ }
  getSymbols() { return []; }
  isAvailable() { return true; }
}
