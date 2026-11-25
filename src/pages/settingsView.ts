/**
 * 设置页的纯逻辑（对应 ui/settings_page.py 里各控件取初值和保存的那几行）。
 * 页面上只有语言、主题、主题色即时生效，输出文件夹选完也立刻写回；
 * 其余字段都是草稿，点了保存才写回配置。
 */
import { DEFAULT_CONFIG, type AppConfig, type ConfigValue } from "../core/config";

/** 字体下拉框的固定选项，与源项目的 addItems 一致，顺序也一样。 */
export const FONT_FAMILIES = ["Arial", "Courier New", "Times New Roman", "Verdana", "Georgia", "SimSun", "SimHei", "KaiTi"] as const;

export interface NumberRange {
  readonly min: number;
  readonly max: number;
}

/**
 * 数值字段的区间。前三个与源项目滑块的 setRange 一致；
 * 提交并发数是重写版新增的，手册没给区间，这里取 1 到 10。
 */
export const MAX_RETRIES_RANGE: NumberRange = { min: 0, max: 100 };
export const SUBMIT_CONCURRENCY_RANGE: NumberRange = { min: 1, max: 10 };
export const HISTORY_ITEMS_RANGE: NumberRange = { min: 1, max: 100 };
export const FONT_SIZE_RANGE: NumberRange = { min: 8, max: 72 };

/** 保存时写回配置的那部分键；页面上的草稿也是这个形状。输出文件夹不在这里：它选完就生效，保存从不碰它。 */
export type SettingsDraft = Pick<
  AppConfig,
  | "api_base_url"
  | "api_key"
  | "max_retries"
  | "submit_concurrency"
  | "vip_moderation_auto_retry"
  | "history_items_per_page"
  | "text_format_enabled"
  | "text_font_size"
  | "text_font_family"
  | "text_auto_wrap"
>;

/** 只用到 cfg.get 的「键在就返回原值、缺键才给默认值」这一条，单测里可以换成普通对象。 */
export interface SettingsReader {
  get(key: string, fallback: ConfigValue): ConfigValue | null | undefined;
}

/** 钳到区间内并取整：源项目的滑块只认整数。 */
export function clampToRange(value: number, range: NumberRange): number {
  return Math.min(range.max, Math.max(range.min, Math.trunc(value)));
}

/**
 * 配置里的数值：是有限数值就原样给，越界的也照实显示，留到保存时再钳
 * （源项目的滑块停在上限，旁边的数字却还是原值）。
 * 其余类型回落到默认值：源项目遇到字符串或 null 会在构造页面时抛异常，这里不能让整页打不开。
 */
export function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 配置里的文本：不是字符串就用默认值（源项目同样会在构造时抛异常）。 */
export function readText(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * 字体只认下拉框里的八项。存了列表外的名字时源项目的下拉框停在第一项，
 * 保存后也就写成第一项，这里保持一致。
 */
export function readFontFamily(value: unknown): string {
  return typeof value === "string" && (FONT_FAMILIES as readonly string[]).includes(value) ? value : FONT_FAMILIES[0];
}

/** 输入框里提交上来的文字：只有数字才认，其余（空、夹着别的字符）返回 null。 */
export function parseDigits(text: string | undefined): number | null {
  if (!text || !/^\d+$/.test(text)) return null;
  return Number(text);
}

/** 页面打开时从配置里读出各字段的初值。开关按真值取，与页面外读取这些键的地方一致。 */
export function readSettings(store: SettingsReader): SettingsDraft {
  const text = (key: "api_base_url" | "api_key") => readText(store.get(key, DEFAULT_CONFIG[key]), DEFAULT_CONFIG[key]);
  const number = (key: "max_retries" | "submit_concurrency" | "history_items_per_page" | "text_font_size") =>
    readNumber(store.get(key, DEFAULT_CONFIG[key]), DEFAULT_CONFIG[key]);
  return {
    api_base_url: text("api_base_url"),
    api_key: text("api_key"),
    max_retries: number("max_retries"),
    submit_concurrency: number("submit_concurrency"),
    vip_moderation_auto_retry: Boolean(store.get("vip_moderation_auto_retry", DEFAULT_CONFIG.vip_moderation_auto_retry)),
    history_items_per_page: number("history_items_per_page"),
    text_format_enabled: Boolean(store.get("text_format_enabled", DEFAULT_CONFIG.text_format_enabled)),
    text_font_size: number("text_font_size"),
    text_font_family: readFontFamily(store.get("text_font_family", DEFAULT_CONFIG.text_font_family)),
    text_auto_wrap: Boolean(store.get("text_auto_wrap", DEFAULT_CONFIG.text_auto_wrap)),
  };
}

/**
 * 保存时实际写回的内容。两个文本去掉首尾空白（源项目保存前先 strip），数值钳到区间。
 * 输出文件夹不在这里：源项目的 save_settings 从不写它。
 */
export function settingsToSave(draft: SettingsDraft): SettingsDraft {
  return {
    api_base_url: draft.api_base_url.trim(),
    api_key: draft.api_key.trim(),
    max_retries: clampToRange(draft.max_retries, MAX_RETRIES_RANGE),
    submit_concurrency: clampToRange(draft.submit_concurrency, SUBMIT_CONCURRENCY_RANGE),
    vip_moderation_auto_retry: draft.vip_moderation_auto_retry,
    history_items_per_page: clampToRange(draft.history_items_per_page, HISTORY_ITEMS_RANGE),
    text_format_enabled: draft.text_format_enabled,
    text_font_size: clampToRange(draft.text_font_size, FONT_SIZE_RANGE),
    text_font_family: readFontFamily(draft.text_font_family),
    text_auto_wrap: draft.text_auto_wrap,
  };
}
