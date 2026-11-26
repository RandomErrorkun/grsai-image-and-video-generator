/** 主窗口的页面（对应 ui/main_window.py 里的五个子界面 + 重写版新增的用量统计与官方公告页）。 */
export type PageKey = "generator" | "video" | "comic" | "history" | "usage" | "announcements" | "settings";

/** 启动时显示的页面，也是返回键退到底时的那一页。 */
export const DEFAULT_PAGE: PageKey = "generator";

/** 所有页面，按创建顺序。 */
export const ALL_PAGES: readonly PageKey[] = [
  "generator",
  "video",
  "comic",
  "history",
  "usage",
  "announcements",
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
  usage: "nav.usage",
  announcements: "nav.announcements",
  settings: "nav.settings",
};

/**
 * 导航栏的显示方式：
 * compact 是默认的 48 像素纯图标栏；
 * menu    是展开成盖在页面上的浮层，点外面或按 Esc 收起。
 */
export type NavMode = "compact" | "menu";

export type ThemeMode = "auto" | "light" | "dark";

export type ResolvedTheme = "light" | "dark";

/** 配置里的 theme 理应是 auto / light / dark 之一；别的值按 auto 处理。 */
export function normalizeThemeMode(value: unknown): ThemeMode {
  return value === "light" || value === "dark" ? value : "auto";
}
