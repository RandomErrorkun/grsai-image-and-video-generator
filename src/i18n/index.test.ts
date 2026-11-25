import { afterEach, describe, expect, it, vi } from "vitest";
import en from "./en.json";
import zh from "./zh.json";
import {
  languageItems,
  normalizeLanguage,
  setLanguage,
  subscribeLanguage,
  tr,
  translate,
} from "./index";

afterEach(() => {
  setLanguage("en");
});

describe("translation tables", () => {
  it("gives both languages the same keys: the 187 inherited from the source project plus the rewrite's own", () => {
    expect(Object.keys(zh)).toEqual(Object.keys(en));
    // 重写版自己追加的键：外壳 15 个，任务状态和提交并发设置 6 个，历史页和素材区 4 个
    expect(Object.keys(en)).toHaveLength(212);
    for (const value of [...Object.values(en), ...Object.values(zh)]) {
      expect(typeof value).toBe("string");
    }
  });

  it("keeps a few source strings verbatim", () => {
    expect(en["drop.placeholder"]).toBe(
      "Drag & Drop Images Here\n(Max {max})\nOr Click to Select\n(Ctrl+V to Paste)",
    );
    expect(zh["generator.generate"]).toBe("开始生成");
    expect(en["nav.toggle_theme"]).toBe("Toggle Theme");
    expect(zh["nav.toggle_theme"]).toBe("切换主题");
  });
});

describe("translate", () => {
  it("looks up the requested language, then English, then falls back to the key", () => {
    expect(translate("zh", "nav.generator")).toBe("生成");
    expect(translate("en", "nav.generator")).toBe("Generator");
    expect(translate("zh", "no.such.key")).toBe("no.such.key");
    expect(translate("en", "no.such.key")).toBe("no.such.key");
  });

  it("fills placeholders like str.format", () => {
    expect(translate("en", "drop.msg.limit_skipped", { max: 14, count: 3 })).toBe(
      "Maximum 14 images allowed. 3 image(s) were skipped.",
    );
    expect(translate("zh", "comic.page_label", { page: 2 })).toBe("第 2 页");
    expect(translate("en", "comic.project_saved", { name: "demo" })).toBe(
      "Project 'demo' has been saved.",
    );
    // str() 的写法：布尔值首字母大写
    expect(translate("en", "settings.vip_retry.models", { models: true })).toBe(
      "Current VIP models: True",
    );
  });

  it("returns the raw template when a placeholder cannot be resolved", () => {
    const raw = en["drop.msg.limit_skipped"];
    expect(translate("en", "drop.msg.limit_skipped", { max: 14 })).toBe(raw);
    expect(translate("en", "drop.msg.limit_skipped", { count: 3 })).toBe(raw);
  });

  it("skips formatting when no arguments are given", () => {
    expect(translate("en", "history.refresh")).toBe("Refresh");
    expect(translate("en", "history.refresh", {})).toBe("Refresh");
    expect(translate("en", "drop.msg.limit_reached")).toBe(en["drop.msg.limit_reached"]);
  });
});

describe("normalizeLanguage", () => {
  it("treats anything starting with zh as Chinese and everything else as English", () => {
    expect(normalizeLanguage("zh")).toBe("zh");
    expect(normalizeLanguage("zh-CN")).toBe("zh");
    expect(normalizeLanguage("ZH")).toBe("zh");
    expect(normalizeLanguage("en")).toBe("en");
    expect(normalizeLanguage("en-US")).toBe("en");
    expect(normalizeLanguage("")).toBe("en");
    expect(normalizeLanguage(null)).toBe("en");
    expect(normalizeLanguage(undefined)).toBe("en");
    expect(normalizeLanguage(123)).toBe("en");
  });
});

describe("current language", () => {
  it("makes tr() and languageItems() follow the current language", () => {
    expect(tr("nav.video")).toBe("Video");
    expect(languageItems()).toEqual([
      { code: "en", label: "English" },
      { code: "zh", label: "简体中文" },
    ]);

    setLanguage("zh");
    expect(tr("nav.video")).toBe("视频");
    expect(languageItems()[0]).toEqual({ code: "en", label: "English" });

    setLanguage("en");
    expect(tr("nav.video")).toBe("Video");
  });

  it("notifies subscribers only on an actual change", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLanguage(listener);

    setLanguage("en");
    expect(listener).not.toHaveBeenCalled();

    setLanguage("zh");
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    setLanguage("en");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
