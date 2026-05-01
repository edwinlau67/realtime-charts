import { useEffect, useMemo, useRef, useState } from "react";
import Chart from "./Chart.jsx";
import MacdChart from "./MacdChart.jsx";
import SourceChip from "./components/SourceChip.jsx";
import { useAppearance } from "./useAppearance.js";
import { useMarketSocket } from "./useMarketSocket.js";
import { macdSeriesData, macdTrend } from "./indicators.js";
import { liveSessionFor, sessionLabel, formatEtClock, msUntilNextBoundary } from "./session.js";

const _loc = globalThis.location;
const WS_URL = _loc
  ? `${_loc.protocol === "https:" ? "wss" : "ws"}://${_loc.host}/ws`
  : "ws://localhost:4000/ws";

const INTERVALS = [
  { key: "1s",  label: "1s"  },
  { key: "5s",  label: "5s"  },
  { key: "15s", label: "15s" },
  { key: "1m",  label: "1m"  },
];

const DEFAULT_MACD = { fast: 12, slow: 26, signal: 9 };

const SOURCE_META = {
  simulated: { label: "Sim",      color: "#6366f1", title: "Simulated GBM feed" },
  binance:   { label: "Binance",  color: "#f0b90b", title: "Binance public live trade stream" },
  coinbase:  { label: "Coinbase", color: "#0052ff", title: "Coinbase Exchange public live trade stream" },
  kraken:    { label: "Kraken",   color: "#a78bfa", title: "Kraken v2 public live trade stream" },
  yahoo:     { label: "Yahoo",    color: "#7e22ce", title: "Yahoo Finance free polling (stocks/ETFs/indices)" },
  stooq:     { label: "Stooq",    color: "#10b981", title: "Stooq free CSV polling (stocks; ~15min delayed)" },
  finnhub:   { label: "Finnhub",  color: "#22d3ee", title: "Finnhub live US equities feed" },
};

const symKey = (a) => (a ? `${a.source}:${a.symbol}` : "");

const APPEARANCE_OPTIONS = [
  { key: "system", label: "Auto" },
  { key: "light", label: "Light" },
  { key: "dark", label: "Dark" },
];

