import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, createConfigStore, type ConfigStore, type ConfigValue } from "../core/config";
import type { HistoryTask } from "../core/history";
import {
  changeModel,
  changeTab,
  initialState,
  modelControls,
  parallelTasksOf,
  refImagesOf,
  restoreTask,
  taskCount,
  taskParams,
} from "./generatorView";

/** 内存里的配置：读不到文件、写也不落盘，其余和真的一样。 */
function config(values: Record<string, ConfigValue> = {}): ConfigStore {
  const store = createConfigStore({ read: () => null, write() {} });
  Object.assign(store.data, values);
  return store;
}

function historyTask(overrides: Partial<HistoryTask> = {}): HistoryTask {
  return {
    id: "t-1",
    prompt: "a red apple",
    model: "nano-banana-pro",
    aspect_ratio: "16:9",
    image_size: "2K",
    ref_images: null,
    duration: null,
    seed: null,
    ref_audios: null,
    first_frame: null,
    last_frame: null,
    ref_videos: null,
    ref_video_options: null,
    status: "succeeded",
    created_at: "2026-11-25 01:21:29",
    result_path: null,
    preview_url: null,
    failure_reason: null,
    error_message: null,
    updated_at: "2026-11-25 01:21:29",
    ...overrides,
  };
}

describe("generatorView", () => {
  it("starts on the last tab with the model it remembers", () => {
    const remembered = config({ last_tab: "gpt_image", last_model_tab_gpt_image: "sora-image" });
    expect(initialState(remembered)).toMatchObject({ tab: "gpt_image", model: "gpt-image-2", gptRatio: "auto" });

    // 旧模型名换成现行的；清单外的模型用该选项卡的第一个
    const stale = config({ last_tab: "banana_pro", last_model_tab_banana_pro: "no-such-model" });
    expect(initialState(stale)).toMatchObject({ tab: "banana_pro", model: "nano-banana" });
    expect(initialState(config({ last_tab: "junk" })).tab).toBe("banana_pro");
  });

  it("restores the remembered values when the tab or the model changes", () => {
    const cfg = config({
      last_model_tab_gpt_image: "gpt-image-2-vip",
      gpt_image_size: "1:3",
      gpt_image_tier: "4K",
      gpt_image_quality: "high",
      gpt_transparent_background: true,
    });
    let state = changeTab(initialState(cfg), "gpt_image", cfg);
    expect(cfg.get("last_tab", "")).toBe("gpt_image");
    expect(state).toMatchObject({ model: "gpt-image-2-vip", gptRatio: "1:3", tier: "4K", quality: "high", transparent: true });

    // 记住的比例不在另一个模型的选项里（1:3 只有 vip 系有）就落到第一项
    state = changeModel(state, "gpt-image-2", cfg);
    expect(state).toMatchObject({ model: "gpt-image-2", gptRatio: "auto" });
    expect(cfg.get("last_model_tab_gpt_image", "")).toBe("gpt-image-2");

    // 换回来还是它自己的那份
    state = changeModel(state, "gpt-image-2-vip", cfg);
    expect(state).toMatchObject({ gptRatio: "1:3", tier: "4K", quality: "high" });
  });

  it("shows only the controls the catalog entry offers", () => {
    expect(modelControls("nano-banana-2")).toEqual({
      quality: false,
      tier: false,
      transparent: false,
      format: false,
      vip: false,
    });
    expect(modelControls("gpt-image-2")).toMatchObject({ quality: false, tier: false, transparent: false });
    expect(modelControls("gpt-image-2-vip")).toMatchObject({
      quality: true,
      tier: true,
      transparent: true,
      format: false,
      vip: true,
    });
    expect(modelControls("gpt-image-2.6-flare")).toMatchObject({ quality: true, tier: true, format: true, vip: false });
    expect(modelControls("gpt-image-2.6")).toMatchObject({ quality: false, tier: false, format: true });
    expect(modelControls("nano-banana-pro-cl")).toMatchObject({ vip: true });
  });

  it("builds task params the way the source does and remembers them", () => {
    const cfg = config();
    let state = changeModel(initialState(cfg), "nano-banana-2", cfg);
    state = { ...state, ratio: "1:4", size: "4K" };
    expect(taskParams(state, cfg)).toEqual({
      model: "nano-banana-2",
      aspectRatio: "1:4",
      imageSize: "4K",
      quality: null,
      background: null,
      outputFormat: null,
    });
    expect(cfg.get("nano_banana_aspect_ratio", "")).toBe("1:4");
    expect(cfg.get("nano_banana_image_size", "")).toBe("4K");

    // GPT Image 系：比例存进 imageSize，质量只有一个档位时不带
    state = { ...changeTab(state, "gpt_image", cfg), gptRatio: "21:9" };
    expect(taskParams(state, cfg)).toEqual({
      model: "gpt-image-2",
      aspectRatio: "21:9",
      imageSize: "21:9",
      quality: null,
      background: null,
      outputFormat: null,
    });
    expect(cfg.get("gpt_image_size", "")).toBe("21:9");

    // 只收像素值的模型：比例按档位换算成像素
    state = { ...changeModel(state, "gpt-image-2-vip", cfg), gptRatio: "16:9", tier: "4K", quality: "low", transparent: true };
    expect(taskParams(state, cfg)).toMatchObject({
      model: "gpt-image-2-vip",
      aspectRatio: "3840x2160",
      imageSize: "16:9",
      quality: "low",
      background: "transparent",
    });
    expect(cfg.get("gpt_image_tier", "")).toBe("4K");
    expect(cfg.get("gpt_transparent_background", false)).toBe(true);

    // 输出格式只在接口给这个参数的模型上带；记录的值不在选项里落到第一项。
    // 两个 2.6 变体的第一项是 png（GPT Image 接口文档，2026-11-25 核对），源项目记的是只有 gif
    state = changeModel(state, "gpt-image-2.6-flare", cfg);
    expect(state.format).toBe("png");
    expect(taskParams(state, cfg)).toMatchObject({ outputFormat: "png" });
    expect(cfg.get("gpt_image_output_format", "")).toBe("png");
  });

  it("submits as many tasks as the parallel count, and at least one", () => {
    expect(taskCount(1)).toBe(1);
    expect(taskCount(3)).toBe(3);
    expect(taskCount(0)).toBe(1);
  });

  it("keeps the parallel count inside the slider range", () => {
    expect(parallelTasksOf(1)).toBe(1);
    expect(parallelTasksOf(50)).toBe(10);
    expect(parallelTasksOf("3")).toBe(DEFAULT_CONFIG.parallel_tasks);
  });

  it("fills a history task back in without changing the saved params", () => {
    const cfg = config();
    let state = changeTab(initialState(cfg), "gpt_image", cfg);
    // 先切到模型所在的选项卡，再按记录改比例和尺寸
    state = restoreTask(state, historyTask(), cfg);
    expect(state).toMatchObject({ tab: "banana_pro", model: "nano-banana-pro", ratio: "16:9", size: "2K" });
    expect(cfg.get("last_tab", "")).toBe("banana_pro");
    expect(cfg.get("nano_banana_aspect_ratio", "")).toBe(DEFAULT_CONFIG.nano_banana_aspect_ratio);

    // 旧模型名换成现行的；GPT 系的比例取自 image_size 列
    state = restoreTask(state, historyTask({ model: "sora-image", aspect_ratio: "auto", image_size: "9:16" }), cfg);
    expect(state).toMatchObject({ tab: "gpt_image", model: "gpt-image-2", gptRatio: "9:16" });

    // 记录里的尺寸不在该模型的选项里就保持前一步恢复出来的
    state = restoreTask(state, historyTask({ model: "nano-banana-2-lite" }), cfg);
    expect(state).toMatchObject({ tab: "banana_pro", model: "nano-banana-2-lite", ratio: "16:9", size: "1K" });
  });

  it("reads reference images from old and new records alike", () => {
    expect(refImagesOf(historyTask({ ref_images: "C:/a.png" }))).toEqual(["C:/a.png"]);
    expect(refImagesOf(historyTask({ ref_images: ["C:/a.png", "C:/b.png"] }))).toEqual(["C:/a.png", "C:/b.png"]);
    expect(refImagesOf(historyTask({ ref_images: [] }))).toEqual([]);
    expect(refImagesOf(historyTask())).toEqual([]);
  });
});
