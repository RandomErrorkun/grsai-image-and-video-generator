/**
 * 模型清单和参数表（对应 core/model_catalog.py）。
 *
 * 新增模型只改这个文件：图像模型在 IMAGE_MODELS 里加一条，视频模型在 VIDEO_MODEL_LIST 里加一条。
 * 一个模型的全部特性都写在它那一条里；生成页、视频页和请求构造都照表走，不按模型名到处判断。
 * 视频模型要在界面上显示一段说明时，再往两份文案表里加一个键，写进条目的 hintKey。
 * 模型命名与参数支持以 Grsai 官网和 api_docs 为准。
 */

// ---- 各家族共用的选项集合 ----

export const TAB_BANANA_PRO = "banana_pro";
export const TAB_GPT_IMAGE = "gpt_image";

/** 剧情规划的对话模型。 */
export const CHAT_MODELS = ["gemini-3.1-pro", "gemini-3-pro", "gemini-2.5-pro"] as const;

export const NANO_BASE_RATIOS = [
  "auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "21:9",
] as const;

/** nano-banana-2 系列额外支持的比例。 */
export const NANO_EXTENDED_RATIOS: readonly string[] = [...NANO_BASE_RATIOS, "1:4", "4:1", "1:8", "8:1"];

/** gpt-image-2 / 2.5 / 2.6：支持比例或 1K 像素值。 */
export const GPT_IMAGE_RATIOS = [
  "auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3",
  "5:4", "4:5", "21:9", "9:21", "1:2", "2:1",
] as const;

/** vip 系模型只支持像素值，比例要按 1K/2K/4K 档位换算成像素。 */
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

/** 旧模型名到现行模型名的映射，只在恢复旧历史记录时用到。 */
export const LEGACY_IMAGE_MODEL_ALIASES: Readonly<Record<string, string>> = {
  "gpt-image-1.5": "gpt-image-2",
  "sora-image": "gpt-image-2",
  "gemini-2.5-flash-image": "nano-banana-fast",
};

/**
 * 按 Python 的 dict.get 语义查表：只认自有键。
 * 模型名和比例可能来自历史记录或配置，直接用方括号查会撞上原型上的 constructor 之类的键。
 */
function lookup<V>(table: Readonly<Record<string, V>>, key: string): V | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

// ---- 图像模型 ----

/** banana 系的请求体是 model、prompt、aspectRatio、imageSize；gpt 系另带质量等参数。也决定它排在生成页的哪个选项卡。 */
export type ImageFamily = "banana" | "gpt";

export interface ImageModelSpec {
  /** 模型名，原样发给接口。 */
  readonly id: string;
  readonly family: ImageFamily;
  /** 可选尺寸，只有 banana 系有。 */
  readonly sizes?: readonly string[];
  /** 可选比例；不给就用家族的基础集合。 */
  readonly ratios?: readonly string[];
  /** 质量档位，只有 gpt 系有；不给等于只有 auto。 */
  readonly qualities?: readonly string[];
  /** 只收像素值的 vip 系：比例和档位换算成像素值。 */
  readonly pixelOnly?: boolean;
  /** 支持透明背景。 */
  readonly transparent?: boolean;
  /** 输出格式；不给表示接口没有这个参数，请求里不带。 */
  readonly outputFormats?: readonly string[];
  /** 因违规失败时默认不自动重试。 */
  readonly vipModeration?: boolean;
}

