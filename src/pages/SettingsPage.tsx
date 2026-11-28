/**
 * 设置页（对应 ui/settings_page.py）。分组和卡片的版式照源项目的 SettingCardGroup / SettingCard。
 * 所有设置项（含语言、主题、主题色、预览方式、输出目录、字体字号等）均在草稿中修改，
 * 只有点击「保存设置」后才统一写入 grsai_config.json 并生效，避免误改。
 */
import { useState, type CSSProperties, type ComponentType, type FormEvent, type ReactNode } from "react";
import { Button, Input, Slider, SpinButton, Switch } from "@fluentui/react-components";
import {
  ArrowSync20Regular,
  ArrowUpload20Regular,
  Color20Regular,
  Delete20Regular,
  Edit20Regular,
  Eye20Regular,
  Folder20Regular,
  FolderOpen20Regular,
  Globe20Regular,
  History20Regular,
  Info20Regular,
  PaintBrush20Regular,
  Pulse20Regular,
  ShieldKeyhole20Regular,
  TextAlignLeft20Regular,
  TextFont20Regular,
} from "@fluentui/react-icons";
import { APP_VERSION } from "../app/version";
import { FluentSelect } from "../components/FluentSelect";
import { notice } from "../components/Notice";
import { buildModelsListRequest, parseModelsListResponse } from "../core/comicPlanner";
import { DEFAULT_CONFIG } from "../core/config";
import { resolveGrsaiSiteOrigin } from "../core/modelAvailability";
import { VIP_MODELS } from "../core/modelCatalog";
import { clampOpenUnitRatio } from "../core/poseConfig";
import { useTr } from "../hooks/useLanguage";
import { languageItems, normalizeLanguage, translate } from "../i18n";
import { platform } from "../platform";
import { runAsync } from "../platform/async";
import { syncGrsaiSiteData } from "../state/announcements";
import { cfg } from "../state/config";
import { normalizePreviewMode } from "../state/preview";
import { resolveOutputFolder } from "../state/services";
import { ACCENT_PALETTE, normalizeAccentColor } from "../theme";
import {
  EMPTY_CUSTOM_CHAT_CONFIG,
  FONT_FAMILIES,
  FONT_SIZE_RANGE,
  HISTORY_ITEMS_RANGE,
  MAX_RETRIES_RANGE,
  SUBMIT_CONCURRENCY_RANGE,
  clampDecimalToRange,
  clampToRange,
  parseDecimalInput,
  parseDigits,
  readSettings,
  settingsToSave,
  type NumberRange,
  type SettingsDraft,
} from "./settingsView";
import "./SettingsPage.css";

const THEME_MODES = ["auto", "light", "dark"] as const;

interface SettingCardProps {
  icon: ComponentType<{ className?: string }>;
  title: string;
  /** 标题下面的说明行。 */
  content?: ReactNode;
  children: ReactNode;
}

/** 一张设置卡片：左边图标，中间标题和说明，右边是控件。 */
function SettingCard({ icon: Icon, title, content, children }: SettingCardProps) {
  return (
    <div className="settings-card">
      <Icon className="settings-card__icon" />
      <div className="settings-card__text">
        <span className="settings-card__title">{title}</span>
        {content ? <div className="settings-card__content">{content}</div> : null}
      </div>
      <div className="settings-card__control">{children}</div>
    </div>
  );
}

interface NumberRangeFieldProps {
  label: string;
  value: number;
  range: NumberRange;
  onChange(value: number): void;
}

/**
 * 滑块卡片，对应源项目的三张滑块卡片：数值在左，隔 10 像素是滑块。
 * 存值越界时数值照实显示、滑块停在边界（源项目的滑块也是如此），留到保存时再钳。
 */
function SliderField({
  label,
  value,
  range,
  defaultValue,
  fixedValueWidth,
  onChange,
}: NumberRangeFieldProps & { defaultValue?: number; fixedValueWidth?: boolean }) {
  return (
    <div
      className="settings-slider"
      onDoubleClick={() => {
        if (defaultValue !== undefined) onChange(defaultValue);
      }}
    >
      <span className={fixedValueWidth ? "settings-slider__value settings-slider__value--fixed" : "settings-slider__value"}>{value}</span>
      <Slider
        className="settings-slider__track"
        aria-label={label}
        min={range.min}
        max={range.max}
        step={1}
        value={clampToRange(value, range)}
        onChange={(_event, data) => onChange(data.value)}
      />
    </div>
  );
}

