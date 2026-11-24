/**
 * 模型清单和参数表（对应 core/model_catalog.py）。
 * 模型命名与参数支持以 Grsai 官网和 api_docs 为准，升级维护时改这个文件。
 */

export const TAB_BANANA_PRO = "banana_pro";
export const TAB_GPT_IMAGE = "gpt_image";
export const TAB_VIDEO = "video";

export const CHAT_MODELS = ["gemini-3.1-pro", "gemini-3-pro", "gemini-2.5-pro"] as const;

export const BANANA_PRO_MODELS = [
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
] as const;

export const GPT_IMAGE_MODELS = [
  "gpt-image-2",
  "gpt-image-2-vip",
  "gpt-image-2.5",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "gpt-image-2.6",
  "gpt-image-2.6-flare",
  "gpt-image-2.6-sunburst",
] as const;

export const VIDEO_MODELS = ["minimax-h3", "agnes-video-2.5", "wan-3.0"] as const;

/** 旧模型名到现行模型名的映射，只在恢复旧历史记录时用到。 */
export const LEGACY_IMAGE_MODEL_ALIASES: Readonly<Record<string, string>> = {
  "gpt-image-1.5": "gpt-image-2",
  "sora-image": "gpt-image-2",
  "gemini-2.5-flash-image": "nano-banana-fast",
};

export const COMIC_IMAGE_MODELS: readonly string[] = [...BANANA_PRO_MODELS, ...GPT_IMAGE_MODELS];

export const TAB_MODELS: Record<string, readonly string[]> = {
  [TAB_BANANA_PRO]: BANANA_PRO_MODELS,
  [TAB_GPT_IMAGE]: GPT_IMAGE_MODELS,
};

export const NANO_IMAGE_SIZE_OPTIONS: Readonly<Record<string, readonly string[]>> = {
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
};

export const NANO_BASE_RATIOS = [
  "auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "21:9",
] as const;

/** nano-banana-2 系列额外支持的比例。 */
export const NANO_EXTENDED_RATIOS: readonly string[] = [...NANO_BASE_RATIOS, "1:4", "4:1", "1:8", "8:1"];

export function nanoRatioOptions(modelName: string | null | undefined): string[] {
  return [...((modelName ?? "").startsWith("nano-banana-2") ? NANO_EXTENDED_RATIOS : NANO_BASE_RATIOS)];
}

/** gpt-image-2 / 2.5 / 2.6：支持比例或 1K 像素值。 */
export const GPT_IMAGE_RATIOS = [
  "auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3",
  "5:4", "4:5", "21:9", "9:21", "1:2", "2:1",
] as const;

/** vip 系模型只支持像素值，比例要按 1K/2K/4K 档位换算成像素。 */
export const GPT_PIXEL_ONLY_MODELS = [
  "gpt-image-2-vip",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "gpt-image-2.6-flare",
  "gpt-image-2.6-sunburst",
] as const;

export const GPT_TRANSPARENT_MODELS = [
  "gpt-image-2-vip",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "gpt-image-2.6-flare",
  "gpt-image-2.6-sunburst",
] as const;

export const GPT_VIP_RATIOS = [
  "auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3",
  "5:4", "4:5", "21:9", "9:21", "1:3", "3:1", "2:1", "1:2",
] as const;

export const GPT_PIXEL_TIERS = ["1K", "2K", "4K"] as const;

/** 官方文档给出的 vip 系模型比例到像素的对照，依次是 1K、2K、4K，部分比例没有 4K。 */
export const GPT_PIXEL_MAP: Readonly<Record<string, readonly string[]>> = {
  "1:1": ["1024x1024", "2048x2048", "2880x2880"],
  "16:9": ["1280x720", "2048x1152", "3840x2160"],
  "9:16": ["720x1280", "1152x2048", "2160x3840"],
  "4:3": ["1152x864", "2304x1728", "3264x2448"],
  "3:4": ["864x1152", "1728x2304", "2448x3264"],
  "3:2": ["1536x1024", "2048x1360", "3504x2336"],
  "2:3": ["1024x1536", "1360x2048", "2336x3504"],
  "5:4": ["1120x896", "2240x1792", "3200x2560"],
  "4:5": ["896x1120", "1792x2240", "2560x3200"],
  "21:9": ["1456x624", "2912x1248", "3840x1648"],
  "9:21": ["624x1456", "1248x2912", "1648x3840"],
  "1:3": ["688x2048", "1280x3840"],
  "3:1": ["2048x688", "3840x1280"],
  "2:1": ["1536x768", "3072x1536", "3840x1920"],
  "1:2": ["768x1536", "1536x3072", "1920x3840"],
};

/** 各模型支持的质量档位。 */
export const GPT_IMAGE_QUALITY_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  "gpt-image-2": ["auto"],
  "gpt-image-2.5": ["auto"],
  "gpt-image-2-vip": ["auto", "low", "medium", "high"],
  "gpt-image-2.5-flare": ["auto", "low", "medium", "high"],
  "gpt-image-2.5-sunburst": ["auto", "low", "medium", "high", "xhigh", "max"],
  "gpt-image-2.6": ["auto"],
  "gpt-image-2.6-flare": ["auto", "low", "medium", "high"],
  "gpt-image-2.6-sunburst": ["auto", "low", "medium", "high"],
};

