import { useEffect, useRef } from "react";
import { createChart, LineStyle } from "lightweight-charts";

// Renders the MACD line, signal line, histogram, and a zero baseline.
// Accepts an optional `syncRef` that the parent uses to bridge timeScales so
// panning/zooming the price chart pans the MACD panel and vice versa.
export default function MacdChart({ data, onReady, syncRef }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const macdRef = useRef(null);
  const signalRef = useRef(null);
  const histRef = useRef(null);

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
    });

    const histSeries = chart.addHistogramSeries({
      priceFormat: { type: "price", precision: 4, minMove: 0.0001 },
      base: 0,
    });
    const macdSeries = chart.addLineSeries({
      color: "#60a5fa",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    const signalSeries = chart.addLineSeries({
      color: "#f59e0b",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });

    // Zero baseline.
    macdSeries.createPriceLine({
      price: 0,
      color: "rgba(138, 147, 184, 0.5)",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: false,
    });

    chartRef.current = chart;
    macdRef.current = macdSeries;
    signalRef.current = signalSeries;
    histRef.current = histSeries;

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
      setData: ({ macdLine, signalLine, histBars }) => {
        histSeries.setData(histBars);
        macdSeries.setData(macdLine);
        signalSeries.setData(signalLine);
      },
      update: ({ macdPoint, signalPoint, histPoint }) => {
        if (histPoint)   histSeries.update(histPoint);
        if (macdPoint)   macdSeries.update(macdPoint);
        if (signalPoint) signalSeries.update(signalPoint);
      },
    });

    return () => {
      if (syncRef) syncRef.current = null;
      chart.remove();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Bulk update when the parent recomputes from new candles array.
  useEffect(() => {
    if (!data || !macdRef.current) return;
    histRef.current.setData(data.histBars);
    macdRef.current.setData(data.macdLine);
    signalRef.current.setData(data.signalLine);
  }, [data]);

  return <div ref={containerRef} className="chart" />;
}
