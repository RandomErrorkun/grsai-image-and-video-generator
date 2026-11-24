import { Field, Select } from "@fluentui/react-components";
import type { CSSProperties } from "react";
import { ACCENT_PALETTE } from "../theme";
import { useAccentColor, useThemeMode } from "../hooks/useAppTheme";
import { useConfigValue } from "../hooks/useConfigValue";
import { useTr } from "../hooks/useLanguage";
import { languageItems, normalizeLanguage, translate } from "../i18n";
import { cfg } from "../state/config";
import { notice } from "../components/Notice";

const THEME_MODES = ["auto", "light", "dark"] as const;

/** 设置页（对应 ui/settings_page.py）。M2 之前只有语言、主题模式和主题色三项，其余设置在 M2 补齐。 */
export default function SettingsPage() {
  const t = useTr();
  const language = normalizeLanguage(useConfigValue("language", "en"));
  const themeMode = useThemeMode();
  const accent = useAccentColor();
  const inPalette = ACCENT_PALETTE.includes(accent);

  return (
    <div className="page settings-stub">
      <Field label={t("settings.language.title")} hint={t("settings.language.content")} className="settings-stub__field">
        <Select
          value={language}
          aria-label={t("settings.language.title")}
          onChange={(_event, data) => {
            const next = normalizeLanguage(data.value);
            cfg.set("language", next);
            // 提示要用切换后的语言来显示
            notice("success", translate(next, "settings.applied"));
          }}
        >
          {languageItems().map(({ code, label }) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t("settings.theme.title")} hint={t("settings.theme.content")} className="settings-stub__field">
        <Select
          value={themeMode}
          aria-label={t("settings.theme.title")}
          onChange={(_event, data) => cfg.set("theme", data.value)}
        >
          {THEME_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {t(`theme.${mode}`)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t("settings.accent_color.title")} hint={t("settings.accent_color.content")} className="settings-stub__field">
        <div className="accent-palette" role="radiogroup" aria-label={t("settings.accent_color.title")}>
          {ACCENT_PALETTE.map((color) => {
            const active = color === accent;
            return (
              <button
                key={color}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={color}
                title={color}
                className={active ? "accent-swatch accent-swatch--active" : "accent-swatch"}
                style={{ "--swatch": color } as CSSProperties}
                onClick={() => cfg.set("accent_color", color)}
              />
            );
          })}
          {/* 调色板里没有的颜色可以自己挑 */}
          <label
            className={inPalette ? "accent-swatch accent-swatch--custom" : "accent-swatch accent-swatch--custom accent-swatch--active"}
            title={accent}
          >
            <input
              type="color"
              value={accent}
              aria-label={t("settings.accent_color.title")}
              onChange={(event) => cfg.set("accent_color", event.target.value)}
            />
          </label>
        </div>
      </Field>
    </div>
  );
}
