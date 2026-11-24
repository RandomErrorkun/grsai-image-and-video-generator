import { useSyncExternalStore } from "react";
import { normalizeThemeMode, type ResolvedTheme } from "../app/navigation";
import { useConfigValue } from "./useConfigValue";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function readSystemTheme(): ResolvedTheme {
  return typeof window !== "undefined" && window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

function subscribeSystemTheme(onChange: () => void): () => void {
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function useSystemTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribeSystemTheme, readSystemTheme, () => "light");
}

/** 配置里的 theme 取值（auto / light / dark）；别的值按 auto。 */
export function useThemeMode() {
  return normalizeThemeMode(useConfigValue("theme", "auto"));
}

/** 实际生效的亮暗：显式设置优先，auto 时跟随系统。 */
export function useResolvedTheme(): ResolvedTheme {
  const mode = useThemeMode();
  const systemTheme = useSystemTheme();
  return mode === "auto" ? systemTheme : mode;
}
