import { describe, expect, it } from "vitest";
import type { ConfigValue } from "../core/config";
import { DEFAULT_CONFIG } from "../core/config";
import {
  FONT_FAMILIES,
  FONT_SIZE_RANGE,
  clampDecimalToRange,
  clampToRange,
  parseDecimalInput,
  parseDigits,
  readFontFamily,
  readNumber,
  readSettings,
  readText,
  settingsToSave,
  type SettingsDraft,
  type SettingsReader,
} from "./settingsView";

/** 与 cfg.get 一致的假存储：键在就给原值，缺键才给默认值。 */
function storeOf(data: Record<string, unknown>): SettingsReader {
  return {
    get: (key, fallback) => (Object.prototype.hasOwnProperty.call(data, key) ? (data[key] as ConfigValue | null) : fallback),
  };
}

describe("clampToRange", () => {
  it.each([
    [5, 5],
    [0, 0],
    [100, 100],
    [150, 100],
    [-3, 0],
    [12.9, 12],
    [3.0, 3],
  ])("把 %s 规整成 %s（区间 0 到 100）", (value, expected) => {
    expect(clampToRange(value, { min: 0, max: 100 })).toBe(expected);
  });

  it("区间从 1 起时，0 和负数都落到下限", () => {
    expect(clampToRange(0, { min: 1, max: 10 })).toBe(1);
    expect(clampToRange(-3.5, { min: 1, max: 10 })).toBe(1);
  });
});

describe("clampDecimalToRange & parseDecimalInput", () => {
  it("supports decimal font sizes in range 1..72", () => {
    expect(FONT_SIZE_RANGE).toEqual({ min: 1, max: 72 });
    expect(clampDecimalToRange(9.5, FONT_SIZE_RANGE)).toBe(9.5);
    expect(clampDecimalToRange(0.2, FONT_SIZE_RANGE)).toBe(1);
    expect(clampDecimalToRange(99.9, FONT_SIZE_RANGE)).toBe(72);
    expect(clampDecimalToRange(10.256, FONT_SIZE_RANGE)).toBe(10.26);
    expect(parseDecimalInput("9.5")).toBe(9.5);
    expect(parseDecimalInput(" 12 ")).toBe(12);
    expect(parseDecimalInput("abc")).toBeNull();
    expect(parseDecimalInput("-3")).toBeNull();
  });
});

describe("readNumber", () => {
  it("数值原样给出，越界的也不动", () => {
    expect(readNumber(150, 5)).toBe(150);
    expect(readNumber(9.5, 5)).toBe(9.5);
  });

  it.each(["12", null, undefined, true, Number.NaN, Number.POSITIVE_INFINITY])("存的是 %s 时回落到默认值", (value) => {
    expect(readNumber(value, 5)).toBe(5);
  });
});

describe("readText", () => {
  it("字符串原样给出，连首尾空白一起保留", () => {
    expect(readText("  a  ", "x")).toBe("  a  ");
  });

  it.each([null, 5, true])("存的是 %s 时回落到默认值", (value) => {
    expect(readText(value, "x")).toBe("x");
  });
});

describe("readFontFamily", () => {
  it("列表里的字体保持不变", () => {
    for (const family of FONT_FAMILIES) expect(readFontFamily(family)).toBe(family);
  });

  it.each(["Segoe UI", "arial", "", 123, null])("存的是 %s 时落在第一项 JetBrainsMapleMono", (value) => {
    expect(readFontFamily(value)).toBe("JetBrainsMapleMono");
  });
});

describe("parseDigits", () => {
  it.each([
    ["12", 12],
    ["007", 7],
    ["0", 0],
  ])("%s 解析成 %s", (text, expected) => {
    expect(parseDigits(text)).toBe(expected);
  });

  it.each(["", undefined, "12a", "-3", "1.5", " 12", "１２"])("%s 不认", (text) => {
    expect(parseDigits(text)).toBeNull();
  });
});

