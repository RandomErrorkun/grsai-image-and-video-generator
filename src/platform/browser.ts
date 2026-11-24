import { CONFIG_FILE_NAME } from "../core/config";
import { createPathTools } from "../core/paths";
import { createMemoryFs } from "./memoryFs";
import type { Platform } from "./types";

const DATA_DIR = "C:\\mock-data";
const paths = createPathTools("\\");
const noop = (): Promise<void> => Promise.resolve();

/** 浏览器 mock 里还没有的能力：点到就报错，提醒这是 mock 环境。 */
const unavailable = (capability: string) => (): Promise<never> =>
  Promise.reject(new Error(`${capability} is not available in the browser mock`));

/**
 * 浏览器 mock：窗口操作是空操作，配置落在 localStorage，文件在内存里。
 * 单独跑 npm run dev 调界面时用它，不依赖 Tauri。
 */
export const browserPlatform: Platform = {
  isTauri: false,
  init: noop,
  get dataDir() {
    return DATA_DIR;
  },
  paths,
  window: {
    minimize: noop,
    toggleMaximize: noop,
    close: noop,
    isMaximized: () => Promise.resolve(false),
    setTitle: noop,
    setTheme: noop,
    onResized: () => () => {},
  },
  fs: createMemoryFs(paths, DATA_DIR),
  http: {
    request: unavailable("HTTP"),
    download: unavailable("HTTP"),
  },
  configStorage: {
    read: () => window.localStorage.getItem(CONFIG_FILE_NAME),
    write: (text) => {
      window.localStorage.setItem(CONFIG_FILE_NAME, text);
    },
  },
  openDatabase: unavailable("SQLite"),
};
