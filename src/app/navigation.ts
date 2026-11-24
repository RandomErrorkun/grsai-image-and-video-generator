/** 主窗口的页面（对应 ui/main_window.py 里的五个子界面）。 */
export type PageKey = "generator" | "video" | "comic" | "history" | "settings";

/** 启动时显示的页面，也是返回键退到底时的那一页。 */
export const DEFAULT_PAGE: PageKey = "generator";

/** 所有页面，按创建顺序。 */
export const ALL_PAGES: readonly PageKey[] = [
  "generator",
  "video",
  "comic",
  "history",
  "settings",
];

/** 导航栏上半区的页面；设置固定在底部。 */
export const TOP_PAGES: readonly PageKey[] = ALL_PAGES.filter((page) => page !== "settings");

/** 各页面对应的导航文案键。 */
export const NAV_LABEL_KEY: Record<PageKey, string> = {
  generator: "nav.generator",
  video: "nav.video",
  comic: "nav.comic",
  history: "nav.history",
  settings: "nav.settings",
};

/**
 * 导航栏的显示方式：
 * compact  是默认的 48 像素纯图标栏；
 * expanded 是窗口够宽时原地展开，把页面内容往右推；
 * menu     是窗口不够宽时展开成盖在页面上的浮层，点外面收起。
 */
export type NavMode = "compact" | "expanded" | "menu";

/** 窗口宽度达到这个值，导航才能原地展开（对应原件的 minimumExpandWidth + expandWidth - 322）。 */
export const NAV_MIN_EXPAND_WIDTH = 1008;

export type ThemeMode = "auto" | "light" | "dark";

export type ResolvedTheme = "light" | "dark";

/** 配置里的 theme 理应是 auto / light / dark 之一；别的值按 auto 处理。 */
export function normalizeThemeMode(value: unknown): ThemeMode {
  return value === "light" || value === "dark" ? value : "auto";
}