/** 图像模型。表里的顺序就是生成页下拉框的顺序。 */
export const IMAGE_MODELS: readonly ImageModelSpec[] = [
  // Banana 系列
  { id: "nano-banana", family: "banana", sizes: ["1K"] },
  { id: "nano-banana-fast", family: "banana", sizes: ["1K"] },
  { id: "nano-banana-2", family: "banana", sizes: ["1K", "2K", "4K"], ratios: NANO_EXTENDED_RATIOS },
  { id: "nano-banana-2.1", family: "banana", sizes: ["1K", "2K", "4K"], ratios: NANO_EXTENDED_RATIOS },
  { id: "nano-banana-2-lite", family: "banana", sizes: ["1K"], ratios: NANO_EXTENDED_RATIOS },
  { id: "nano-banana-2-cl", family: "banana", sizes: ["1K"], ratios: NANO_EXTENDED_RATIOS, vipModeration: true },
  { id: "nano-banana-2-2k-cl", family: "banana", sizes: ["2K"], ratios: NANO_EXTENDED_RATIOS, vipModeration: true },
  { id: "nano-banana-2-4k-cl", family: "banana", sizes: ["4K"], ratios: NANO_EXTENDED_RATIOS, vipModeration: true },
  { id: "nano-banana-pro", family: "banana", sizes: ["1K", "2K", "4K"] },
  { id: "nano-banana-pro-vt", family: "banana", sizes: ["1K", "2K", "4K"] },
  { id: "nano-banana-pro-cl", family: "banana", sizes: ["1K", "2K", "4K"], vipModeration: true },
  { id: "nano-banana-pro-vip", family: "banana", sizes: ["1K", "2K"], vipModeration: true },
  { id: "nano-banana-pro-4k-vip", family: "banana", sizes: ["4K"], vipModeration: true },
  // GPT Image 系列
  { id: "gpt-image-2", family: "gpt" },
  { id: "gpt-image-2-vip", family: "gpt", pixelOnly: true, transparent: true, qualities: ["auto", "low", "medium", "high"], vipModeration: true },
  { id: "gpt-image-2.5", family: "gpt" },
  { id: "gpt-image-2.5-flare", family: "gpt", pixelOnly: true, transparent: true, qualities: ["auto", "low", "medium", "high"] },
  { id: "gpt-image-2.5-sunburst", family: "gpt", pixelOnly: true, transparent: true, qualities: ["auto", "low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-image-2.6", family: "gpt", outputFormats: ["png", "gif", "svg"] },
  { id: "gpt-image-2.6-flare", family: "gpt", pixelOnly: true, transparent: true, qualities: ["auto", "low", "medium", "high"], outputFormats: ["gif"] },
  { id: "gpt-image-2.6-sunburst", family: "gpt", pixelOnly: true, transparent: true, qualities: ["auto", "low", "medium", "high"], outputFormats: ["gif"] },
];

const IMAGE_BY_ID: ReadonlyMap<string, ImageModelSpec> = new Map(IMAGE_MODELS.map((spec) => [spec.id, spec]));

const modelIds = (family: ImageFamily): readonly string[] =>
  IMAGE_MODELS.filter((spec) => spec.family === family).map((spec) => spec.id);

const flagsOn = (flag: "pixelOnly" | "transparent" | "vipModeration"): readonly string[] =>
  IMAGE_MODELS.filter((spec) => spec[flag] === true).map((spec) => spec.id);

/** 按模型名取图像模型的条目；没有这个模型返回 null。旧模型名要先过 LEGACY_IMAGE_MODEL_ALIASES。 */
export function imageModelSpec(modelName: string | null | undefined): ImageModelSpec | null {
  return (modelName ? IMAGE_BY_ID.get(modelName) : undefined) ?? null;
}

/** 某个选项卡下的模型，顺序与下拉框一致。 */
export const BANANA_PRO_MODELS: readonly string[] = modelIds("banana");
export const GPT_IMAGE_MODELS: readonly string[] = modelIds("gpt");

export const COMIC_IMAGE_MODELS: readonly string[] = [...BANANA_PRO_MODELS, ...GPT_IMAGE_MODELS];

export const TAB_MODELS: Readonly<Record<string, readonly string[]>> = {
  [TAB_BANANA_PRO]: BANANA_PRO_MODELS,
  [TAB_GPT_IMAGE]: GPT_IMAGE_MODELS,
};

/** 各 Banana 模型可选的尺寸。 */
export const NANO_IMAGE_SIZE_OPTIONS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  IMAGE_MODELS.flatMap((spec) => (spec.sizes ? [[spec.id, spec.sizes] as const] : [])),
);