/** 步进框：只收数字，提交时钳到区间。重写版新增的提交并发数用它是为了能直接打字。 */
function NumberField({ label, value, range, onChange }: NumberRangeFieldProps) {
  return (
    <SpinButton
      className="settings-card__number"
      aria-label={label}
      value={value}
      min={range.min}
      max={range.max}
      step={1}
      inputMode="numeric"
      // 只放行数字，别的按键和粘贴一律挡在输入框外
      onBeforeInput={(event: FormEvent<HTMLInputElement>) => {
        const data = (event.nativeEvent as InputEvent).data;
        if (data && !/^\d+$/.test(data)) event.preventDefault();
      }}
      onChange={(_event, data) => {
        // 直接打字提交时数字在 displayValue 里；输成空的或非数字就保持原值
        const next = data.value ?? parseDigits(data.displayValue);
        if (next !== null) onChange(clampToRange(next, range));
      }}
    />
  );
}

interface FlagSwitchProps {
  label: string;
  checked: boolean;
  onChange(checked: boolean): void;
}

/** 开关带 On / Off 字样，字在指示条左边，与源项目的 SwitchSettingCard 一致（两种语言下都是英文）。 */
function FlagSwitch({ label, checked, onChange }: FlagSwitchProps) {
  return (
    <Switch
      checked={checked}
      labelPosition="before"
      label={checked ? "On" : "Off"}
      aria-label={label}
      onChange={(_event, data) => onChange(data.checked)}
    />
  );
}

