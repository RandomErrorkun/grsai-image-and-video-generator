import { describe, expect, it } from "vitest";
import {
  BANANA_MODEL_IDS,
  BANANA_MODELS,
  GPT_IMAGE_MODEL_IDS,
  GPT_IMAGE_MODELS,
  GPT_IMAGE_QUALITY_OPTIONS,
  GPT_IMAGE_RATIOS,
  GPT_OUTPUT_FORMAT_OPTIONS,
  GPT_PIXEL_ONLY_MODELS,
  GPT_TRANSPARENT_MODELS,
  GPT_VIP_RATIOS,
  IMAGE_MODELS,
  NANO_BASE_RATIOS,
  NANO_EXTENDED_RATIOS,
  NANO_IMAGE_SIZE_OPTIONS,
  VIDEO_MODEL_IDS,
  VIDEO_MODELS,
  VIP_MODELS,
  gptQualityOptions,
  gptRatioOptions,
  imageModelSpec,
  imageModelTab,
  isGptPixelOnly,
  nanoRatioOptions,
  videoAspectOptions,
  videoConfigKeys,
  videoDefaultAspect,
  videoDefaultResolution,
  videoDurationBounds,
  videoDurationLimit,
  videoMaxAudios,
  videoMaxImages,
  videoModelSpec,
  videoParamsKey,
  videoResolutions,
  videoSupportsFrames,
} from "./modelCatalog";

const SOURCE_BANANA = [
  "nano-banana",
  "nano-banana-fast",
  "nano-banana-2",
  "nano-banana-2.1",
  "nano-banana-2-lite",
  "nano-banana-2-cl",
  "nano-banana-2-2k-cl",
  "nano-banana-2-4k-cl",
  "nano-banana-pro",
  "nano-banana-pro-vt",
  "nano-banana-pro-cl",
  "nano-banana-pro-vip",
  "nano-banana-pro-4k-vip",
];

const SOURCE_GPT = [
  "gpt-image-2",
  "gpt-image-2-vip",
  "gpt-image-2.5",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "gpt-image-2.6",
  "gpt-image-2.6-flare",
  "gpt-image-2.6-sunburst",
];

