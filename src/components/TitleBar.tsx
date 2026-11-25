import { useEffect, useState } from "react";
import logo from "../assets/logo.png";
import { useTr } from "../hooks/useLanguage";
import { platform } from "../platform";
import { runAsync } from "../platform/async";
import { cfg } from "../state/config";
import { stopAllTasks } from "../state/taskLists";

function MinimizeGlyph() {
  return (
    <svg className="caption-glyph" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function MaximizeGlyph() {
  return (
    <svg className="caption-glyph" viewBox="0 0 10 10" aria-hidden="true">
      <rect x="0.5" y="0.5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" />
    </svg>
  );
}

function RestoreGlyph() {
  return (
    <svg className="caption-glyph" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2.5 2.5v-2h7v7h-2" fill="none" stroke="currentColor" />
      <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg className="caption-glyph" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" />
    </svg>
  );
}

/**
 * 与源项目一致：关窗口时直接停掉所有任务，没有确认。
 * 配置是异步落盘的，先等没写完的写完再关，免得刚改的设置丢掉。
 */
async function closeWindow(): Promise<void> {
  stopAllTasks();
  await cfg.flush();
  await platform.window.close();
}

/**
 * 自定义标题栏：应用图标、标题和窗口控制按钮。
 * 整条可拖动窗口，双击最大化（由 Tauri 的 data-tauri-drag-region 接管）。
 */
export function TitleBar({ title }: { title: string }) {
  const t = useTr();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!platform.isTauri) return;
    const sync = () => {
      runAsync(platform.window.isMaximized().then(setMaximized));
    };
    sync();
    return platform.window.onResized(sync);
  }, []);

  return (
    <header className="titlebar" data-tauri-drag-region>
      <img
        className="titlebar__icon"
        src={logo}
        alt=""
        draggable={false}
        data-tauri-drag-region
      />
      <span className="titlebar__title" data-tauri-drag-region>
        {title}
      </span>
      {platform.isTauri && (
        <div className="titlebar__buttons">
          <button
            type="button"
            className="caption-button"
            title={t("window.minimize")}
            aria-label={t("window.minimize")}
            onClick={() => runAsync(platform.window.minimize())}
          >
            <MinimizeGlyph />
          </button>
          <button
            type="button"
            className="caption-button"
            title={maximized ? t("window.restore") : t("window.maximize")}
            aria-label={maximized ? t("window.restore") : t("window.maximize")}
            onClick={() => runAsync(platform.window.toggleMaximize())}
          >
            {maximized ? <RestoreGlyph /> : <MaximizeGlyph />}
          </button>
          <button
            type="button"
            className="caption-button caption-button--close"
            title={t("window.close")}
            aria-label={t("window.close")}
            onClick={() => runAsync(closeWindow())}
          >
            <CloseGlyph />
          </button>
        </div>
      )}
    </header>
  );
}