export const GPT_PIXEL_ONLY_MODELS: readonly string[] = flagsOn("pixelOnly");
export const GPT_TRANSPARENT_MODELS: readonly string[] = flagsOn("transparent");

/** 各 gpt 模型支持的质量档位。 */
export const GPT_IMAGE_QUALITY_OPTIONS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  GPT_IMAGE_MODELS.map((id) => [id, imageModelSpec(id)?.qualities ?? ["auto"]]),
);

/**
 * 各模型支持的输出格式（outputFormat）。png 是全局默认；gif 仅 2.6 系列支持，svg 仅基座 gpt-image-2.6 支持；
 * 2.6 的 sunburst 和 flare 只支持 gif。没列出的模型不支持这个参数，请求里不带。
 */
export const GPT_OUTPUT_FORMAT_OPTIONS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  IMAGE_MODELS.flatMap((spec) => (spec.outputFormats ? [[spec.id, spec.outputFormats] as const] : [])),
);

/** 因违规失败时默认不自动重试的模型。 */
export const VIP_MODELS: readonly string[] = flagsOn("vipModeration");

export function nanoRatioOptions(modelName: string | null | undefined): string[] {
  return [...(imageModelSpec(modelName)?.ratios ?? NANO_BASE_RATIOS)];
}

export function isGptPixelOnly(modelName: string): boolean {
  return imageModelSpec(modelName)?.pixelOnly === true;
}

export function gptRatioOptions(modelName: string): string[] {
  return [...(isGptPixelOnly(modelName) ? GPT_VIP_RATIOS : GPT_IMAGE_RATIOS)];
}

export function gptQualityOptions(modelName: string): string[] {
  return [...(imageModelSpec(modelName)?.qualities ?? ["auto"])];
}

