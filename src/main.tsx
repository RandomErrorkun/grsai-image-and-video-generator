import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import PreviewWindowApp from "./components/PreviewWindowApp";
import { setLanguage, normalizeLanguage } from "./i18n";
import { cfg, loadConfig } from "./state/config";
import "./styles/app.css";

/**
 * 全局禁用 WebView2 原生右键菜单与 F12 / Ctrl+Shift+I 等浏览器开发者工具快捷键：
 * - 非捕获阶段拦截 contextmenu，因此业务组件（历史记录、图片预览、灯箱等）上显式注册的 React
 *   onContextMenu 自定义菜单仍可正常弹出，其余任意空白/按钮/图像处均不再弹出原生浏览器菜单。
 * - 捕获阶段拦截 F12、Ctrl+Shift+I/J/C、Ctrl+U、F5、Ctrl+R，防止误触打开 DevTools 或刷新页面。
 */
function installBrowserHardening(): void {
  document.addEventListener("contextmenu", (event) => {
    event.preventDefault();
  });

  window.addEventListener(
    "keydown",
    (event) => {
      const key = event.key.toLowerCase();
      const ctrlOrMeta = event.ctrlKey || event.metaKey;
      const isDevtoolsShortcut =
        event.key === "F12" ||
        (ctrlOrMeta && event.shiftKey && (key === "i" || key === "j" || key === "c")) ||
        (ctrlOrMeta && key === "u");
      const isReloadShortcut = event.key === "F5" || (ctrlOrMeta && key === "r");
      if (isDevtoolsShortcut || isReloadShortcut) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    { capture: true },
  );
}

installBrowserHardening();

async function bootstrap(): Promise<void> {
  const isPreviewWindow = new URLSearchParams(window.location.search).get("window") === "preview";
  if (isPreviewWindow) {
    document.documentElement.dataset.window = "preview";
  }
  // 先读完配置再渲染，主题和语言才不会先闪一下默认值。
  await loadConfig();
  setLanguage(normalizeLanguage(cfg.get("language", "en")));
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      {isPreviewWindow ? <PreviewWindowApp /> : <App />}
    </React.StrictMode>,
  );
}

void bootstrap();
