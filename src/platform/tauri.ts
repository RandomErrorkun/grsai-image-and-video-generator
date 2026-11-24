import { getCurrentWindow } from "@tauri-apps/api/window";
import type { NativeTheme, Platform } from "./types";
import { browserPlatform } from "./browser";

export const tauriPlatform: Platform = {
  isTauri: true,
  window: {
    minimize: () => getCurrentWindow().minimize(),
    toggleMaximize: () => getCurrentWindow().toggleMaximize(),
    close: () => getCurrentWindow().close(),
    isMaximized: () => getCurrentWindow().isMaximized(),
    setTitle: (title: string) => getCurrentWindow().setTitle(title),
    setTheme: (theme: NativeTheme | null) => getCurrentWindow().setTheme(theme),
    onResized: (listener: () => void) => {
      let unlisten: (() => void) | undefined;
      let disposed = false;
      void getCurrentWindow()
        .onResized(() => listener())
        .then((stop) => {
          if (disposed) stop();
          else unlisten = stop;
        });
      return () => {
        disposed = true;
        unlisten?.();
      };
    },
  },
  // M1 换成读写程序目录下的 grsai_config.json；在那之前先用浏览器的 localStorage 顶着。
  configStorage: browserPlatform.configStorage,
};
