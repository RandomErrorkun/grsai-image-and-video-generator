import { useEffect, useMemo, useState, type ComponentType } from "react";
import { FluentProvider } from "@fluentui/react-components";
import {
  ALL_PAGES,
  DEFAULT_PAGE,
  NAV_MIN_EXPAND_WIDTH,
  type NavMode,
  type PageKey,
  type ResolvedTheme,
} from "./app/navigation";
import { NavigationRail } from "./components/NavigationRail";
import { NoticeHost } from "./components/Notice";
import { TitleBar } from "./components/TitleBar";
import { useAccentColor, useResolvedTheme, useThemeMode } from "./hooks/useAppTheme";
import { useConfigValue } from "./hooks/useConfigValue";
import { useTr } from "./hooks/useLanguage";
import { useWindowWidth } from "./hooks/useWindowWidth";
import { normalizeLanguage, setLanguage } from "./i18n";
import ComicPage from "./pages/ComicPage";
import GeneratorPage from "./pages/GeneratorPage";
import HistoryPage from "./pages/HistoryPage";
import SettingsPage from "./pages/SettingsPage";
import VideoPage from "./pages/VideoPage";
import { platform } from "./platform";
import { runAsync } from "./platform/async";
import { cfg } from "./state/config";
import { themesFor } from "./theme";

/** 当前页面和返回栈；返回栈按顺序记着经过的页面，最后一项是上一页。 */
interface Location {
  page: PageKey;
  backStack: PageKey[];
}

const PAGE_COMPONENTS: Record<PageKey, ComponentType> = {
  generator: GeneratorPage,
  video: VideoPage,
  comic: ComicPage,
  history: HistoryPage,
  settings: SettingsPage,
};

export default function App() {
  const resolvedTheme = useResolvedTheme();
  const accent = useAccentColor();
  const themes = useMemo(() => themesFor(accent), [accent]);
  return (
    <FluentProvider
      className="app-provider"
      theme={resolvedTheme === "dark" ? themes.dark : themes.light}
    >
      <Shell resolvedTheme={resolvedTheme} accent={accent} />
      <NoticeHost />
    </FluentProvider>
  );
}

/** 主窗口外壳：左侧导航、页面容器和标题栏（对应 ui/main_window.py 的窗口部分）。 */
function Shell({ resolvedTheme, accent }: { resolvedTheme: ResolvedTheme; accent: string }) {
  const t = useTr();
  const themeMode = useThemeMode();
  const language = normalizeLanguage(useConfigValue("language", "en"));
  const viewportWidth = useWindowWidth();
  const [location, setLocation] = useState<Location>({ page: DEFAULT_PAGE, backStack: [] });
  const [navMode, setNavMode] = useState<NavMode>("compact");

  const title = t("main.title");

  // 文案表跟着配置里的 language 走
  useEffect(() => {
    setLanguage(language);
  }, [language]);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    // 自绘的那部分界面（导航指示条、焦点框等）跟着主题色走
    document.documentElement.style.setProperty("--accent", accent);
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
    // 源项目只在启动时设一次窗口标题；这里随语言切换即时更新
    document.title = title;
    if (platform.isTauri) runAsync(platform.window.setTitle(title));
  }, [title, resolvedTheme, language, accent]);

  // 让原生窗口（滚动条等部件）的亮暗与界面一致；auto 时交还给系统
  useEffect(() => {
    if (platform.isTauri) {
      runAsync(platform.window.setTheme(themeMode === "auto" ? null : themeMode));
    }
  }, [themeMode]);

  // 窗口变窄时把原地展开的导航收回去（对应原件的 minimumExpandWidth 逻辑）
  useEffect(() => {
    if (navMode === "expanded" && viewportWidth < NAV_MIN_EXPAND_WIDTH) {
      setNavMode("compact");
    }
  }, [navMode, viewportWidth]);

  // 浮层式导航：点到面板外面就收起
  useEffect(() => {
    if (navMode !== "menu") return;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element && event.target.closest(".nav"))) {
        setNavMode("compact");
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [navMode]);

  // 与原件的导航历史一致：换页才入栈，返回键退回上一页，栈空时禁用
  const navigate = (next: PageKey) => {
    setLocation((current) =>
      current.page === next
        ? current
        : { page: next, backStack: [...current.backStack, current.page] },
    );
  };

  const goBack = () => {
    setLocation((current) => {
      if (current.backStack.length === 0) return current;
      const backStack = current.backStack.slice(0, -1);
      return { page: backStack[backStack.length - 1] ?? DEFAULT_PAGE, backStack };
    });
  };

  // 窗口够宽就原地展开，否则展开成盖在页面上的浮层
  const toggleNav = () => {
    setNavMode((mode) =>
      mode === "compact"
        ? viewportWidth >= NAV_MIN_EXPAND_WIDTH
          ? "expanded"
          : "menu"
        : "compact",
    );
  };

  // 与原件一致：在亮暗之间切换；当前看到暗的就切亮，反之切暗
  const toggleTheme = () => {
    cfg.set("theme", resolvedTheme === "dark" ? "light" : "dark");
  };

  return (
    <div className="app">
      <NavigationRail
        page={location.page}
        mode={navMode}
        canGoBack={location.backStack.length > 0}
        onNavigate={navigate}
        onBack={goBack}
        onToggleExpanded={toggleNav}
        onToggleTheme={toggleTheme}
      />
      {/* 五个页面常驻，只隐藏不卸载：切走再切回，输入的内容和跑着的任务都还在 */}
      <main className="content">
        {ALL_PAGES.map((key) => {
          const Page = PAGE_COMPONENTS[key];
          const active = key === location.page;
          return (
            <div
              key={key}
              className={active ? "page-host" : "page-host page-host--hidden"}
              aria-hidden={!active}
            >
              <Page />
            </div>
          );
        })}
      </main>
      <TitleBar title={title} />
    </div>
  );
}
