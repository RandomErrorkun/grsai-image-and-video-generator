import { describe, expect, it } from "vitest";
import { createConfigStore, type ConfigStore, type ConfigValue } from "../core/config";
import type { HistoryTask } from "../core/history";
import {
  changeModel,
  changeResolution,
  clampDuration,
  initialState,
  parallelTasksOf,
  parseSeed,
  refAudiosOf,
  refModeOf,
  restoreTask,
  taskParams,
  aspectLabelKey,
} from "./videoView";

/** 内存里的配置：读不到文件、写也不落盘，其余和真的一样。 */
function config(values: Record<string, ConfigValue> = {}): ConfigStore {
  const store = createConfigStore({ read: () => null, write() {} });
  Object.assign(store.data, values);
  return store;
}

function historyTask(overrides: Partial<HistoryTask> = {}): HistoryTask {
  return {
    id: "t-1",
    prompt: "a walking robot",
    model: "wan-3.0",
    aspect_ratio: "16:9",
    image_size: "720p",
    ref_images: null,
    duration: 5,
    seed: null,
    ref_audios: null,
    first_frame: null,
    last_frame: null,
    ref_videos: null,
    status: "succeeded",
    created_at: "2026-11-25 01:24:11",
    result_path: null,
    preview_url: null,
    failure_reason: null,
    error_message: null,
    updated_at: "2026-11-25 01:24:11",
    ...overrides,
  };
}

