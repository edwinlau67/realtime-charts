import { useCallback, useEffect, useLayoutEffect, useState } from "react";

export const APPEARANCE_STORAGE_KEY = "realtime-charts-appearance";

/** @typedef {"system" | "light" | "dark"} Appearance */

function readStored() {
  try {
    const v = localStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* ignore */
  }
  return "system";
}

function systemPrefersDark() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** @param {Appearance} appearance */
function resolveTheme(appearance, systemDark) {
  if (appearance === "system") return systemDark ? "dark" : "light";
  return appearance;
}

/**
 * Appearance preference: system | light | dark.
 * Persists to localStorage; applies `data-theme` on `<html>` for CSS.
 */
export function useAppearance() {
  const [appearance, setAppearanceState] = useState(readStored);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  const resolvedTheme = resolveTheme(appearance, systemDark);

  useLayoutEffect(() => {
    document.documentElement.setAttribute("data-theme", resolvedTheme);
    document.documentElement.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const setAppearance = useCallback((next) => {
    try {
      localStorage.setItem(APPEARANCE_STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
    setAppearanceState(next);
  }, []);

  return { appearance, setAppearance, resolvedTheme };
}
