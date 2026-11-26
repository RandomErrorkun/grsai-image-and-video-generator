import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import PreviewWindowApp from "./components/PreviewWindowApp";
import { setLanguage, normalizeLanguage } from "./i18n";
import { cfg, loadConfig } from "./state/config";
import "./styles/app.css";

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