export default function SettingsPage() {
  const t = useTr();
  // 所有设置项均维护在草稿中，只有点击「保存设置」才写回 grsai_config.json 并生效
  const [draft, setDraft] = useState(() => readSettings(cfg));
  const [fontSizeText, setFontSizeText] = useState(() => String(readSettings(cfg).text_font_size));
  const [watermarkRatioText, setWatermarkRatioText] = useState(() => String(readSettings(cfg).pose_watermark_area_ratio));
  const [labelRatioText, setLabelRatioText] = useState(() => String(readSettings(cfg).pose_label_area_ratio));
  const accent = normalizeAccentColor(draft.accent_color) ?? DEFAULT_CONFIG.accent_color.toLowerCase();
  const inPalette = ACCENT_PALETTE.some((color) => color.toLowerCase() === accent);
  const [customModels, setCustomModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchingSiteData, setFetchingSiteData] = useState(false);

  const update = <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const fetchGrsaiSiteData = async (siteUrl: string) => {
    if (fetchingSiteData) return;
    setFetchingSiteData(true);
    try {
      const { models, announcements } = await syncGrsaiSiteData({ force: true, siteUrl });
      const modelsOk = models.kind === "ok";
      const annOk = announcements.kind === "ok";
      if (modelsOk || annOk) {
        notice(
          "success",
          t("common.success"),
          t("settings.grsai_site.fetch_done", {
            models: modelsOk ? models.total : 0,
            announcements: annOk ? announcements.count : 0,
          }),
        );
      } else {
        const reason = models.kind === "error" ? models.message : announcements.kind === "error" ? announcements.message : "";
        notice("warning", t("common.warning"), t("settings.grsai_site.fetch_failed", { reason }));
      }
    } finally {
      setFetchingSiteData(false);
    }
  };

  const clearCustomLlm = () => {
    setDraft((current) => ({ ...current, ...EMPTY_CUSTOM_CHAT_CONFIG }));
    setCustomModels([]);
    notice("info", t("common.info"), t("settings.comic_chat.cleared"));
  };

  const fetchCustomModels = async () => {
    const baseUrl = draft.comic_custom_chat_base_url.trim();
    if (!baseUrl) {
      notice("warning", t("common.warning"), t("settings.comic_chat.base_url_required"));
      return;
    }
    setFetchingModels(true);
    try {
      const outcome = await platform.http.request(buildModelsListRequest(baseUrl, draft.comic_custom_chat_api_key));
      if (outcome.outcome !== "responded") {
        notice("warning", t("common.warning"), outcome.message);
        return;
      }
      const parsed = parseModelsListResponse(outcome.status, outcome.body);
      if (!parsed.ok) {
        notice("warning", t("common.warning"), parsed.message);
        return;
      }
      setCustomModels(parsed.models);
      if (!draft.comic_custom_chat_model.trim() && parsed.models.length > 0) {
        update("comic_custom_chat_model", parsed.models[0]);
      }
      notice("success", t("common.success"), t("settings.comic_chat.models_loaded", { count: parsed.models.length }));
    } finally {
      setFetchingModels(false);
    }
  };

  const chooseFolder = async () => {
    const folder = await platform.dialog.pickDirectory({
      title: t("settings.dialog.select_folder"),
      defaultPath: String(resolveOutputFolder(draft.output_folder)),
    });
    if (!folder) return;
    // 仅更新草稿，点「保存设置」后才写盘并生效
    update("output_folder", folder);
  };

  const save = () => {
    const previousOrigin = resolveGrsaiSiteOrigin(cfg.get("grsai_site_url", DEFAULT_CONFIG.grsai_site_url));
    const parsedSize = parseDecimalInput(fontSizeText);
    const parsedWatermarkRatio = parseDecimalInput(watermarkRatioText);
    const parsedLabelRatio = parseDecimalInput(labelRatioText);
    const nextDraft: SettingsDraft = {
      ...draft,
      text_font_size: parsedSize !== null ? parsedSize : draft.text_font_size,
      pose_watermark_area_ratio:
        parsedWatermarkRatio !== null ? parsedWatermarkRatio : draft.pose_watermark_area_ratio,
      pose_label_area_ratio:
        parsedLabelRatio !== null ? parsedLabelRatio : draft.pose_label_area_ratio,
    };
    const saved = settingsToSave(nextDraft);
    for (const [key, value] of Object.entries(saved)) cfg.set(key, value);
    // 放行新输出目录
    runAsync(platform.media.allow([String(resolveOutputFolder(saved.output_folder))], true));
    setDraft(saved);
    setFontSizeText(String(saved.text_font_size));
    setWatermarkRatioText(String(saved.pose_watermark_area_ratio));
    setLabelRatioText(String(saved.pose_label_area_ratio));
    const savedLang = normalizeLanguage(saved.language);
    notice("success", translate(savedLang, "settings.saved_title"), translate(savedLang, "settings.saved_content"));
    // 只有点击「保存设置」且官网地址确实发生变化时才自动重抓，绝不在打字编辑过程中反复触发
    if (resolveGrsaiSiteOrigin(saved.grsai_site_url) !== previousOrigin) {
      runAsync(fetchGrsaiSiteData(saved.grsai_site_url));
    }
  };

  return (
    <div className="page settings-page">
      <div className="settings-page__scroll">
        <section className="settings-group">
          <h2 className="settings-group__title">{t("settings.general")}</h2>
          <div className="settings-group__cards">
            <SettingCard icon={Globe20Regular} title={t("settings.language.title")} content={t("settings.language.content")}>
              <FluentSelect
                className="settings-card__select"
                value={draft.language}
                options={languageItems().map(({ code, label }) => ({ value: code, label }))}
                ariaLabel={t("settings.language.title")}
                onChange={(value) => update("language", normalizeLanguage(value))}
              />
            </SettingCard>
            <SettingCard icon={PaintBrush20Regular} title={t("settings.theme.title")} content={t("settings.theme.content")}>
              <FluentSelect
                className="settings-card__select"
                value={draft.theme}
                options={THEME_MODES.map((mode) => ({ value: mode, label: t(`theme.${mode}`) }))}
                ariaLabel={t("settings.theme.title")}
                onChange={(value) => update("theme", value)}
              />
            </SettingCard>
            <SettingCard icon={Color20Regular} title={t("settings.accent_color.title")} content={t("settings.accent_color.content")}>
              <div className="accent-palette" role="radiogroup" aria-label={t("settings.accent_color.title")}>
                {ACCENT_PALETTE.map((color) => {
                  const active = color.toLowerCase() === accent;
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
                      onClick={() => update("accent_color", color)}
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
                    onChange={(event) => update("accent_color", event.target.value)}
                  />
                </label>
              </div>
            </SettingCard>
            <SettingCard
              icon={Eye20Regular}
              title={t("settings.preview_mode.title")}
              content={t("settings.preview_mode.content")}
            >
              <FluentSelect
                className="settings-card__select"
                value={draft.preview_mode}
                options={[
                  { value: "internal", label: t("settings.preview_mode.internal") },
                  { value: "system", label: t("settings.preview_mode.system") },
                ]}
                ariaLabel={t("settings.preview_mode.title")}
                onChange={(value) => update("preview_mode", normalizePreviewMode(value))}
              />
            </SettingCard>
            <SettingCard icon={ArrowSync20Regular} title={t("settings.retries.title")} content={t("settings.retries.content")}>
              <SliderField
                label={t("settings.retries.title")}
                value={draft.max_retries}
                range={MAX_RETRIES_RANGE}
                defaultValue={DEFAULT_CONFIG.max_retries}
                onChange={(value) => update("max_retries", value)}
              />
            </SettingCard>
            <SettingCard
              icon={ArrowUpload20Regular}
              title={t("settings.submit_concurrency.title")}
              content={t("settings.submit_concurrency.content")}
            >
              <NumberField
                label={t("settings.submit_concurrency.title")}
                value={draft.submit_concurrency}
                range={SUBMIT_CONCURRENCY_RANGE}
                onChange={(value) => update("submit_concurrency", value)}
              />
            </SettingCard>
            <SettingCard
              icon={ArrowSync20Regular}
              title={t("settings.vip_retry.title")}
              content={
                <>
                  {t("settings.vip_retry.content")}
                  <br />
                  {t("settings.vip_retry.models", { models: VIP_MODELS.join(", ") })}
                </>
              }
            >
              <FlagSwitch
                label={t("settings.vip_retry.title")}
                checked={draft.vip_moderation_auto_retry}
                onChange={(checked) => update("vip_moderation_auto_retry", checked)}
              />
            </SettingCard>
            <SettingCard icon={History20Regular} title={t("settings.history.title")} content={t("settings.history.content")}>
              <SliderField
                label={t("settings.history.title")}
                value={draft.history_items_per_page}
                range={HISTORY_ITEMS_RANGE}
                defaultValue={DEFAULT_CONFIG.history_items_per_page}
                onChange={(value) => update("history_items_per_page", value)}
              />
            </SettingCard>
          </div>
        </section>

        <section className="settings-group">
          <h2 className="settings-group__title">{t("settings.format")}</h2>
          <div className="settings-group__cards">
            <SettingCard icon={Edit20Regular} title={t("settings.format_enable.title")} content={t("settings.format_enable.content")}>
              <FlagSwitch
                label={t("settings.format_enable.title")}
                checked={draft.text_format_enabled}
                onChange={(checked) => update("text_format_enabled", checked)}
              />
            </SettingCard>
            <SettingCard icon={TextFont20Regular} title={t("settings.font_size.title")} content={t("settings.font_size.content")}>
              <Input
                className="settings-card__number"
                type="text"
                inputMode="decimal"
                aria-label={t("settings.font_size.title")}
                placeholder="9"
                value={fontSizeText}
                autoComplete="off"
                spellCheck={false}
                onChange={(_event, data) => {
                  const next = data.value;
                  if (next === "" || /^\d*\.?\d*$/.test(next)) {
                    setFontSizeText(next);
                    const parsed = parseDecimalInput(next);
                    if (parsed !== null) {
                      update("text_font_size", parsed);
                    }
                  }
                }}
                onBlur={() => {
                  const parsed = parseDecimalInput(fontSizeText);
                  const clamped = clampDecimalToRange(parsed ?? draft.text_font_size, FONT_SIZE_RANGE);
                  update("text_font_size", clamped);
                  setFontSizeText(String(clamped));
                }}
              />
            </SettingCard>
            <SettingCard icon={TextFont20Regular} title={t("settings.font_family.title")} content={t("settings.font_family.content")}>
              <FluentSelect
                className="settings-card__select"
                value={draft.text_font_family}
                options={FONT_FAMILIES}
                ariaLabel={t("settings.font_family.title")}
                onChange={(value) => update("text_font_family", value)}
              />
            </SettingCard>
            <SettingCard icon={TextAlignLeft20Regular} title={t("settings.wrap.title")} content={t("settings.wrap.content")}>
              <FlagSwitch
                label={t("settings.wrap.title")}
                checked={draft.text_auto_wrap}
                onChange={(checked) => update("text_auto_wrap", checked)}
              />
            </SettingCard>
            <SettingCard
              icon={TextFont20Regular}
              title={t("settings.pose_watermark_ratio.title")}
              content={t("settings.pose_watermark_ratio.content")}
            >
              <Input
                className="settings-card__number"
                type="text"
                inputMode="decimal"
                aria-label={t("settings.pose_watermark_ratio.title")}
                placeholder="0.02"
                value={watermarkRatioText}
                autoComplete="off"
                spellCheck={false}
                onChange={(_event, data) => {
                  const next = data.value;
                  if (next === "" || /^(?:0(?:\.\d{0,4})?|\.\d{0,4})$/.test(next)) {
                    setWatermarkRatioText(next);
                    const parsed = parseDecimalInput(next);
                    if (parsed !== null && parsed > 0 && parsed < 1) {
                      update("pose_watermark_area_ratio", parsed);
                    }
                  }
                }}
                onBlur={() => {
                  const parsed = parseDecimalInput(watermarkRatioText);
                  const clamped = clampOpenUnitRatio(
                    parsed ?? draft.pose_watermark_area_ratio,
                    DEFAULT_CONFIG.pose_watermark_area_ratio,
                  );
                  update("pose_watermark_area_ratio", clamped);
                  setWatermarkRatioText(String(clamped));
                }}
              />
            </SettingCard>
            <SettingCard
              icon={TextFont20Regular}
              title={t("settings.pose_label_ratio.title")}
              content={t("settings.pose_label_ratio.content")}
            >
              <Input
                className="settings-card__number"
                type="text"
                inputMode="decimal"
                aria-label={t("settings.pose_label_ratio.title")}
                placeholder="0.003"
                value={labelRatioText}
                autoComplete="off"
                spellCheck={false}
                onChange={(_event, data) => {
                  const next = data.value;
                  if (next === "" || /^(?:0(?:\.\d{0,4})?|\.\d{0,4})$/.test(next)) {
                    setLabelRatioText(next);
                    const parsed = parseDecimalInput(next);
                    if (parsed !== null && parsed > 0 && parsed < 1) {
                      update("pose_label_area_ratio", parsed);
                    }
                  }
                }}
                onBlur={() => {
                  const parsed = parseDecimalInput(labelRatioText);
                  const clamped = clampOpenUnitRatio(
                    parsed ?? draft.pose_label_area_ratio,
                    DEFAULT_CONFIG.pose_label_area_ratio,
                  );
                  update("pose_label_area_ratio", clamped);
                  setLabelRatioText(String(clamped));
                }}
              />
            </SettingCard>
          </div>
        </section>

        <section className="settings-group">
          <h2 className="settings-group__title">{t("settings.api")}</h2>
          <div className="settings-group__cards">
            <SettingCard icon={Globe20Regular} title={t("settings.api_url.title")}>
              <Input
                className="settings-card__input"
                aria-label={t("settings.api_url.title")}
                value={draft.api_base_url}
                autoComplete="off"
                spellCheck={false}
                onChange={(_event, data) => update("api_base_url", data.value)}
              />
            </SettingCard>
            <SettingCard icon={ShieldKeyhole20Regular} title={t("settings.api_key.title")} content={t("settings.api_key.content")}>
              {/* 与源项目一致：密钥打码显示。密码框要放在表单里浏览器才认，表单本身不提交，也不自动填充 */}
              <form autoComplete="off" onSubmit={(event) => event.preventDefault()}>
                <Input
                  className="settings-card__input"
                  type="password"
                  aria-label={t("settings.api_key.title")}
                  value={draft.api_key}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(_event, data) => update("api_key", data.value)}
                />
              </form>
            </SettingCard>
            <SettingCard
              icon={Globe20Regular}
              title={t("settings.grsai_site.title")}
              content={t("settings.grsai_site.content")}
            >
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <Input
                  className="settings-card__select"
                  aria-label={t("settings.grsai_site.title")}
                  placeholder="grsai.ai"
                  value={draft.grsai_site_url}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(_event, data) => update("grsai_site_url", data.value)}
                />
                <Button
                  icon={<Pulse20Regular />}
                  disabled={fetchingSiteData}
                  onClick={() => runAsync(fetchGrsaiSiteData(draft.grsai_site_url))}
                >
                  {t("settings.grsai_site.fetch")}
                </Button>
              </div>
            </SettingCard>
          </div>
        </section>

        <section className="settings-group">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <h2 className="settings-group__title">{t("settings.comic_chat")}</h2>
            <Button
              appearance="secondary"
              size="small"
              icon={<Delete20Regular />}
              onClick={clearCustomLlm}
            >
              {t("settings.comic_chat.clear")}
            </Button>
          </div>
          <div className="settings-group__cards">
            <SettingCard
              icon={Globe20Regular}
              title={t("settings.comic_chat.base_url.title")}
              content={t("settings.comic_chat.base_url.content")}
            >
              <Input
                className="settings-card__input"
                aria-label={t("settings.comic_chat.base_url.title")}
                placeholder="https://api.openai.com/v1"
                value={draft.comic_custom_chat_base_url}
                autoComplete="off"
                spellCheck={false}
                onChange={(_event, data) => update("comic_custom_chat_base_url", data.value)}
              />
            </SettingCard>
            <SettingCard
              icon={Globe20Regular}
              title={t("settings.comic_chat.endpoint.title")}
              content={t("settings.comic_chat.endpoint.content")}
            >
              <Input
                className="settings-card__input"
                aria-label={t("settings.comic_chat.endpoint.title")}
                placeholder="/chat/completions"
                value={draft.comic_custom_chat_endpoint}
                autoComplete="off"
                spellCheck={false}
                onChange={(_event, data) => update("comic_custom_chat_endpoint", data.value)}
              />
            </SettingCard>
            <SettingCard
              icon={ShieldKeyhole20Regular}
              title={t("settings.comic_chat.api_key.title")}
              content={t("settings.comic_chat.api_key.content")}
            >
              <form autoComplete="off" onSubmit={(event) => event.preventDefault()}>
                <Input
                  className="settings-card__input"
                  type="password"
                  aria-label={t("settings.comic_chat.api_key.title")}
                  value={draft.comic_custom_chat_api_key}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(_event, data) => update("comic_custom_chat_api_key", data.value)}
                />
              </form>
            </SettingCard>
            <SettingCard
              icon={Edit20Regular}
              title={t("settings.comic_chat.model.title")}
              content={t("settings.comic_chat.model.content")}
            >
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {customModels.length > 0 ? (
                  <FluentSelect
                    className="settings-card__select"
                    ariaLabel={t("settings.comic_chat.model.title")}
                    value={draft.comic_custom_chat_model}
                    placeholder="--"
                    options={customModels}
                    onChange={(value) => {
                      if (value) update("comic_custom_chat_model", value);
                    }}
                  />
                ) : (
                  <Input
                    className="settings-card__select"
                    aria-label={t("settings.comic_chat.model.title")}
                    value={draft.comic_custom_chat_model}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(_event, data) => update("comic_custom_chat_model", data.value)}
                  />
                )}
                <Button disabled={fetchingModels} onClick={() => runAsync(fetchCustomModels())}>
                  {t("settings.comic_chat.fetch_models")}
                </Button>
              </div>
            </SettingCard>
            <SettingCard
              icon={Edit20Regular}
              title={t("settings.comic_chat.body.title")}
              content={t("settings.comic_chat.body.content")}
            >
              <Input
                className="settings-card__input"
                aria-label={t("settings.comic_chat.body.title")}
                placeholder='{"temperature": 0.8}'
                value={draft.comic_custom_chat_body}
                autoComplete="off"
                spellCheck={false}
                onChange={(_event, data) => update("comic_custom_chat_body", data.value)}
              />
            </SettingCard>
          </div>
        </section>

        <section className="settings-group">
          <h2 className="settings-group__title">{t("settings.output")}</h2>
          <div className="settings-group__cards">
            <SettingCard icon={Folder20Regular} title={t("settings.output.title")} content={draft.output_folder}>
              <Button icon={<FolderOpen20Regular />} onClick={() => runAsync(chooseFolder())}>
                {t("settings.output.choose")}
              </Button>
            </SettingCard>
          </div>
        </section>

        <section className="settings-group">
          <h2 className="settings-group__title">{t("settings.about")}</h2>
          <div className="settings-group__cards">
            <SettingCard icon={Info20Regular} title={t("settings.version.title")} content={t("main.title")}>
              <span className="settings-card__version">{`v${APP_VERSION}`}</span>
            </SettingCard>
          </div>
        </section>

        <div className="settings-page__footer">
          <Button appearance="primary" className="settings-page__save" onClick={save}>
            {t("settings.save")}
          </Button>
        </div>
      </div>
    </div>
  );
}