describe("image model tables", () => {
  it("keep the source project's model order in both tabs", () => {
    expect(BANANA_MODEL_IDS).toEqual(SOURCE_BANANA);
    expect(GPT_IMAGE_MODEL_IDS).toEqual(SOURCE_GPT);
  });

  it("have exactly one entry per model", () => {
    const ids = IMAGE_MODELS.map((spec) => spec.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...SOURCE_BANANA, ...SOURCE_GPT]);
  });

  it("keep every entry complete and infer nothing from a model name", () => {
    for (const spec of BANANA_MODELS) {
      expect(spec.sizes.length, spec.id).toBeGreaterThan(0);
      expect(spec.ratios.length, spec.id).toBeGreaterThan(0);
    }
    for (const spec of GPT_IMAGE_MODELS) {
      expect(spec.ratios.length, spec.id).toBeGreaterThan(0);
      expect(spec.qualities.length, spec.id).toBeGreaterThan(0);
    }
    // 名字像同一个系列，但没登记就是没有，不会借用现有模型的配置
    expect(imageModelSpec("nano-banana-2.2")).toBeNull();
    expect(imageModelSpec("gpt-image-2.7")).toBeNull();
    expect(imageModelSpec(null)).toBeNull();
    expect(imageModelTab("nano-banana-2")).toBe("banana_pro");
    expect(imageModelTab("gpt-image-2")).toBe("gpt_image");
    expect(imageModelTab("no-such-model")).toBeNull();
  });

  it("match the source project's option tables", () => {
    expect(NANO_IMAGE_SIZE_OPTIONS).toEqual({
      "nano-banana": ["1K"],
      "nano-banana-fast": ["1K"],
      "nano-banana-2": ["1K", "2K", "4K"],
      "nano-banana-2.1": ["1K", "2K", "4K"],
      "nano-banana-2-lite": ["1K"],
      "nano-banana-2-cl": ["1K"],
      "nano-banana-2-2k-cl": ["2K"],
      "nano-banana-2-4k-cl": ["4K"],
      "nano-banana-pro": ["1K", "2K", "4K"],
      "nano-banana-pro-vt": ["1K", "2K", "4K"],
      "nano-banana-pro-cl": ["1K", "2K", "4K"],
      "nano-banana-pro-vip": ["1K", "2K"],
      "nano-banana-pro-4k-vip": ["4K"],
    });
    expect(GPT_IMAGE_QUALITY_OPTIONS).toEqual({
      "gpt-image-2": ["auto"],
      "gpt-image-2.5": ["auto"],
      "gpt-image-2-vip": ["auto", "low", "medium", "high"],
      "gpt-image-2.5-flare": ["auto", "low", "medium", "high"],
      "gpt-image-2.5-sunburst": ["auto", "low", "medium", "high", "xhigh", "max"],
      "gpt-image-2.6": ["auto"],
      "gpt-image-2.6-flare": ["auto", "low", "medium", "high"],
      "gpt-image-2.6-sunburst": ["auto", "low", "medium", "high"],
    });
    expect(GPT_OUTPUT_FORMAT_OPTIONS).toEqual({
      "gpt-image-2.6": ["png", "gif", "svg"],
      // 源项目记的是只有 gif；按 GPT Image 接口文档（2026-11-25 核对），两个变体支持 png 和 gif，默认 png
      "gpt-image-2.6-flare": ["png", "gif"],
      "gpt-image-2.6-sunburst": ["png", "gif"],
    });
    expect(GPT_PIXEL_ONLY_MODELS).toEqual([
      "gpt-image-2-vip",
      "gpt-image-2.5-flare",
      "gpt-image-2.5-sunburst",
      "gpt-image-2.6-flare",
      "gpt-image-2.6-sunburst",
    ]);
    expect(GPT_TRANSPARENT_MODELS).toEqual(GPT_PIXEL_ONLY_MODELS);
  });

  it("name the same models the source keeps from auto-retry after a moderation failure", () => {
    const source = [
      "nano-banana-2-cl",
      "nano-banana-2-2k-cl",
      "nano-banana-2-4k-cl",
      "nano-banana-pro-vip",
      "nano-banana-pro-4k-vip",
      "nano-banana-pro-cl",
      "gpt-image-2-vip",
    ];
    // 名单相同；这里按表里的顺序排列，所以 nano-banana-pro-cl 排在两个 vip 的前面
    expect([...VIP_MODELS].sort()).toEqual([...source].sort());
  });

  it("answer option questions from the entry", () => {
    expect(nanoRatioOptions("nano-banana-pro")).toEqual([...NANO_BASE_RATIOS]);
    expect(nanoRatioOptions("nano-banana-2-lite")).toEqual([...NANO_EXTENDED_RATIOS]);
    expect(nanoRatioOptions("nano-banana-2-4k-cl")).toEqual([...NANO_EXTENDED_RATIOS]);
    expect(gptRatioOptions("gpt-image-2.6")).toEqual([...GPT_IMAGE_RATIOS]);
    expect(gptRatioOptions("gpt-image-2.6-flare")).toEqual([...GPT_VIP_RATIOS]);
    // 1:3 和 3:1 只有像素系的比例表里有
    expect(gptRatioOptions("gpt-image-2.6")).not.toContain("1:3");
    expect(gptRatioOptions("gpt-image-2.6-flare")).toContain("1:3");
    expect(isGptPixelOnly("gpt-image-2.6-flare")).toBe(true);
    expect(isGptPixelOnly("gpt-image-2.6")).toBe(false);
    expect(gptQualityOptions("gpt-image-2.5-sunburst")).toEqual(["auto", "low", "medium", "high", "xhigh", "max"]);
    expect(gptQualityOptions("gpt-image-2")).toEqual(["auto"]);
  });
});

