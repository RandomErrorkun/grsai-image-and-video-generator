import { Suspense, lazy, useEffect, useState, type ComponentType } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
} from "@fluentui/react-components";
import {
  ALL_PAGES,
  DEFAULT_PAGE,
  type NavMode,
  type PageKey,
} from "./app/navigation";
import { AppProvider } from "./components/AppProvider";
import { NavigationRail } from "./components/NavigationRail";
import { TitleBar } from "./components/TitleBar";
import { useResolvedTheme, useThemeMode } from "./hooks/useAppTheme";
import { useConfigValue } from "./hooks/useConfigValue";
import { useTr } from "./hooks/useLanguage";
import { normalizeLanguage, setLanguage } from "./i18n";
import AnnouncementsPage from "./pages/AnnouncementsPage";
import ComicPage from "./pages/ComicPage";
import GeneratorPage from "./pages/GeneratorPage";
import HistoryPage from "./pages/HistoryPage";
import SettingsPage from "./pages/SettingsPage";
import UsagePage from "./pages/UsagePage";
import VideoPage from "./pages/VideoPage";
import { platform } from "./platform";
import { runAsync } from "./platform/async";
import { syncGrsaiSiteData } from "./state/announcements";
import { cfg } from "./state/config";
import { subscribePoseTransfer } from "./state/poseTransfer";
import { subscribeRestore } from "./state/restore";
import { hasUnfinishedTasks, stopAllTasks } from "./state/taskLists";

const PosePage = lazy(() => import("./pages/PosePage"));

/** 当前页面和返回栈；返回栈按顺序记着经过的页面，最后一项是上一页。 */
interface Location {
  page: PageKey;
  backStack: PageKey[];
}

const PAGE_COMPONENTS: Record<Exclude<PageKey, "pose">, ComponentType> = {
  generator: GeneratorPage,
  video: VideoPage,
  comic: ComicPage,
  history: HistoryPage,
  usage: UsagePage,
  announcements: AnnouncementsPage,
  settings: SettingsPage,
};

export default function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}

/** 主窗口外壳：左侧导航、页面容器和标题栏（对应 ui/main_window.py 的窗口部分）。 */
function Shell() {
  const t = useTr();
  const themeMode = useThemeMode();
  const resolvedTheme = useResolvedTheme();
  const language = normalizeLanguage(useConfigValue("language", "en"));
  const [location, setLocation] = useState<Location>({ page: DEFAULT_PAGE, backStack: [] });
  // 3D 姿势页按需懒加载：首次切换到「姿势」Tab 才初始化 Three.js 与 MakeHuman，之后常驻保活
  const [poseMounted, setPoseMounted] = useState(false);
  const [navMode, setNavMode] = useState<NavMode>("compact");
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);

  const title = t("main.title");

  // 文案表跟着配置里的 language 走
  useEffect(() => {
    setLanguage(language);
  }, [language]);

  useEffect(() => {
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
    // 源项目只在启动时设一次窗口标题；这里随语言切换即时更新
    document.title = title;
    if (platform.isTauri) runAsync(platform.window.setTitle(title));
  }, [title, language]);

  // 让原生窗口（滚动条等部件）的亮暗与界面一致；auto 时交还给系统
  useEffect(() => {
    if (platform.isTauri) {
      runAsync(platform.window.setTheme(themeMode === "auto" ? null : themeMode));
    }
  }, [themeMode]);

  // 浮层式导航：点到面板外面或按 Esc 就收起
  useEffect(() => {
    if (navMode !== "menu") return;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element && event.target.closest(".nav"))) {
        setNavMode("compact");
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNavMode("compact");
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [navMode]);

  // 换页才入栈；通过浮层导航切页后顺手收起导航
  const navigate = (next: PageKey) => {
    if (next === "pose") setPoseMounted(true);
    setLocation((current) =>
      current.page === next
        ? current
        : { page: next, backStack: [...current.backStack, current.page] },
    );
    setNavMode("compact");
  };

  // 启动时静默同步一次 Grsai 官网的模型可用性、积分价目表与官方公告（纯内存缓存，不阻塞启动）
  useEffect(() => {
    runAsync(syncGrsaiSiteData({ force: true }));
  }, []);

  // 历史页的「重新生成」与 3D 姿势页的「发送到图像/视频生成」：外壳切到目标页，页面监听同一事件
  useEffect(() => subscribeRestore((request) => navigate(request.page)), []);
  useEffect(() => subscribePoseTransfer((payload) => navigate(payload.target)), []);

  const finishClose = async () => {
    setCloseConfirmOpen(false);
    stopAllTasks();
    await cfg.flush();
    await platform.previewWindow?.close().catch(() => {});
    await platform.window.destroy();
  };

  // 拦下所有关闭请求（标题栏 ×、Alt+F4、任务栏关闭）：有未完成任务时先弹确认框
  useEffect(() => {
    if (!platform.isTauri) return;
    return platform.window.onCloseRequested((event) => {
      event.preventDefault();
      if (hasUnfinishedTasks()) {
        setCloseConfirmOpen(true);
        return;
      }
      runAsync(finishClose());
    });
  }, []);

  const goBack = () => {
    setLocation((current) => {
      if (current.backStack.length === 0) return current;
      const backStack = current.backStack.slice(0, -1);
      return { page: backStack[backStack.length - 1] ?? DEFAULT_PAGE, backStack };
    });
  };

  // 始终以浮层方式展开在子页面之上，不挤压右侧子页面排版
  const toggleNav = () => {
    setNavMode((mode) => (mode === "compact" ? "menu" : "compact"));
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
      {/* 页面常驻，只隐藏不卸载：切走再切回，输入的内容和跑着的任务都还在；姿势页首次访问才懒加载 */}
      <main className="content">
        {ALL_PAGES.map((key) => {
          const active = key === location.page;
          if (key === "pose") {
            return (
              <div
                key={key}
                className={active ? "page-host" : "page-host page-host--hidden"}
                aria-hidden={!active}
              >
                {poseMounted ? (
                  <Suspense fallback={null}>
                    <PosePage active={active} />
                  </Suspense>
                ) : null}
              </div>
            );
          }
          const Page = PAGE_COMPONENTS[key];
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
      {/* 右侧子页面在左侧导航展开时的深色渐显遮罩 */}
      <div
        className={navMode === "menu" ? "nav-backdrop nav-backdrop--open" : "nav-backdrop"}
        aria-hidden="true"
        onClick={() => setNavMode("compact")}
      />
      <TitleBar title={title} />
      <Dialog
        open={closeConfirmOpen}
        onOpenChange={(_event, data) => {
          if (!data.open) setCloseConfirmOpen(false);
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t("window.close_confirm_title")}</DialogTitle>
            <DialogContent>{t("window.close_confirm_body")}</DialogContent>
            <DialogActions>
              <Button appearance="secondary" autoFocus onClick={() => setCloseConfirmOpen(false)}>
                {t("window.close_confirm_back")}
              </Button>
              <Button appearance="primary" onClick={() => runAsync(finishClose())}>
                {t("window.close_confirm_exit")}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