/** 模型支持的 outputFormat 选项；空数组表示不支持这个参数。 */
export function gptOutputFormatOptions(modelName: string): string[] {
  return [...(imageModelSpec(modelName)?.outputFormats ?? [])];
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

// ---- 视频模型 ----

/** 记住上次参数用的三个配置键。 */
export interface VideoConfigKeys {
  readonly aspect: string;
  readonly resolution: string;
  readonly duration: string;
}

export interface VideoModelSpec {
  /** 模型名，原样发给接口。 */
  readonly id: string;
  readonly aspects: readonly string[];
  readonly resolutions: readonly string[];
  readonly maxImages: number;
  readonly maxAudios: number;
  readonly minDuration: number;
  readonly maxDuration: number;
  /** 各分辨率下的最大时长；没写的分辨率用 maxDuration。 */
  readonly durationLimits?: Readonly<Record<string, number>>;
  readonly defaultAspect: string;
  readonly defaultResolution: string;
  /** 接口是否提供 firstFrame / lastFrame（与 images、audios 互斥）。 */
  readonly supportsFrames: boolean;
  /** 参考视频上限，0 表示暂不支持。 */
  readonly maxVideos: number;
  /**
   * 源项目给老模型留的三个配置键，为了旧配置照常可用。新模型不写这一项：
   * 它的参数存成一条 JSON，键见 videoParamsKey。
   */
  readonly configKeys?: VideoConfigKeys;
  /** 界面上那段模型说明的文案键；不给就不显示。 */
  readonly hintKey?: string;
}

/** 视频模型。表里的顺序就是视频页下拉框的顺序；未知模型按第一条处理。 */
export const VIDEO_MODEL_LIST: readonly VideoModelSpec[] = [
  {
    id: "minimax-h3",
    aspects: ["portrait", "landscape", "square"],
    resolutions: ["480p", "768p", "1080p"],
    maxImages: 9,
    maxAudios: 3,
    minDuration: 1,
    maxDuration: 15,
    // 1080p 最多 10 秒
    durationLimits: { "1080p": 10 },
    defaultAspect: "landscape",
    defaultResolution: "480p",
    supportsFrames: false,
    maxVideos: 0,
    configKeys: { aspect: "video_aspect_ratio", resolution: "video_resolution", duration: "video_duration" },
    hintKey: "video.hint_minimax",
  },
  {
    // 时长固定 4 到 12 秒，与分辨率无关
    id: "agnes-video-2.5",
    aspects: ["16:9", "9:16", "21:9", "4:3", "1:1", "3:4"],
    resolutions: ["720p", "1080p", "2k"],
    maxImages: 5,
    maxAudios: 3,
    minDuration: 4,
    maxDuration: 12,
    defaultAspect: "16:9",
    defaultResolution: "720p",
    supportsFrames: true,
    maxVideos: 0,
    configKeys: { aspect: "agnes_video_aspect_ratio", resolution: "agnes_video_resolution", duration: "agnes_video_duration" },
    hintKey: "video.hint_agnes",
  },
  {
    // 参考音频每段最长 15 秒，由服务端校验
    id: "wan-3.0",
    aspects: ["16:9", "9:16", "21:9", "4:3", "1:1", "3:4"],
    resolutions: ["480p", "720p", "1080p"],
    maxImages: 10,
    maxAudios: 5,
    minDuration: 2,
    maxDuration: 30,
    defaultAspect: "16:9",
    defaultResolution: "720p",
    supportsFrames: true,
    maxVideos: 0,
    configKeys: { aspect: "wan_video_aspect_ratio", resolution: "wan_video_resolution", duration: "wan_video_duration" },
    hintKey: "video.hint_wan",
  },
];

/** 各视频模型的可选参数集，界面与请求构造共用这一份。 */
export const VIDEO_MODEL_SPECS: Readonly<Record<string, VideoModelSpec>> = Object.fromEntries(
  VIDEO_MODEL_LIST.map((spec) => [spec.id, spec]),
);

/** 视频模型名，顺序与下拉框一致。 */
export const VIDEO_MODELS: readonly string[] = VIDEO_MODEL_LIST.map((spec) => spec.id);

function videoSpec(model: string): VideoModelSpec {
  return lookup(VIDEO_MODEL_SPECS, model) ?? VIDEO_MODEL_LIST[0];
}

/** 视频模型的条目；不认识的模型按第一条（minimax-h3）处理，与源项目一致。 */
export function videoModelSpec(model: string): VideoModelSpec {
  return videoSpec(model);
}

/** 老模型记住上次参数用的键；没有专门键的模型返回 null，这时用 videoParamsKey。 */
export function videoConfigKeys(model: string): VideoConfigKeys | null {
  return lookup(VIDEO_MODEL_SPECS, model)?.configKeys ?? null;
}

/** 没有专门配置键的视频模型，把上次的参数存成一条 JSON 放在这个键下。 */
export function videoParamsKey(model: string): string {
  return `video_model_params_${model}`;
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
  return lookup(spec.durationLimits ?? {}, resolution) ?? spec.maxDuration;
}

/** 模型是否支持首尾帧（firstFrame / lastFrame，与 images、audios 互斥）。 */
export function videoSupportsFrames(model: string): boolean {
  return videoSpec(model).supportsFrames;
}

/** 参考视频上限，0 表示该模型暂不支持。 */
export function videoMaxVideos(model: string): number {
  return videoSpec(model).maxVideos;
}

// ---- 按家族判断用的集合 ----

export const NANO_MODELS: ReadonlySet<string> = new Set(BANANA_PRO_MODELS);
export const COMPLETION_MODELS: ReadonlySet<string> = new Set(GPT_IMAGE_MODELS);
export const VIDEO_MODEL_SET: ReadonlySet<string> = new Set(VIDEO_MODELS);