export default function App() {
  const { appearance, setAppearance, resolvedTheme } = useAppearance();
  const { status, hello, subscribe } = useMarketSocket(WS_URL);

  const [symbols, setSymbols] = useState([]);
  const [sources, setSources] = useState([]);
  const [active, setActive] = useState(null);              // { source, symbol }
  // NOTE: do not name this setter `setInterval` — it would shadow the global
  // `window.setInterval` and the clock effect below would silently set state
  // to `undefined` instead of starting a timer.
  const [interval, setIntervalKey] = useState("1s");
  const [candles, setCandles] = useState([]);
  const [tickers, setTickers] = useState({});             // keyed by `${source}:${symbol}`
  const [filterSource, setFilterSource] = useState("all"); // "all" | source id

  const [showMacd, setShowMacd] = useState(true);
  const [macdParams, setMacdParams] = useState(DEFAULT_MACD);

  const [now, setNow] = useState(Date.now());

  const chartApiRef = useRef(null);
  const macdApiRef = useRef(null);
  const priceSyncRef = useRef(null);
  const macdSyncRef = useRef(null);
  const flashRef = useRef({});

  // Live market clock (1Hz) — drives both the ET clock display and the
  // session pill which auto-flips at session boundaries.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Bootstrap from REST.
  useEffect(() => {
    fetch("/api/symbols")
      .then((r) => r.json())
      .then((data) => {
        setSymbols(data.symbols || []);
        setSources(data.sources || []);
        if (!active && data.symbols?.length) {
          setActive({ source: data.symbols[0].source, symbol: data.symbols[0].symbol });
        }
      })
      .catch(() => {});
  }, []); // eslint-disable-line

  // Hello fallback.
  useEffect(() => {
    if (!hello) return;
    if (hello.symbols && symbols.length === 0) setSymbols(hello.symbols);
    if (hello.sources && sources.length === 0) setSources(hello.sources);
    if (!active && hello.symbols?.length) {
      setActive({ source: hello.symbols[0].source, symbol: hello.symbols[0].symbol });
    }
  }, [hello]); // eslint-disable-line

  // Live source-status updates so the sidebar reflects connection state.
  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type === "source-status") {
        setSources((prev) => prev.map((s) => s.id === msg.id ? { ...s, status: msg.status, detail: msg.detail } : s));
      }
    });
  }, [subscribe]);

  // History fetch on (source, symbol, interval) change.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const url = `/api/history?source=${encodeURIComponent(active.source)}&symbol=${encodeURIComponent(active.symbol)}&interval=${interval}&limit=240`;
    fetch(url)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setCandles(data.candles || []);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [active?.source, active?.symbol, interval]);

  // Stream handler.
  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type === "tick") {
        const k = `${msg.source}:${msg.symbol}`;
        setTickers((prev) => {
          const old = prev[k];
          const dir = old ? (msg.price > old.price ? "up" : msg.price < old.price ? "down" : old.dir) : "flat";
          return { ...prev, [k]: { price: msg.price, dir, time: msg.time } };
        });
        flashRef.current[k] = Date.now();
      } else if (msg.type === "candle") {
        if (!active) return;
        if (msg.source !== active.source || msg.symbol !== active.symbol || msg.interval !== interval) return;
        chartApiRef.current?.update(msg.candle);
        setCandles((prev) => {
          if (!prev.length) return [msg.candle];
          const last = prev[prev.length - 1];
          if (msg.candle.time === last.time) {
            const next = prev.slice(0, -1);
            next.push(msg.candle);
            return next;
          }
          if (msg.candle.time > last.time) {
            const next = prev.slice(-239);
            next.push(msg.candle);
            return next;
          }
          return prev;
        });
      }
    });
  }, [subscribe, active?.source, active?.symbol, interval]);

  // Two-way time-scale sync.
  useEffect(() => {
    if (!showMacd) return;
    let lock = false;
    let unsubA, unsubB;
    const handle = setTimeout(() => {
      const a = priceSyncRef.current;
      const b = macdSyncRef.current;
      if (!a || !b) return;
      const handler = (from, to) => (range) => {
        if (lock || !range) return;
        lock = true;
        try { to.applyRange(range); } finally { lock = false; }
      };
      const fa = handler(a, b);
      const fb = handler(b, a);
      a.timeScale.subscribeVisibleLogicalRangeChange(fa);
      b.timeScale.subscribeVisibleLogicalRangeChange(fb);
      unsubA = () => a.timeScale.unsubscribeVisibleLogicalRangeChange(fa);
      unsubB = () => b.timeScale.unsubscribeVisibleLogicalRangeChange(fb);
    }, 50);
    return () => {
      clearTimeout(handle);
      unsubA?.();
      unsubB?.();
    };
  }, [showMacd, active?.source, active?.symbol, interval]);

  const visibleSymbols = useMemo(
    () => filterSource === "all" ? symbols : symbols.filter((s) => s.source === filterSource),
    [symbols, filterSource]
  );

  const activeMeta = useMemo(
    () => active ? symbols.find((s) => s.symbol === active.symbol && s.source === active.source) : null,
    [symbols, active]
  );

  const stats = useMemo(() => deriveStats(candles), [candles]);
  const macdData = useMemo(
    () => showMacd ? macdSeriesData(candles, macdParams.fast, macdParams.slow, macdParams.signal) : null,
    [candles, showMacd, macdParams]
  );
  const trend = useMemo(
    () => showMacd ? macdTrend(candles, macdParams.fast, macdParams.slow, macdParams.signal) : null,
    [candles, showMacd, macdParams]
  );

  const liveSession = active ? liveSessionFor(active.source, now) : null;

  const livePrice = (active && tickers[symKey(active)]?.price) ?? stats.close;
  const change = livePrice != null && stats.sessionOpen != null ? livePrice - stats.sessionOpen : 0;
  const changePct = stats.sessionOpen ? (change / stats.sessionOpen) * 100 : 0;
  const changeDir = change >= 0 ? "up" : "down";

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <span className="dot" />
          <span>Realtime Stock Charts</span>
        </div>
        <div className="spacer" />
        <div className="appearance-switch" title="Match system, or force light or dark">
          <div className="seg" role="group" aria-label="Appearance: Auto uses system setting">
            {APPEARANCE_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                type="button"
                className={appearance === opt.key ? "active" : ""}
                onClick={() => setAppearance(opt.key)}
                title={opt.key === "system" ? "Use system light/dark setting" : `Use ${opt.label.toLowerCase()} theme`}
              >
                {opt.key === "system" ? "Auto" : opt.label}
              </button>
            ))}
          </div>
        </div>
        <div className="status">
          <span className={`pill ${status === "open" ? "ok" : "warn"}`}>
            {status === "open" ? "LIVE" : status.toUpperCase()}
          </span>
          <span className="market-clock" title="New York time">
            {formatEtClock(now)}
          </span>
          {hello && <span>· {symbols.length} symbols</span>}
        </div>
      </div>

      <div className="layout">
        <aside className="sidebar">
          <h3>Data Sources</h3>
          <div className="source-filter">
            <SourceChip
              id="all"
              all
              label="All"
              count={symbols.length}
              active={filterSource === "all"}
              onClick={() => setFilterSource("all")}
            />
            {sources.map((s) => {
              const meta = SOURCE_META[s.id] || { label: s.id, color: "#888", title: s.name };
              return (
                <SourceChip
                  key={s.id}
                  id={s.id}
                  label={meta.label}
                  count={s.symbols}
                  color={meta.color}
                  status={s.status}
                  title={`${s.name} · ${s.status}${s.detail ? " · " + s.detail : ""}`}
                  active={filterSource === s.id}
                  onClick={() => setFilterSource(s.id)}
                />
              );
            })}
          </div>

          <h3>Watchlist</h3>
          <div className="sym-list">
            {visibleSymbols.length === 0 && (
              <div className="empty">No symbols for this source.</div>
            )}
            {visibleSymbols.map((s) => {
              const k = `${s.source}:${s.symbol}`;
              const t = tickers[k];
              const price = t?.price;
              const isActive = active && active.source === s.source && active.symbol === s.symbol;
              const flashKey = flashRef.current[k];
              const flashClass =
                flashKey && Date.now() - flashKey < 600
                  ? t?.dir === "up" ? "flash-up" : t?.dir === "down" ? "flash-down" : ""
                  : "";
              const meta = SOURCE_META[s.source] || { label: s.source, color: "#888" };
              return (
                <div
                  key={k}
                  className={`sym-row ${isActive ? "active" : ""} ${flashClass}`}
                  onClick={() => setActive({ source: s.source, symbol: s.symbol })}
                >
                  <div className="sym">
                    {s.symbol}
                    <span className="src-badge" style={{ "--src-color": meta.color }} title={meta.title || meta.label}>
                      {meta.label}
                    </span>
                  </div>
                  <div className="price">{price != null ? formatPrice(price) : "—"}</div>
                  <div className="name">{s.name}</div>
                  <div className={`chg ${t?.dir === "up" ? "up" : t?.dir === "down" ? "down" : ""}`}>
                    {t?.dir === "up" ? "▲" : t?.dir === "down" ? "▼" : ""}
                  </div>
                </div>
              );
            })}
          </div>

          <h3>Indicators</h3>
          <div className="indicator-panel">
            <label className="toggle">
              <input
                type="checkbox"
                checked={showMacd}
                onChange={(e) => setShowMacd(e.target.checked)}
              />
              <span>MACD</span>
            </label>
            <div className={`macd-params ${showMacd ? "" : "disabled"}`}>
              <NumField label="Fast"   value={macdParams.fast}   min={2} max={50}
                onChange={(v) => setMacdParams((p) => ({ ...p, fast: v }))} />
              <NumField label="Slow"   value={macdParams.slow}   min={3} max={100}
                onChange={(v) => setMacdParams((p) => ({ ...p, slow: v }))} />
              <NumField label="Signal" value={macdParams.signal} min={2} max={50}
                onChange={(v) => setMacdParams((p) => ({ ...p, signal: v }))} />
            </div>
            <button
              className="reset-btn"
              onClick={() => setMacdParams(DEFAULT_MACD)}
              disabled={!showMacd}
            >
              Reset 12/26/9
            </button>
          </div>
        </aside>

        <main className="main">
          <div className="header">
            <div className="title">
              <h1>
                {active?.symbol || "—"}
                {activeMeta && (
                  <span style={{ color: "var(--muted)", fontWeight: 400, fontSize: 14 }}>
                    {" · "}{activeMeta.name}
                  </span>
                )}
                {active && SOURCE_META[active.source] && (
                  <span
                    className="src-badge header-badge"
                    style={{ "--src-color": SOURCE_META[active.source].color }}
                  >
                    {SOURCE_META[active.source].label}
                  </span>
                )}
                {liveSession && (
                  <span className={`session-pill session-${liveSession}`}>
                    <span className="session-dot" />
                    {sessionLabel(liveSession)}
                  </span>
                )}
              </h1>
              <p>
                {active?.source === "simulated"
                  ? "Synthetic GBM feed · OHLCV up to 1-minute resolution"
                  : "Live trade stream · OHLCV up to 1-minute resolution · pre/post-market included"}
              </p>
            </div>

            <div className="price-block">
              <div className="price">{livePrice != null ? formatPrice(livePrice) : "—"}</div>
              <div className={`change ${changeDir}`}>
                {change >= 0 ? "+" : ""}{change.toFixed(2)} ({changePct >= 0 ? "+" : ""}{changePct.toFixed(2)}%)
              </div>
            </div>

            {trend && <TrendBadge trend={trend} />}

            <div className="spacer" />

            <div className="intervals">
              {INTERVALS.map((iv) => (
                <button
                  key={iv.key}
                  className={iv.key === interval ? "active" : ""}
                  onClick={() => setIntervalKey(iv.key)}
                >
                  {iv.label}
                </button>
              ))}
            </div>
          </div>

          <div className={`charts-grid ${showMacd ? "with-macd" : ""}`}>
            <div className="chart-wrap">
              <div className="session-legend">
                <span><i className="sl-bar sl-regular" /> Regular</span>
                <span><i className="sl-bar sl-pre"     /> Pre-Market</span>
                <span><i className="sl-bar sl-post"    /> After-Hours</span>
              </div>
              <Chart
                candles={candles}
                resolvedTheme={resolvedTheme}
                onReady={(api) => (chartApiRef.current = api)}
                syncRef={priceSyncRef}
              />
            </div>
            {showMacd && (
              <div className="chart-wrap macd-wrap">
                <div className="panel-label">
                  MACD ({macdParams.fast}, {macdParams.slow}, {macdParams.signal})
                  <span className="legend">
                    <i className="dot-blue"   /> MACD
                    <i className="dot-orange" /> Signal
                    <i className="dot-bar"    /> Histogram
                  </span>
                </div>
                <MacdChart
                  data={macdData}
                  resolvedTheme={resolvedTheme}
                  onReady={(api) => (macdApiRef.current = api)}
                  syncRef={macdSyncRef}
                />
              </div>
            )}
          </div>

          <div className="stats">
            <Stat label="Open"    value={fmt(stats.open)} />
            <Stat label="High"    value={fmt(stats.high)} />
            <Stat label="Low"     value={fmt(stats.low)}  />
            <Stat label="Close"   value={fmt(stats.close)} />
            <Stat label="Volume"  value={fmtVol(stats.volume)} />
            <Stat label="Candles" value={String(candles.length)} />
          </div>
        </main>
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="val">{value}</div>
    </div>
  );
}

