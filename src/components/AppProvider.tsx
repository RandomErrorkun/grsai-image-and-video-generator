import { useEffect, useMemo, type ReactNode } from "react";
import { FluentProvider } from "@fluentui/react-components";
import { useAccentColor, useResolvedTheme } from "../hooks/useAppTheme";
import { themesFor } from "../theme";
import { MediaLightboxHost } from "./MediaLightbox";
import { NoticeHost } from "./Notice";
import { TextInputContextMenu } from "./TextInputContextMenu";

/** 主题、主题色和轻提示的宿主。应用外壳和开发时单独预览组件都包在它里面。 */
export function AppProvider({ children }: { children?: ReactNode }) {
  const resolvedTheme = useResolvedTheme();
  const accent = useAccentColor();
  const themes = useMemo(() => themesFor(accent), [accent]);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    // 自绘的那部分界面（导航指示条、焦点框等）跟着主题色走
    document.documentElement.style.setProperty("--accent", accent);
  }, [resolvedTheme, accent]);

  return (
    <FluentProvider className="app-provider" theme={resolvedTheme === "dark" ? themes.dark : themes.light}>
      {children}
      <NoticeHost />
      <MediaLightboxHost />
      <TextInputContextMenu />
    </FluentProvider>
  );
}
