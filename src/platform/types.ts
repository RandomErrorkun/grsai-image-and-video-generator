import type { ConfigStorage } from "../core/config";

export type NativeTheme = "light" | "dark";

/** 应用窗口的原生能力。浏览器 mock 下都是空操作。 */
export interface WindowApi {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  /** 窗口是否处于最大化；mock 下恒为 false。 */
  isMaximized(): Promise<boolean>;
  setTitle(title: string): Promise<void>;
  /**
   * 设置原生窗口主题，影响 WebView 的 prefers-color-scheme 和滚动条等原生部件；
   * 传 null 表示跟随系统。
   */
  setTheme(theme: NativeTheme | null): Promise<void>;
  /** 订阅窗口尺寸变化，返回取消订阅函数。 */
  onResized(listener: () => void): () => void;
}

export interface Platform {
  /** 是否运行在 Tauri 里；false 表示浏览器 mock（单独跑 npm run dev）。 */
  readonly isTauri: boolean;
  readonly window: WindowApi;
  readonly configStorage: ConfigStorage;
}
