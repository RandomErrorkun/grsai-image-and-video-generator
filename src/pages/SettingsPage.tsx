import { Field, Select } from "@fluentui/react-components";
import { useThemeMode } from "../hooks/useAppTheme";
import { useConfigValue } from "../hooks/useConfigValue";
import { useTr } from "../hooks/useLanguage";
import { languageItems, normalizeLanguage } from "../i18n";
import { cfg } from "../state/config";

const THEME_MODES = ["auto", "light", "dark"] as const;

/** 设置页（对应 ui/settings_page.py）。M0 只有语言和主题两项，其余设置在 M2 补齐。 */
export default function SettingsPage() {
  const t = useTr();
  const language = normalizeLanguage(useConfigValue("language", "en"));
  const themeMode = useThemeMode();

  return (
    <div className="page settings-stub">
      <Field label={t("settings.language.title")} className="settings-stub__field">
        <Select
          value={language}
          aria-label={t("settings.language.title")}
          onChange={(_event, data) => cfg.set("language", data.value)}
        >
          {languageItems().map(({ code, label }) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t("settings.theme.title")} className="settings-stub__field">
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
    </div>
  );
}
