import { browserPlatform } from "./browser";
import { tauriPlatform } from "./tauri";
import type { Platform } from "./types";

function detectTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 当前运行环境的能力集合：Tauri 里是真的，浏览器里是 mock。 */
export const platform: Platform = detectTauri() ? tauriPlatform : browserPlatform;

export type { FileSystemApi, HttpApi, NativeTheme, Platform, WindowApi } from "./types";