/**
 * 返回图片的格式（outputFormat）。png 是全局默认；gif 仅 2.6 系列支持，svg 仅基座 gpt-image-2.6 支持；
 * 2.6 的 sunburst 和 flare 只支持 gif。没列出的模型不支持这个参数，请求里不带。
 */
export const GPT_OUTPUT_FORMAT_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  "gpt-image-2.6": ["png", "gif", "svg"],
  "gpt-image-2.6-flare": ["gif"],
  "gpt-image-2.6-sunburst": ["gif"],
};

/**
 * 按 Python 的 dict.get 语义查表：只认自有键。
 * 模型名和比例可能来自历史记录或配置，直接用方括号查会撞上原型上的 constructor 之类的键。
 */
function lookup<V>(table: Readonly<Record<string, V>>, key: string): V | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

export function isGptPixelOnly(modelName: string): boolean {
  return (GPT_PIXEL_ONLY_MODELS as readonly string[]).includes(modelName);
}

export function gptRatioOptions(modelName: string): string[] {
  return [...((GPT_PIXEL_ONLY_MODELS as readonly string[]).includes(modelName) ? GPT_VIP_RATIOS : GPT_IMAGE_RATIOS)];
}

export function gptQualityOptions(modelName: string): string[] {
  return [...(lookup(GPT_IMAGE_QUALITY_OPTIONS, modelName) ?? ["auto"])];
}

/** 模型支持的 outputFormat 选项；空数组表示不支持这个参数。 */
export function gptOutputFormatOptions(modelName: string): string[] {
  return [...(lookup(GPT_OUTPUT_FORMAT_OPTIONS, modelName) ?? [])];
}

/** 把比例和档位换算成 vip 系模型需要的像素值；比例不在对照表里时原样返回。 */
export function gptPixelValue(ratio: string | null | undefined, tier: string | null | undefined): string {
  if (ratio === null || ratio === undefined || ratio === "" || ratio === "auto") return "auto";
  const entries = lookup(GPT_PIXEL_MAP, ratio);
  if (!entries) return ratio;
  const tierIndex = ["1K", "2K", "4K"].indexOf(tier ?? "");
  const bounded = tierIndex >= entries.length ? entries.length - 1 : tierIndex;
  return entries[Math.max(bounded, 0)];
}

/** 因违规失败时默认不自动重试的模型。 */
export const VIP_MODELS = [
  "nano-banana-2-cl",
  "nano-banana-2-2k-cl",
  "nano-banana-2-4k-cl",
  "nano-banana-pro-vip",
  "nano-banana-pro-4k-vip",
  "nano-banana-pro-cl",
  "gpt-image-2-vip",
] as const;

// --- 视频生成模型的参数 ---

export interface VideoModelSpec {
  aspects: readonly string[];
  resolutions: readonly string[];
  maxImages: number;
  maxAudios: number;
  minDuration: number;
  maxDuration: number;
  /** 各分辨率下的最大时长；没有对应条目时用 maxDuration。 */
  durationLimits: Readonly<Record<string, number>>;
  defaultAspect: string;
  defaultResolution: string;
  /** 接口是否提供 firstFrame / lastFrame（与 images、audios 互斥）。 */
  supportsFrames: boolean;
  /** 参考视频上限，0 表示暂不支持。 */
  maxVideos: number;
}

// minimax-h3（依据 api_docs/minimax-h3接口.md）
export const MINIMAX_VIDEO_ASPECT_OPTIONS = ["portrait", "landscape", "square"] as const;
export const MINIMAX_VIDEO_RESOLUTIONS = ["480p", "768p", "1080p"] as const;
export const MINIMAX_VIDEO_MAX_IMAGES = 9;
export const MINIMAX_VIDEO_MAX_AUDIOS = 3;
export const MINIMAX_VIDEO_MIN_DURATION = 1;
export const MINIMAX_VIDEO_MAX_DURATION = 15;
/** 各分辨率支持的最大时长（1080p 最多 10 秒）。 */
export const MINIMAX_VIDEO_DURATION_LIMITS: Readonly<Record<string, number>> = {
  "480p": 15,
  "768p": 15,
  "1080p": 10,
};

// agnes-video-2.5：时长固定 4 到 12 秒，与分辨率无关
export const AGNES_VIDEO_ASPECT_OPTIONS = ["16:9", "9:16", "21:9", "4:3", "1:1", "3:4"] as const;
export const AGNES_VIDEO_RESOLUTIONS = ["720p", "1080p", "2k"] as const;
export const AGNES_VIDEO_MAX_IMAGES = 5;
export const AGNES_VIDEO_MAX_AUDIOS = 3;
export const AGNES_VIDEO_MIN_DURATION = 4;
export const AGNES_VIDEO_MAX_DURATION = 12;

