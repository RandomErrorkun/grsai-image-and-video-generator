import { describe, expect, it } from "vitest";
import type { ConfigValue } from "../core/config";
import { DEFAULT_CONFIG } from "../core/config";
import {
  FONT_FAMILIES,
  clampToRange,
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

describe("readNumber", () => {
  it("数值原样给出，越界的也不动", () => {
    expect(readNumber(150, 5)).toBe(150);
    expect(readNumber(12.5, 5)).toBe(12.5);
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

  it.each(["Segoe UI", "arial", "", 123, null])("存的是 %s 时落在第一项 Arial", (value) => {
    expect(readFontFamily(value)).toBe("Arial");
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
      api_base_url: DEFAULT_CONFIG.api_base_url,
      api_key: DEFAULT_CONFIG.api_key,
      max_retries: DEFAULT_CONFIG.max_retries,
      submit_concurrency: DEFAULT_CONFIG.submit_concurrency,
      vip_moderation_auto_retry: DEFAULT_CONFIG.vip_moderation_auto_retry,
      history_items_per_page: DEFAULT_CONFIG.history_items_per_page,
      text_format_enabled: DEFAULT_CONFIG.text_format_enabled,
      text_font_size: DEFAULT_CONFIG.text_font_size,
      text_font_family: DEFAULT_CONFIG.text_font_family,
      text_auto_wrap: DEFAULT_CONFIG.text_auto_wrap,
    });
  });

  it("存了什么就显示什么：越界的数值照实给出，文本的首尾空白也留着", () => {
    const draft = readSettings(
      storeOf({
        api_base_url: "  https://example.invalid  ",
        api_key: "  probe  ",
        max_retries: 150,
        submit_concurrency: 0,
        history_items_per_page: 0,
        text_font_size: 200,
      }),
    );
    expect(draft.api_base_url).toBe("  https://example.invalid  ");
    expect(draft.api_key).toBe("  probe  ");
    expect(draft.max_retries).toBe(150);
    expect(draft.submit_concurrency).toBe(0);
    expect(draft.history_items_per_page).toBe(0);
    expect(draft.text_font_size).toBe(200);
  });

  it("不读输出文件夹：它选完就生效，不进草稿", () => {
    expect(readSettings(storeOf({ output_folder: "D:/out" }))).not.toHaveProperty("output_folder");
  });

  it("数值位存了字符串或 null 时回落到默认值，不让整页打不开", () => {
    const draft = readSettings(storeOf({ max_retries: "12", text_font_size: null, history_items_per_page: "5" }));
    expect(draft.max_retries).toBe(DEFAULT_CONFIG.max_retries);
    expect(draft.text_font_size).toBe(DEFAULT_CONFIG.text_font_size);
    expect(draft.history_items_per_page).toBe(DEFAULT_CONFIG.history_items_per_page);
  });

  it("文本位存了别的类型时回落到默认值", () => {
    const draft = readSettings(storeOf({ api_base_url: 123, api_key: null }));
    expect(draft.api_base_url).toBe(DEFAULT_CONFIG.api_base_url);
    expect(draft.api_key).toBe("");
  });

  it("开关按真值取", () => {
    const on = readSettings(storeOf({ vip_moderation_auto_retry: 1, text_format_enabled: true, text_auto_wrap: "x" }));
    expect(on.vip_moderation_auto_retry).toBe(true);
    expect(on.text_format_enabled).toBe(true);
    expect(on.text_auto_wrap).toBe(true);
    const off = readSettings(storeOf({ vip_moderation_auto_retry: 0, text_format_enabled: null }));
    expect(off.vip_moderation_auto_retry).toBe(false);
    expect(off.text_format_enabled).toBe(false);
  });

  it("字体不在下拉框的八项里时显示第一项", () => {
    expect(readSettings(storeOf({ text_font_family: "Segoe UI" })).text_font_family).toBe("Arial");
    expect(readSettings(storeOf({ text_font_family: "KaiTi" })).text_font_family).toBe("KaiTi");
  });
});

describe("settingsToSave", () => {
  const touched: SettingsDraft = {
    api_base_url: "  https://example.invalid/base  ",
    api_key: "  probe  ",
    max_retries: 150,
    submit_concurrency: 0,
    vip_moderation_auto_retry: true,
    history_items_per_page: 0,
    text_format_enabled: false,
    text_font_size: 200,
    text_font_family: "KaiTi",
    text_auto_wrap: false,
  };

  it("十个键一个不少，也没有输出文件夹", () => {
    const keys = Object.keys(settingsToSave(touched)).sort();
    expect(keys).toEqual(Object.keys(touched).sort());
    expect(keys).not.toContain("output_folder");
  });

  it("文本去掉首尾空白，数值钳到各自的区间", () => {
    expect(settingsToSave(touched)).toEqual({
      api_base_url: "https://example.invalid/base",
      api_key: "probe",
      max_retries: 100,
      submit_concurrency: 1,
      vip_moderation_auto_retry: true,
      history_items_per_page: 1,
      text_format_enabled: false,
      text_font_size: 72,
      text_font_family: "KaiTi",
      text_auto_wrap: false,
    });
  });

  it("没改过的草稿保存后原样写回，不改动任何值", () => {
    const draft = readSettings(storeOf({}));
    expect(settingsToSave(draft)).toEqual(draft);
  });

  it("数值只升不降时各自落在上限", () => {
    const saved = settingsToSave({ ...readSettings(storeOf({})), max_retries: 101, submit_concurrency: 11, history_items_per_page: 500, text_font_size: 72.9 });
    expect(saved.max_retries).toBe(100);
    expect(saved.submit_concurrency).toBe(10);
    expect(saved.history_items_per_page).toBe(100);
    expect(saved.text_font_size).toBe(72);
  });

  it("字体位被改成列表外的名字时写回第一项", () => {
    expect(settingsToSave({ ...touched, text_font_family: "Segoe UI" }).text_font_family).toBe("Arial");
  });
});