function NumField({ label, value, min, max, onChange }) {
  return (
    <label className="num-field">
      <span>{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v) && v >= min && v <= max) onChange(v);
        }}
      />
    </label>
  );
}

function TrendBadge({ trend }) {
  return (
    <div className={`trend trend-${trend.state}`} title={trend.detail}>
      <span className="trend-icon">{iconFor(trend.state)}</span>
      <div className="trend-text">
        <div className="trend-label">{trend.label}</div>
        <div className="trend-detail">{trend.detail}</div>
      </div>
    </div>
  );
}

function iconFor(state) {
  switch (state) {
    case "cross-up":       return "⤴";
    case "cross-down":     return "⤵";
    case "bullish-strong": return "▲";
    case "bullish-weak":   return "△";
    case "bearish-strong": return "▼";
    case "bearish-weak":   return "▽";
    default:               return "…";
  }
}

function deriveStats(candles) {
  if (!candles.length) return { open: null, high: null, low: null, close: null, volume: 0, sessionOpen: null };
  const last = candles[candles.length - 1];
  let high = -Infinity, low = Infinity, volume = 0;
  for (const c of candles) {
    if (c.high > high) high = c.high;
    if (c.low  < low)  low  = c.low;
    volume += c.volume;
  }
  return {
    open: last.open,
    high,
    low,
    close: last.close,
    volume,
    sessionOpen: candles[0].open,
  };
}

function formatPrice(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return n.toFixed(2);
}

function fmt(n) { return n == null ? "—" : formatPrice(n); }

function fmtVol(n) {
  if (n == null) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return String(n);
}
