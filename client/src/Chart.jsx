import { useEffect, useRef } from "react";
import { createChart, CrosshairMode } from "lightweight-charts";

// Renders an OHLCV candlestick + volume chart and exposes imperative
// `setData` / `update` via a ref pattern through the parent. Optionally
// publishes its timeScale to `syncRef` so a sibling chart can mirror panning.
export default function Chart({ candles, onReady, syncRef }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const candleSeriesRef = useRef(null);
  const volumeSeriesRef = useRef(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: "#c7cffb",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
      },
      grid: {
        vertLines: { color: "rgba(36, 48, 86, 0.5)" },
        horzLines: { color: "rgba(36, 48, 86, 0.5)" },
      },
      rightPriceScale: { borderColor: "#243056" },
      timeScale: {
        borderColor: "#243056",
        timeVisible: true,
        secondsVisible: true,
      },
      crosshair: { mode: CrosshairMode.Normal },
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor:        "#22c55e",
      downColor:      "#ef4444",
      borderUpColor:  "#22c55e",
      borderDownColor:"#ef4444",
      wickUpColor:    "#22c55e",
      wickDownColor:  "#ef4444",
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });

    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      color: "#6366f1",
    });
    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    if (syncRef) {
      syncRef.current = {
        timeScale: chart.timeScale(),
        applyRange: (range) => {
          if (!range) return;
          chart.timeScale().setVisibleLogicalRange(range);
        },
      };
    }

    onReady?.({
      setData: (rows) => {
        candleSeries.setData(rows.map(toCandle));
        volumeSeries.setData(rows.map(toVolume));
        chart.timeScale().fitContent();
      },
      update: (row) => {
        candleSeries.update(toCandle(row));
        volumeSeries.update(toVolume(row));
      },
    });

    return () => {
      if (syncRef) syncRef.current = null;
      chart.remove();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // First-load (or symbol/interval change) bulk data.
  useEffect(() => {
    if (!candleSeriesRef.current || !candles) return;
    candleSeriesRef.current.setData(candles.map(toCandle));
    volumeSeriesRef.current.setData(candles.map(toVolume));
    chartRef.current.timeScale().fitContent();
  }, [candles]);

  return <div ref={containerRef} className="chart" />;
}

// Per-bar color overrides keyed by session. Pre/post bars get muted bodies
// plus an accent border (amber for pre-market, purple for after-hours) so
// extended-hours activity is visually distinct from regular trading.
const SESSION_PALETTE = {
  regular: {
    up: "#22c55e", down: "#ef4444",
    border: { up: "#22c55e", down: "#ef4444" },
    wick:   { up: "#22c55e", down: "#ef4444" },
    volUp: "rgba(34,197,94,0.55)", volDown: "rgba(239,68,68,0.55)",
  },
  pre: {
    up: "rgba(34,197,94,0.55)", down: "rgba(239,68,68,0.55)",
    border: { up: "#f59e0b", down: "#f59e0b" },
    wick:   { up: "#f59e0b", down: "#f59e0b" },
    volUp: "rgba(245,158,11,0.55)", volDown: "rgba(245,158,11,0.55)",
  },
  post: {
    up: "rgba(34,197,94,0.55)", down: "rgba(239,68,68,0.55)",
    border: { up: "#a855f7", down: "#a855f7" },
    wick:   { up: "#a855f7", down: "#a855f7" },
    volUp: "rgba(168,85,247,0.55)", volDown: "rgba(168,85,247,0.55)",
  },
  closed: {
    up: "rgba(148,163,184,0.45)", down: "rgba(148,163,184,0.45)",
    border: { up: "#64748b", down: "#64748b" },
    wick:   { up: "#64748b", down: "#64748b" },
    volUp: "rgba(100,116,139,0.45)", volDown: "rgba(100,116,139,0.45)",
  },
};

function paletteFor(session) {
  return SESSION_PALETTE[session] || SESSION_PALETTE.regular;
}

function toCandle(c) {
  const p  = paletteFor(c.session);
  const up = c.close >= c.open;
  return {
    time: Math.floor(c.time / 1000),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    color:       up ? p.up : p.down,
    borderColor: up ? p.border.up : p.border.down,
    wickColor:   up ? p.wick.up   : p.wick.down,
  };
}

function toVolume(c) {
  const p  = paletteFor(c.session);
  const up = c.close >= c.open;
  return {
    time: Math.floor(c.time / 1000),
    value: c.volume,
    color: up ? p.volUp : p.volDown,
  };
}