describe("videoView", () => {
  it("starts on the last model with the parameters it remembers", () => {
    const remembered = config({
      video_last_model: "agnes-video-2.5",
      agnes_video_aspect_ratio: "9:16",
      agnes_video_resolution: "2k",
      agnes_video_duration: 9,
    });
    expect(initialState(remembered)).toEqual({ model: "agnes-video-2.5", aspect: "9:16", resolution: "2k", duration: 9 });

    // 认不出的模型用第一个；值不在该模型的选项里就落到它的默认值，时长读不出来按 5
    const stale = config({
      video_last_model: "no-such-model",
      video_aspect_ratio: "1:1",
      video_resolution: "4k",
      video_duration: "abc",
    });
    expect(initialState(stale)).toEqual({ model: "minimax-h3", aspect: "landscape", resolution: "480p", duration: 5 });
    // 键在、值是 null（JSON 的 null 原样读进来）也算认不出
    const nulled = config();
    Object.assign(nulled.data, { video_last_model: null });
    expect(initialState(nulled).model).toBe("minimax-h3");
  });

  it("restores each model's remembered values when the model changes", () => {
    const cfg = config({
      video_resolution: "1080p",
      video_duration: 15,
      wan_video_resolution: "1080p",
      wan_video_duration: 40,
    });
    let state = initialState(cfg);
    expect(state).toMatchObject({ model: "minimax-h3", resolution: "1080p", duration: 10 });

    // 换模型时时长只按模型的范围和记住的分辨率的上限收，不提示
    state = changeModel(state, "wan-3.0", cfg);
    expect(state).toMatchObject({ aspect: "16:9", resolution: "1080p", duration: 30 });
    state = changeModel(state, "minimax-h3", cfg);
    expect(state).toMatchObject({ aspect: "landscape", resolution: "1080p", duration: 10 });
    // 换模型不写配置：上次的模型只在生成时记
    cfg.set("video_last_model", "agnes-video-2.5");
    changeModel(state, "wan-3.0", cfg);
    expect(cfg.get("video_last_model", "")).toBe("agnes-video-2.5");
  });

  it("keeps a model without config keys in one JSON entry", () => {
    const cfg = config();
    // 清单里暂时没有这样的模型：认不出条目的模型按 minimax-h3 的选项走，参数记在一条 JSON 里
    let state = changeModel(initialState(cfg), "future-video", cfg);
    expect(state).toMatchObject({ model: "future-video", aspect: "landscape", resolution: "480p", duration: 5 });

    const params = taskParams({ ...state, aspect: "square", resolution: "768p", duration: 8 }, "", cfg);
    expect(params).toEqual({ model: "future-video", aspectRatio: "square", imageSize: "768p", duration: 8, seed: null });
    expect(JSON.parse(String(cfg.get("video_model_params_future-video", "")))).toEqual({
      aspect: "square",
      resolution: "768p",
      duration: 8,
    });
    expect(changeModel(state, "future-video", cfg)).toMatchObject({ aspect: "square", resolution: "768p", duration: 8 });

    // 存坏了按没存过处理
    cfg.set("video_model_params_future-video", "{not json");
    expect(changeModel(state, "future-video", cfg)).toMatchObject({ aspect: "landscape", resolution: "480p", duration: 5 });
  });

  it("caps the duration when a resolution lowers the limit", () => {
    const state = initialState(config({ video_resolution: "480p", video_duration: 15 }));
    expect(changeResolution(state, "1080p")).toEqual({
      state: { ...state, resolution: "1080p", duration: 10 },
      cappedAt: 10,
    });
    // 不超过上限时只换分辨率
    expect(changeResolution({ ...state, duration: 4 }, "1080p")).toEqual({
      state: { ...state, resolution: "1080p", duration: 4 },
      cappedAt: null,
    });
    // agnes-video-2.5 的时长与分辨率无关
    const agnes = changeModel(state, "agnes-video-2.5", config());
    expect(changeResolution(agnes, "2k").cappedAt).toBeNull();

    // 时长输入框的范围就是模型的时长范围
    expect(clampDuration("agnes-video-2.5", 1)).toBe(4);
    expect(clampDuration("agnes-video-2.5", 99)).toBe(12);
    expect(clampDuration("minimax-h3", 7.9)).toBe(7);
  });

  it("takes the task parameters and remembers them", () => {
    const cfg = config();
    const state = changeModel(initialState(cfg), "wan-3.0", cfg);

    // 种子留空是 null；其余按 Python 的 int() 解析
    expect(taskParams(state, "", cfg)).toMatchObject({ seed: null });
    expect(taskParams(state, "  +42 ", cfg)).toMatchObject({ seed: 42 });
    expect(taskParams(state, "-3", cfg)).toMatchObject({ seed: -3 });
    expect(cfg.get("video_last_model", "")).toBe("wan-3.0");
    expect(cfg.get("wan_video_duration", 0)).toBe(5);

    // 解不出整数：什么都不写
    const before = { ...cfg.data };
    expect(taskParams(state, "3.5", cfg)).toBe("seed_invalid");
    expect(taskParams(state, "abc", cfg)).toBe("seed_invalid");
    expect(cfg.data).toEqual(before);
    expect(parseSeed("abc")).toBe("invalid");
  });

  it("clamps the duration to the limit of the current resolution", () => {
    // 从历史恢复来的时长可以高于分辨率的上限（输入框只受模型的上下限约束），提交时再收
    const state = changeModel(initialState(config()), "minimax-h3", config());
    const params = taskParams({ ...state, resolution: "1080p", duration: 15 }, "", config());
    expect(params).toMatchObject({ aspectRatio: "landscape", imageSize: "1080p", duration: 10 });
  });

  it("fills the form from a history task without submitting", () => {
    const cfg = config({ wan_video_duration: 20 });
    const start = changeModel(initialState(cfg), "minimax-h3", cfg);

    const restored = restoreTask(start, historyTask({ duration: null, seed: 0, first_frame: "C:\\frames\\a.png" }), cfg);
    expect(restored.state).toEqual({ model: "wan-3.0", aspect: "16:9", resolution: "720p", duration: 20 });
    expect(restored).toMatchObject({ seedText: "0", cappedAt: null, framesMode: true });

    // 比例、分辨率不在选项里就保持恢复出来的；时长只受模型的上下限约束
    const offCatalog = restoreTask(start, historyTask({ aspect_ratio: "portrait", image_size: "4k", duration: 99 }), cfg);
    expect(offCatalog.state).toEqual({ model: "wan-3.0", aspect: "16:9", resolution: "720p", duration: 30 });

    // 换到记录里的分辨率时，记住的时长超过了它的上限：封顶并提示
    const capped = restoreTask(
      start,
      historyTask({ model: "minimax-h3", image_size: "1080p", duration: 5 }),
      config({ video_resolution: "480p", video_duration: 15 }),
    );
    expect(capped.state).toEqual({ model: "minimax-h3", aspect: "landscape", resolution: "1080p", duration: 5 });
    expect(capped.cappedAt).toBe(10);

    // 认不出的模型按第一个；不支持首尾帧的模型不切到首尾帧模式
    const unknown = restoreTask(start, historyTask({ model: "retired-video", duration: 3, last_frame: "C:\\frames\\b.png" }), cfg);
    expect(unknown.state).toMatchObject({ model: "minimax-h3", duration: 3 });
    expect(unknown.framesMode).toBe(false);
  });

  it("falls back from frame mode for a model without frames support", () => {
    expect(refModeOf("wan-3.0", true)).toBe("frames");
    expect(refModeOf("wan-3.0", false)).toBe("refs");
    expect(refModeOf("minimax-h3", true)).toBe("refs");
  });

  it("labels only the named aspects and reads old audio records", () => {
    expect(aspectLabelKey("portrait")).toBe("video.aspect.portrait");
    expect(aspectLabelKey("landscape")).toBe("video.aspect.landscape");
    expect(aspectLabelKey("square")).toBe("video.aspect.square");
    // 其余比例原样显示；名字撞上原型上的成员也不给文案
    expect(aspectLabelKey("16:9")).toBeNull();
    expect(aspectLabelKey("constructor")).toBeNull();

    expect(refAudiosOf(historyTask())).toEqual([]);
    expect(refAudiosOf(historyTask({ ref_audios: ["C:\\a.mp3", "", "C:\\b.wav"] }))).toEqual(["C:\\a.mp3", "C:\\b.wav"]);
    // 旧记录可能把一个路径直接存成字符串
    const single = { ...historyTask(), ref_audios: "C:\\a.mp3" } as unknown as HistoryTask;
    expect(refAudiosOf(single)).toEqual(["C:\\a.mp3"]);
  });

  it("keeps the parallel count inside the slider range", () => {
    expect(parallelTasksOf(7, 1)).toBe(7);
    expect(parallelTasksOf(99, 1)).toBe(10);
    expect(parallelTasksOf(0, 1)).toBe(1);
    expect(parallelTasksOf("3", 1)).toBe(1);
  });
});
