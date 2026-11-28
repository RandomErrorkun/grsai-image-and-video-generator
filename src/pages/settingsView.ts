/**
 * 设置页的纯逻辑。
 * 所有设置项（语言、主题、主题色、预览方式、输出目录、重试/并发、提示词字体/字号、API、官网、第三方 LLM）
 * 均先在草稿中修改，只有点击「保存设置」后才统一写入 grsai_config.json 并生效，防止误改。
 */
import { normalizeThemeMode } from "../app/navigation";
import { DEFAULT_CONFIG, type AppConfig, type ConfigValue } from "../core/config";
import { clampOpenUnitRatio } from "../core/poseConfig";
import { normalizeLanguage } from "../i18n";
import { normalizePreviewMode } from "../state/preview";
import { normalizeAccentColor } from "../theme";

/** 字体下拉框的选项：首位为内嵌私有等宽字体 JetBrainsMapleMono，其余与源项目一致。 */
export const FONT_FAMILIES = [
  "JetBrainsMapleMono",
  "Arial",
  "Courier New",
  "Times New Roman",
  "Verdana",
  "Georgia",
  "SimSun",
  "SimHei",
  "KaiTi",
] as const;

export interface NumberRange {
  readonly min: number;
  readonly max: number;
}

/** 数值字段的区间。字号支持 1~72（含小数）。 */
export const MAX_RETRIES_RANGE: NumberRange = { min: 0, max: 100 };
export const SUBMIT_CONCURRENCY_RANGE: NumberRange = { min: 1, max: 10 };
export const HISTORY_ITEMS_RANGE: NumberRange = { min: 1, max: 100 };
export const FONT_SIZE_RANGE: NumberRange = { min: 1, max: 72 };

/** 设置页草稿覆盖的全部配置键；点击「保存设置」时统一写入 grsai_config.json。 */
export type SettingsDraft = Pick<
  AppConfig,
  | "language"
  | "theme"
  | "accent_color"
  | "preview_mode"
  | "output_folder"
  | "api_base_url"
  | "api_key"
  | "grsai_site_url"
  | "max_retries"
  | "submit_concurrency"
  | "vip_moderation_auto_retry"
  | "history_items_per_page"
  | "text_format_enabled"
  | "text_font_size"
  | "text_font_family"
  | "text_auto_wrap"
  | "pose_watermark_area_ratio"
  | "pose_label_area_ratio"
  | "comic_custom_chat_base_url"
  | "comic_custom_chat_endpoint"
  | "comic_custom_chat_api_key"
  | "comic_custom_chat_model"
  | "comic_custom_chat_body"
>;

/** 一键清空第三方 LLM 配置时写回草稿的空字段集合。 */
export const EMPTY_CUSTOM_CHAT_CONFIG: Pick<
  SettingsDraft,
  | "comic_custom_chat_base_url"
  | "comic_custom_chat_endpoint"
  | "comic_custom_chat_api_key"
  | "comic_custom_chat_model"
  | "comic_custom_chat_body"
> = {
  comic_custom_chat_base_url: "",
  comic_custom_chat_endpoint: "",
  comic_custom_chat_api_key: "",
  comic_custom_chat_model: "",
  comic_custom_chat_body: "",
};

/** 只用到 cfg.get 的「键在就返回原值、缺键才给默认值」这一条，单测里可以换成普通对象。 */
export interface SettingsReader {
  get(key: string, fallback: ConfigValue): ConfigValue | null | undefined;
}

/** 钳到整数区间并取整。 */
export function clampToRange(value: number, range: NumberRange): number {
  return Math.min(range.max, Math.max(range.min, Math.trunc(value)));
}

/** 钳到小数区间（最多保留 2 位小数，用于字号等支持小数的设置）。 */
export function clampDecimalToRange(value: number, range: NumberRange): number {
  const safe = Number.isFinite(value) ? value : range.min;
  const clamped = Math.min(range.max, Math.max(range.min, safe));
  return Math.round(clamped * 100) / 100;
}

/** 解析非负小数输入（如 "9"、"9.5"、"10.25"、".02"）；非法时返回 null。 */
export function parseDecimalInput(text: string | undefined): number | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(trimmed)) return null;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : null;
}