// wan-3.0：参考音频每段最长 15 秒，由服务端校验
export const WAN_VIDEO_ASPECT_OPTIONS = ["16:9", "9:16", "21:9", "4:3", "1:1", "3:4"] as const;
export const WAN_VIDEO_RESOLUTIONS = ["480p", "720p", "1080p"] as const;
export const WAN_VIDEO_MAX_IMAGES = 10;
export const WAN_VIDEO_MAX_AUDIOS = 5;
export const WAN_VIDEO_MIN_DURATION = 2;
export const WAN_VIDEO_MAX_DURATION = 30;

/** 各视频模型的可选参数集，界面与请求构造共用这一份。未知模型按 minimax-h3 处理。 */
export const VIDEO_MODEL_SPECS: Readonly<Record<string, VideoModelSpec>> = {
  "minimax-h3": {
    aspects: MINIMAX_VIDEO_ASPECT_OPTIONS,
    resolutions: MINIMAX_VIDEO_RESOLUTIONS,
    maxImages: MINIMAX_VIDEO_MAX_IMAGES,
    maxAudios: MINIMAX_VIDEO_MAX_AUDIOS,
    minDuration: MINIMAX_VIDEO_MIN_DURATION,
    maxDuration: MINIMAX_VIDEO_MAX_DURATION,
    durationLimits: MINIMAX_VIDEO_DURATION_LIMITS,
    defaultAspect: "landscape",
    defaultResolution: "480p",
    supportsFrames: false,
    maxVideos: 0,
  },
  "agnes-video-2.5": {
    aspects: AGNES_VIDEO_ASPECT_OPTIONS,
    resolutions: AGNES_VIDEO_RESOLUTIONS,
    maxImages: AGNES_VIDEO_MAX_IMAGES,
    maxAudios: AGNES_VIDEO_MAX_AUDIOS,
    minDuration: AGNES_VIDEO_MIN_DURATION,
    maxDuration: AGNES_VIDEO_MAX_DURATION,
    durationLimits: Object.fromEntries(AGNES_VIDEO_RESOLUTIONS.map((r) => [r, AGNES_VIDEO_MAX_DURATION])),
    defaultAspect: "16:9",
    defaultResolution: "720p",
    supportsFrames: true,
    maxVideos: 0,
  },
  "wan-3.0": {
    aspects: WAN_VIDEO_ASPECT_OPTIONS,
    resolutions: WAN_VIDEO_RESOLUTIONS,
    maxImages: WAN_VIDEO_MAX_IMAGES,
    maxAudios: WAN_VIDEO_MAX_AUDIOS,
    minDuration: WAN_VIDEO_MIN_DURATION,
    maxDuration: WAN_VIDEO_MAX_DURATION,
    durationLimits: Object.fromEntries(WAN_VIDEO_RESOLUTIONS.map((r) => [r, WAN_VIDEO_MAX_DURATION])),
    defaultAspect: "16:9",
    defaultResolution: "720p",
    supportsFrames: true,
    maxVideos: 0,
  },
};

function videoSpec(model: string): VideoModelSpec {
  return lookup(VIDEO_MODEL_SPECS, model) ?? VIDEO_MODEL_SPECS["minimax-h3"];
}

export function videoAspectOptions(model: string): string[] {
  return [...videoSpec(model).aspects];
}

export function videoResolutions(model: string): string[] {
  return [...videoSpec(model).resolutions];
}

export function videoMaxImages(model: string): number {
  return videoSpec(model).maxImages;
}

export function videoMaxAudios(model: string): number {
  return videoSpec(model).maxAudios;
}

/** 全局时长边界 [最小, 最大]，还没按分辨率收窄。 */
export function videoDurationBounds(model: string): [number, number] {
  const spec = videoSpec(model);
  return [spec.minDuration, spec.maxDuration];
}

export function videoDefaultAspect(model: string): string {
  return videoSpec(model).defaultAspect;
}

export function videoDefaultResolution(model: string): string {
  return videoSpec(model).defaultResolution;
}

/** 指定模型加分辨率下的最大时长。 */
export function videoDurationLimit(model: string, resolution: string): number {
  const spec = videoSpec(model);
  return lookup(spec.durationLimits, resolution) ?? spec.maxDuration;
}

/** 模型是否支持首尾帧（firstFrame / lastFrame，与 images、audios 互斥）。 */
export function videoSupportsFrames(model: string): boolean {
  return videoSpec(model).supportsFrames;
}

/** 参考视频上限，0 表示该模型暂不支持。 */
export function videoMaxVideos(model: string): number {
  return videoSpec(model).maxVideos;
}

export const NANO_MODELS: ReadonlySet<string> = new Set(BANANA_PRO_MODELS);
export const COMPLETION_MODELS: ReadonlySet<string> = new Set(GPT_IMAGE_MODELS);
export const VIDEO_MODEL_SET: ReadonlySet<string> = new Set(VIDEO_MODELS);
