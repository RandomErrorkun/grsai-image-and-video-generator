import type { ComponentType } from "react";
import {
  ArrowLeftRegular,
  DataBarVerticalRegular,
  HistoryRegular,
  ImageRegular,
  LineHorizontal3Regular,
  MegaphoneRegular,
  PaintBrushRegular,
  SettingsRegular,
  VideoRegular,
  WeatherSunnyRegular,
} from "@fluentui/react-icons";
import {
  NAV_LABEL_KEY,
  TOP_PAGES,
  type NavMode,
  type PageKey,
} from "../app/navigation";
import { useTr } from "../hooks/useLanguage";

interface NavigationRailProps {
  page: PageKey;
  mode: NavMode;
  canGoBack: boolean;
  onNavigate: (page: PageKey) => void;
  onBack: () => void;
  onToggleExpanded: () => void;
  onToggleTheme: () => void;
}

type NavIcon = ComponentType<{ fontSize?: number; className?: string }>;

const PAGE_ICONS: Record<PageKey, NavIcon> = {
  generator: PaintBrushRegular,
  video: VideoRegular,
  comic: ImageRegular,
  history: HistoryRegular,
  usage: DataBarVerticalRegular,
  announcements: MegaphoneRegular,
  settings: SettingsRegular,
};

/**
 * 左侧导航栏：顶部是返回键和折叠键，中间是四个主页面，底部是主题切换和设置。
 * 默认是 48 像素的纯图标栏，展开后带文字（对应原件的 NavigationInterface）。
 */
export function NavigationRail({
  page,
  mode,
  canGoBack,
  onNavigate,
  onBack,
  onToggleExpanded,
  onToggleTheme,
}: NavigationRailProps) {
  const t = useTr();
  const expanded = mode !== "compact";

  return (
    <nav className={expanded ? `nav nav--${mode}` : "nav"}>
      <div className="nav__tools">
        <button
          type="button"
          className="nav-item"
          title={t("nav.back")}
          aria-label={t("nav.back")}
          disabled={!canGoBack}
          onClick={onBack}
        >
          <ArrowLeftRegular fontSize={16} />
        </button>
        <button
          type="button"
          className="nav-item"
          title={expanded ? t("nav.close_navigation") : t("nav.open_navigation")}
          aria-label={expanded ? t("nav.close_navigation") : t("nav.open_navigation")}
          aria-expanded={expanded}
          onClick={onToggleExpanded}
        >
          <LineHorizontal3Regular fontSize={16} />
        </button>
      </div>

      <div className="nav__items">
        {TOP_PAGES.map((key) => {
          const Icon = PAGE_ICONS[key];
          const selected = page === key;
          return (
            <button
              key={key}
              type="button"
              className={selected ? "nav-item nav-item--selected" : "nav-item"}
              title={t(NAV_LABEL_KEY[key])}
              aria-label={t(NAV_LABEL_KEY[key])}
              aria-current={selected ? "page" : undefined}
              onClick={() => onNavigate(key)}
            >
              {selected && <span className="nav-item__indicator" />}
              <Icon fontSize={16} />
              <span className="nav-item__label">{t(NAV_LABEL_KEY[key])}</span>
            </button>
          );
        })}
      </div>

      <div className="nav__bottom">
        <button
          type="button"
          className="nav-item"
          title={t("nav.toggle_theme")}
          aria-label={t("nav.toggle_theme")}
          onClick={onToggleTheme}
        >
          <WeatherSunnyRegular fontSize={16} />
          <span className="nav-item__label">{t("nav.toggle_theme")}</span>
        </button>
        <button
          type="button"
          className={page === "settings" ? "nav-item nav-item--selected" : "nav-item"}
          title={t(NAV_LABEL_KEY.settings)}
          aria-label={t(NAV_LABEL_KEY.settings)}
          aria-current={page === "settings" ? "page" : undefined}
          onClick={() => onNavigate("settings")}
        >
          {page === "settings" && <span className="nav-item__indicator" />}
          <SettingsRegular fontSize={16} />
          <span className="nav-item__label">{t(NAV_LABEL_KEY.settings)}</span>
        </button>
      </div>
    </nav>
  );
}