describe("video model table", () => {
  it("keeps the source project's order and specs", () => {
    expect(VIDEO_MODEL_IDS).toEqual(["minimax-h3", "agnes-video-2.5", "wan-3.0"]);

    expect(videoAspectOptions("minimax-h3")).toEqual(["portrait", "landscape"]);
    expect(videoResolutions("minimax-h3")).toEqual(["480p", "768p", "1080p"]);
    expect([videoMaxImages("minimax-h3"), videoMaxAudios("minimax-h3")]).toEqual([9, 3]);
    expect(videoDurationBounds("minimax-h3")).toEqual([1, 15]);
    expect(videoDefaultAspect("minimax-h3")).toBe("landscape");
    expect(videoDefaultResolution("minimax-h3")).toBe("480p");
    expect(videoSupportsFrames("minimax-h3")).toBe(true);
    expect(videoModelSpec("minimax-h3").requiresBothFrames).toBe(true);
    expect(videoResolutions("minimax-h3").map((r) => videoDurationLimit("minimax-h3", r))).toEqual([15, 15, 10]);

    expect(videoAspectOptions("agnes-video-2.5")).toEqual(["16:9", "9:16", "21:9", "4:3", "1:1", "3:4"]);
    expect(videoResolutions("agnes-video-2.5")).toEqual(["720p", "1080p", "2k"]);
    expect([videoMaxImages("agnes-video-2.5"), videoMaxAudios("agnes-video-2.5")]).toEqual([5, 3]);
    expect(videoDurationBounds("agnes-video-2.5")).toEqual([4, 12]);
    expect(videoDefaultAspect("agnes-video-2.5")).toBe("16:9");
    expect(videoDefaultResolution("agnes-video-2.5")).toBe("720p");
    expect(videoSupportsFrames("agnes-video-2.5")).toBe(true);
    expect(videoDurationLimit("agnes-video-2.5", "2k")).toBe(12);

    expect(videoAspectOptions("wan-3.0")).toEqual(["16:9", "9:16", "21:9", "4:3", "1:1", "3:4"]);
    expect(videoResolutions("wan-3.0")).toEqual(["480p", "720p", "1080p"]);
    expect([videoMaxImages("wan-3.0"), videoMaxAudios("wan-3.0")]).toEqual([10, 5]);
    expect(videoDurationBounds("wan-3.0")).toEqual([2, 30]);
    expect(videoDefaultAspect("wan-3.0")).toBe("16:9");
    expect(videoDefaultResolution("wan-3.0")).toBe("720p");
    expect(videoSupportsFrames("wan-3.0")).toBe(true);
    expect(videoDurationLimit("wan-3.0", "1080p")).toBe(30);
  });

  it("treats an unknown model like the first one, as the source does", () => {
    expect(videoModelSpec("no-such-model")).toBe(VIDEO_MODELS[0]);
    expect(videoAspectOptions("no-such-model")).toEqual(videoAspectOptions("minimax-h3"));
  });

  it("keeps the three older models on their own config keys and gives others a single JSON key", () => {
    expect(videoConfigKeys("minimax-h3")).toEqual({
      aspect: "video_aspect_ratio",
      resolution: "video_resolution",
      duration: "video_duration",
    });
    expect(videoConfigKeys("agnes-video-2.5")).toEqual({
      aspect: "agnes_video_aspect_ratio",
      resolution: "agnes_video_resolution",
      duration: "agnes_video_duration",
    });
    expect(videoConfigKeys("wan-3.0")).toEqual({
      aspect: "wan_video_aspect_ratio",
      resolution: "wan_video_resolution",
      duration: "wan_video_duration",
    });
    expect(videoParamsKey("some-new-model")).toBe("video_model_params_some-new-model");
  });

  it("gives every entry a hint key that exists in both translation tables", async () => {
    const en = (await import("../i18n/en.json")).default as Record<string, string>;
    const zh = (await import("../i18n/zh.json")).default as Record<string, string>;
    for (const spec of VIDEO_MODELS) {
      if (!spec.hintKey) continue;
      expect(en[spec.hintKey], spec.hintKey).toBeTruthy();
      expect(zh[spec.hintKey], spec.hintKey).toBeTruthy();
    }
  });
});
