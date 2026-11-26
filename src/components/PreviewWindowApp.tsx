/**
 * 独立全屏预览子窗口入口（Tauri 桌面端 `?window=preview`）：
 * 覆盖主窗口所在显示器的全屏无边框透明浮层，不受主窗口最小尺寸限制；
 * 点击图片外暗底、点击关闭按钮、按 Esc 或点击窗口外（失焦）都会隐藏复用该子窗口并停止媒体播放。
 */
import { useCallback, useEffect, useState } from "react";
import { AppProvider } from "./AppProvider";
import { MediaLightbox } from "./MediaLightbox";
import { normalizeLanguage, setLanguage } from "../i18n";
import { platform } from "../platform";
import { runAsync } from "../platform/async";
import { cfg } from "../state/config";
import { classifyPreviewMedia, type PreviewTarget } from "../state/preview";

function toTarget(path: string | null): PreviewTarget | null {
  if (!path) return null;
  const kind = classifyPreviewMedia(path);
  return kind === "other" ? null : { path, kind };
}

export default function PreviewWindowApp() {
  const [target, setTarget] = useState<PreviewTarget | null>(null);
  const [openSeq, setOpenSeq] = useState(0);

  const openPath = useCallback((path: string | null) => {
    const next = toTarget(path);
    setTarget(next);
    if (next) setOpenSeq((n) => n + 1);
  }, []);

  const handleClose = useCallback(() => {
    setTarget(null);
    if (platform.previewWindow) {
      runAsync(platform.previewWindow.close(false));
    }
  }, []);

  const handleExitFullscreen = useCallback(() => {
    setTarget(null);
    if (platform.previewWindow) {
      runAsync(platform.previewWindow.close(true));
    }
  }, []);

  useEffect(() => {
    const previewWin = platform.previewWindow;
    if (!previewWin) return;
    runAsync(previewWin.getInitialPath().then(openPath));
    const unsubOpen = previewWin.onOpen((path) => {
      // 每次复用窗口重新打开时同步主窗口可能刚切换过的语言与主题配置
      runAsync(
        cfg
          .load()
          .then(() => {
            setLanguage(normalizeLanguage(cfg.get("language", "en")));
          })
          .catch(() => {}),
      );
      openPath(path);
    });
    const unsubClosed = previewWin.onClosed(() => {
      setTarget(null);
    });
    return () => {
      unsubOpen();
      unsubClosed();
    };
  }, [openPath]);

  return (
    <AppProvider>
      {target ? (
        <MediaLightbox
          key={`${target.path}#${openSeq}`}
          target={target}
          isFullscreen
          onClose={handleClose}
          onToggleFullscreen={handleExitFullscreen}
        />
      ) : null}
    </AppProvider>
  );
}