describe("readSettings", () => {
  it("配置是空的时候每一项都是默认值", () => {
    expect(readSettings(storeOf({}))).toEqual({
      language: DEFAULT_CONFIG.language,
      theme: DEFAULT_CONFIG.theme,
      accent_color: DEFAULT_CONFIG.accent_color.toLowerCase(),
      preview_mode: DEFAULT_CONFIG.preview_mode,
      output_folder: DEFAULT_CONFIG.output_folder,
      api_base_url: DEFAULT_CONFIG.api_base_url,
      api_key: DEFAULT_CONFIG.api_key,
      grsai_site_url: DEFAULT_CONFIG.grsai_site_url,
      max_retries: DEFAULT_CONFIG.max_retries,
      submit_concurrency: DEFAULT_CONFIG.submit_concurrency,
      vip_moderation_auto_retry: DEFAULT_CONFIG.vip_moderation_auto_retry,
      history_items_per_page: DEFAULT_CONFIG.history_items_per_page,
      text_format_enabled: DEFAULT_CONFIG.text_format_enabled,
      text_font_size: DEFAULT_CONFIG.text_font_size,
      text_font_family: DEFAULT_CONFIG.text_font_family,
      text_auto_wrap: DEFAULT_CONFIG.text_auto_wrap,
      pose_watermark_area_ratio: DEFAULT_CONFIG.pose_watermark_area_ratio,
      pose_label_area_ratio: DEFAULT_CONFIG.pose_label_area_ratio,
      comic_custom_chat_base_url: DEFAULT_CONFIG.comic_custom_chat_base_url,
      comic_custom_chat_endpoint: DEFAULT_CONFIG.comic_custom_chat_endpoint,
      comic_custom_chat_api_key: DEFAULT_CONFIG.comic_custom_chat_api_key,
      comic_custom_chat_model: DEFAULT_CONFIG.comic_custom_chat_model,
      comic_custom_chat_body: DEFAULT_CONFIG.comic_custom_chat_body,
    });
  });

  it("所有设置页字段（含语言、主题、主题色、预览方式、输出文件夹）统一进草稿", () => {
    const draft = readSettings(
      storeOf({
        language: "zh",
        theme: "dark",
        accent_color: "#FF00AA",
        preview_mode: "system",
        output_folder: "D:/out",
      }),
    );
    expect(draft.language).toBe("zh");
    expect(draft.theme).toBe("dark");
    expect(draft.accent_color).toBe("#ff00aa");
    expect(draft.preview_mode).toBe("system");
    expect(draft.output_folder).toBe("D:/out");
  });

  it("数值位存了字符串或 null 时回落到默认值，不让整页打不开", () => {
    const draft = readSettings(storeOf({ max_retries: "12", text_font_size: null, history_items_per_page: "5" }));
    expect(draft.max_retries).toBe(DEFAULT_CONFIG.max_retries);
    expect(draft.text_font_size).toBe(DEFAULT_CONFIG.text_font_size);
    expect(draft.history_items_per_page).toBe(DEFAULT_CONFIG.history_items_per_page);
  });

  it("字体不在下拉框列表里时显示第一项", () => {
    expect(readSettings(storeOf({ text_font_family: "Segoe UI" })).text_font_family).toBe("JetBrainsMapleMono");
    expect(readSettings(storeOf({ text_font_family: "KaiTi" })).text_font_family).toBe("KaiTi");
  });
});

describe("settingsToSave", () => {
  const touched: SettingsDraft = {
    language: "zh",
    theme: "dark",
    accent_color: "#0078D4",
    preview_mode: "system",
    output_folder: "  D:/custom-out  ",
    api_base_url: "  https://example.invalid/base  ",
    api_key: "  probe  ",
    grsai_site_url: "  https://grsai.com/  ",
    max_retries: 150,
    submit_concurrency: 0,
    vip_moderation_auto_retry: true,
    history_items_per_page: 0,
    text_format_enabled: false,
    text_font_size: 9.5,
    text_font_family: "KaiTi",
    text_auto_wrap: false,
    pose_watermark_area_ratio: 0.02555,
    pose_label_area_ratio: 0,
    comic_custom_chat_base_url: "  https://api.example.invalid/v1  ",
    comic_custom_chat_endpoint: "  /chat/completions  ",
    comic_custom_chat_api_key: "  k-test  ",
    comic_custom_chat_model: "  gpt-4o  ",
    comic_custom_chat_body: '  {"temperature":0.7}  ',
  };

  it("文本去掉首尾空白，整数钳到区间，字号保留小数并钳在 1..72", () => {
    expect(settingsToSave(touched)).toEqual({
      language: "zh",
      theme: "dark",
      accent_color: "#0078d4",
      preview_mode: "system",
      output_folder: "D:/custom-out",
      api_base_url: "https://example.invalid/base",
      api_key: "probe",
      grsai_site_url: "https://grsai.com/",
      max_retries: 100,
      submit_concurrency: 1,
      vip_moderation_auto_retry: true,
      history_items_per_page: 1,
      text_format_enabled: false,
      text_font_size: 9.5,
      text_font_family: "KaiTi",
      text_auto_wrap: false,
      pose_watermark_area_ratio: 0.0256,
      pose_label_area_ratio: 0.0001,
      comic_custom_chat_base_url: "https://api.example.invalid/v1",
      comic_custom_chat_endpoint: "/chat/completions",
      comic_custom_chat_api_key: "k-test",
      comic_custom_chat_model: "gpt-4o",
      comic_custom_chat_body: '{"temperature":0.7}',
    });
  });

  it("没改过的草稿保存后原样写回，不改动任何值", () => {
    const draft = readSettings(storeOf({}));
    expect(settingsToSave(draft)).toEqual(draft);
  });

  it("字号越界时钳到 1..72，字体非法时落到第一项，面积占比钳到 (0, 1) 四位小数", () => {
    expect(settingsToSave({ ...touched, text_font_size: 0.2 }).text_font_size).toBe(1);
    expect(settingsToSave({ ...touched, text_font_size: 120.5 }).text_font_size).toBe(72);
    expect(settingsToSave({ ...touched, text_font_family: "Segoe UI" }).text_font_family).toBe("JetBrainsMapleMono");
    expect(settingsToSave({ ...touched, pose_watermark_area_ratio: 1 }).pose_watermark_area_ratio).toBe(0.9999);
    expect(settingsToSave({ ...touched, pose_label_area_ratio: -0.2 }).pose_label_area_ratio).toBe(0.0001);
  });
});