/** 配置里的数值：是有限数值就原样给，其余类型回落到默认值。 */
export function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 配置里的文本：不是字符串就用默认值。 */
export function readText(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** 字体只认下拉框里的项；存了列表外的名字时回落到第一项 JetBrainsMapleMono。 */
export function readFontFamily(value: unknown): string {
  return typeof value === "string" && (FONT_FAMILIES as readonly string[]).includes(value) ? value : FONT_FAMILIES[0];
}

/** 输入框里提交上来的整数文字：只有数字才认，其余返回 null。 */
export function parseDigits(text: string | undefined): number | null {
  if (!text || !/^\d+$/.test(text)) return null;
  return Number(text);
}

/** 页面打开时从配置里读出各字段的初值。 */
export function readSettings(store: SettingsReader): SettingsDraft {
  const text = (
    key:
      | "output_folder"
      | "api_base_url"
      | "api_key"
      | "grsai_site_url"
      | "comic_custom_chat_base_url"
      | "comic_custom_chat_endpoint"
      | "comic_custom_chat_api_key"
      | "comic_custom_chat_model"
      | "comic_custom_chat_body",
  ) => readText(store.get(key, DEFAULT_CONFIG[key]), DEFAULT_CONFIG[key]);
  const number = (
    key:
      | "max_retries"
      | "submit_concurrency"
      | "history_items_per_page"
      | "text_font_size"
      | "pose_watermark_area_ratio"
      | "pose_label_area_ratio",
  ) => readNumber(store.get(key, DEFAULT_CONFIG[key]), DEFAULT_CONFIG[key]);
  return {
    language: normalizeLanguage(store.get("language", DEFAULT_CONFIG.language)),
    theme: normalizeThemeMode(store.get("theme", DEFAULT_CONFIG.theme)),
    accent_color:
      normalizeAccentColor(store.get("accent_color", DEFAULT_CONFIG.accent_color)) ??
      DEFAULT_CONFIG.accent_color.toLowerCase(),
    preview_mode: normalizePreviewMode(store.get("preview_mode", DEFAULT_CONFIG.preview_mode)),
    output_folder: text("output_folder"),
    api_base_url: text("api_base_url"),
    api_key: text("api_key"),
    grsai_site_url: text("grsai_site_url"),
    max_retries: number("max_retries"),
    submit_concurrency: number("submit_concurrency"),
    vip_moderation_auto_retry: Boolean(store.get("vip_moderation_auto_retry", DEFAULT_CONFIG.vip_moderation_auto_retry)),
    history_items_per_page: number("history_items_per_page"),
    text_format_enabled: Boolean(store.get("text_format_enabled", DEFAULT_CONFIG.text_format_enabled)),
    text_font_size: number("text_font_size"),
    text_font_family: readFontFamily(store.get("text_font_family", DEFAULT_CONFIG.text_font_family)),
    text_auto_wrap: Boolean(store.get("text_auto_wrap", DEFAULT_CONFIG.text_auto_wrap)),
    pose_watermark_area_ratio: number("pose_watermark_area_ratio"),
    pose_label_area_ratio: number("pose_label_area_ratio"),
    comic_custom_chat_base_url: text("comic_custom_chat_base_url"),
    comic_custom_chat_endpoint: text("comic_custom_chat_endpoint"),
    comic_custom_chat_api_key: text("comic_custom_chat_api_key"),
    comic_custom_chat_model: text("comic_custom_chat_model"),
    comic_custom_chat_body: text("comic_custom_chat_body"),
  };
}

/** 保存时实际写回的内容。文本去首尾空白，整数与小数字号分别钳到各自区间。 */
export function settingsToSave(draft: SettingsDraft): SettingsDraft {
  return {
    language: normalizeLanguage(draft.language),
    theme: normalizeThemeMode(draft.theme),
    accent_color:
      normalizeAccentColor(draft.accent_color) ?? DEFAULT_CONFIG.accent_color.toLowerCase(),
    preview_mode: normalizePreviewMode(draft.preview_mode),
    output_folder: draft.output_folder.trim() || DEFAULT_CONFIG.output_folder,
    api_base_url: draft.api_base_url.trim(),
    api_key: draft.api_key.trim(),
    grsai_site_url: draft.grsai_site_url.trim() || DEFAULT_CONFIG.grsai_site_url,
    max_retries: clampToRange(draft.max_retries, MAX_RETRIES_RANGE),
    submit_concurrency: clampToRange(draft.submit_concurrency, SUBMIT_CONCURRENCY_RANGE),
    vip_moderation_auto_retry: draft.vip_moderation_auto_retry,
    history_items_per_page: clampToRange(draft.history_items_per_page, HISTORY_ITEMS_RANGE),
    text_format_enabled: draft.text_format_enabled,
    text_font_size: clampDecimalToRange(draft.text_font_size, FONT_SIZE_RANGE),
    text_font_family: readFontFamily(draft.text_font_family),
    text_auto_wrap: draft.text_auto_wrap,
    pose_watermark_area_ratio: clampOpenUnitRatio(
      draft.pose_watermark_area_ratio,
      DEFAULT_CONFIG.pose_watermark_area_ratio,
    ),
    pose_label_area_ratio: clampOpenUnitRatio(
      draft.pose_label_area_ratio,
      DEFAULT_CONFIG.pose_label_area_ratio,
    ),
    comic_custom_chat_base_url: draft.comic_custom_chat_base_url.trim(),
    comic_custom_chat_endpoint: draft.comic_custom_chat_endpoint.trim(),
    comic_custom_chat_api_key: draft.comic_custom_chat_api_key.trim(),
    comic_custom_chat_model: draft.comic_custom_chat_model.trim(),
    comic_custom_chat_body: draft.comic_custom_chat_body.trim(),
  };
}
