import { CONFIG_FILE_NAME } from "../core/config";
import type { Platform } from "./types";

const noop = (): Promise<void> => Promise.resolve();

/**
 * 浏览器 mock：窗口操作全部是空操作，配置落在 localStorage。
 * 单独跑 npm run dev 调界面时用它，不依赖 Tauri。
 */
export const browserPlatform: Platform = {
  isTauri: false,
  window: {
    minimize: noop,
    toggleMaximize: noop,
    close: noop,
    isMaximized: () => Promise.resolve(false),
    setTitle: noop,
    setTheme: noop,
    onResized: () => () => {},
  },
  configStorage: {
    read: () => window.localStorage.getItem(CONFIG_FILE_NAME),
    write: (text) => {
      window.localStorage.setItem(CONFIG_FILE_NAME, text);
    },
  },
};
