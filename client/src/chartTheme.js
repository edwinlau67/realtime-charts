/** Layout colors for lightweight-charts to match app light/dark UI. */
export function chartLayoutTheme(mode) {
  if (mode === "light") {
    return {
      textColor: "#334155",
      grid: {
        vertLines: { color: "rgba(148, 163, 184, 0.35)" },
        horzLines: { color: "rgba(148, 163, 184, 0.35)" },
      },
      borderColor: "#cbd5e1",
      zeroLine: "rgba(100, 116, 139, 0.45)",
    };
  }
  return {
    textColor: "#c7cffb",
    grid: {
      vertLines: { color: "rgba(36, 48, 86, 0.5)" },
      horzLines: { color: "rgba(36, 48, 86, 0.5)" },
    },
    borderColor: "#243056",
    zeroLine: "rgba(138, 147, 184, 0.5)",
  };
}
