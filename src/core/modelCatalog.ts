/**
 * 模型清单和参数表（对应 core/model_catalog.py）。
 *
 * 按大类分表：Banana、GPT Image、视频、对话。每个模型一条，写全它自己的全部参数。
 * 同系列、名字相近的新模型，机制未必和老的相同，所以这里不按名字或系列推断任何东西：
 * 该有的字段一律必填，漏写会编译不过；不写的只有「支不支持某功能」这类开关。
 * 新增模型时只改这个文件，在对应的那张表里加一条。生成页、视频页和请求构造都照表走。
 * 视频模型要在界面上显示一段说明时，再往两份文案表里加一个键，写进条目的 hintKey。
 * 模型命名与参数支持以 Grsai 官网和 api_docs 为准。
 */

// ---- 各模型条目要引用的选项集合 ----

export const TAB_BANANA_PRO = "banana_pro";
export const TAB_GPT_IMAGE = "gpt_image";

export const NANO_BASE_RATIOS = [
  "auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "21:9",
] as const;

/** nano-banana-2 系列用的比例集合，比基础集合多四种。 */
export const NANO_EXTENDED_RATIOS: readonly string[] = [...NANO_BASE_RATIOS, "1:4", "4:1", "1:8", "8:1"];

export const GPT_IMAGE_RATIOS = [
  "auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3",
  "5:4", "4:5", "21:9", "9:21", "1:2", "2:1",
] as const;

/** 只收像素值的模型用的比例集合，比例要按 1K/2K/4K 档位换算成像素。 */
export const GPT_VIP_RATIOS = [
  "auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3",
  "5:4", "4:5", "21:9", "9:21", "1:3", "3:1", "2:1", "1:2",
] as const;

export const GPT_PIXEL_TIERS = ["1K", "2K", "4K"] as const;

/** 官方文档给出的比例到像素的对照，依次是 1K、2K、4K，部分比例没有 4K。 */
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

// ---- Banana 系列 ----

export interface BananaModelSpec {
  /** 模型名，原样发给接口。 */
  readonly id: string;
  /** 可选尺寸，请求里的 imageSize 只能取这里面的值。 */
  readonly sizes: readonly string[];
  /** 可选比例。 */
  readonly ratios: readonly string[];
  /** 因违规失败时默认不自动重试。 */
  readonly vipModeration?: boolean;
}

/** 表里的顺序就是生成页下拉框的顺序。 */
export const BANANA_MODELS: readonly BananaModelSpec[] = [
  { id: "nano-banana", sizes: ["1K"], ratios: NANO_BASE_RATIOS },
  { id: "nano-banana-fast", sizes: ["1K"], ratios: NANO_BASE_RATIOS },
  { id: "nano-banana-2", sizes: ["1K", "2K", "4K"], ratios: NANO_EXTENDED_RATIOS },
  { id: "nano-banana-2.1", sizes: ["1K", "2K", "4K"], ratios: NANO_EXTENDED_RATIOS },
  { id: "nano-banana-2-lite", sizes: ["1K"], ratios: NANO_EXTENDED_RATIOS },
  { id: "nano-banana-2-cl", sizes: ["1K"], ratios: NANO_EXTENDED_RATIOS, vipModeration: true },
  { id: "nano-banana-2-2k-cl", sizes: ["2K"], ratios: NANO_EXTENDED_RATIOS, vipModeration: true },
  { id: "nano-banana-2-4k-cl", sizes: ["4K"], ratios: NANO_EXTENDED_RATIOS, vipModeration: true },
  { id: "nano-banana-pro", sizes: ["1K", "2K", "4K"], ratios: NANO_BASE_RATIOS },
  { id: "nano-banana-pro-vt", sizes: ["1K", "2K", "4K"], ratios: NANO_BASE_RATIOS },
  { id: "nano-banana-pro-cl", sizes: ["1K", "2K", "4K"], ratios: NANO_BASE_RATIOS, vipModeration: true },
  { id: "nano-banana-pro-vip", sizes: ["1K", "2K"], ratios: NANO_BASE_RATIOS, vipModeration: true },
  { id: "nano-banana-pro-4k-vip", sizes: ["4K"], ratios: NANO_BASE_RATIOS, vipModeration: true },
];

// ---- GPT Image 系列 ----

export interface GptImageModelSpec {
  /** 模型名，原样发给接口。 */
  readonly id: string;
  /** 可选比例。 */
  readonly ratios: readonly string[];
  /** 质量档位，请求里的 quality 只能取这里面的值。 */
  readonly qualities: readonly string[];
  /** 只收像素值的 vip 系：比例和档位换算成像素值。 */
  readonly pixelOnly?: boolean;
  /** 支持透明背景。 */
  readonly transparent?: boolean;
  /** 输出格式；不写表示接口没有这个参数，请求里不带。 */
  readonly outputFormats?: readonly string[];
  /** 因违规失败时默认不自动重试。 */
  readonly vipModeration?: boolean;
}

/** 表里的顺序就是生成页下拉框的顺序。 */
export const GPT_IMAGE_MODELS: readonly GptImageModelSpec[] = [
  { id: "gpt-image-2", ratios: GPT_IMAGE_RATIOS, qualities: ["auto"] },
  {
    id: "gpt-image-2-vip",
    ratios: GPT_VIP_RATIOS,
    qualities: ["auto", "low", "medium", "high"],
    pixelOnly: true,
    transparent: true,
    vipModeration: true,
  },
  { id: "gpt-image-2.5", ratios: GPT_IMAGE_RATIOS, qualities: ["auto"] },
  {
    id: "gpt-image-2.5-flare",
    ratios: GPT_VIP_RATIOS,
    qualities: ["auto", "low", "medium", "high"],
    pixelOnly: true,
    transparent: true,
  },
  {
    id: "gpt-image-2.5-sunburst",
    ratios: GPT_VIP_RATIOS,
    qualities: ["auto", "low", "medium", "high", "xhigh", "max"],
    pixelOnly: true,
    transparent: true,
  },
  // png 是全局默认；svg 只有基座支持；flare 和 sunburst 只支持 gif
  { id: "gpt-image-2.6", ratios: GPT_IMAGE_RATIOS, qualities: ["auto"], outputFormats: ["png", "gif", "svg"] },
  {
    id: "gpt-image-2.6-flare",
    ratios: GPT_VIP_RATIOS,
    qualities: ["auto", "low", "medium", "high"],
    pixelOnly: true,
    transparent: true,
    outputFormats: ["png", "gif"],
  },
  {
    id: "gpt-image-2.6-sunburst",
    ratios: GPT_VIP_RATIOS,
    qualities: ["auto", "low", "medium", "high"],
    pixelOnly: true,
    transparent: true,
    outputFormats: ["png", "gif"],
  },
];

// ---- 图像模型的查询 ----

export type ImageModelSpec = BananaModelSpec | GptImageModelSpec;

/** 两张图像表合在一起，先是 Banana 再是 GPT Image。 */
export const IMAGE_MODELS: readonly ImageModelSpec[] = [...BANANA_MODELS, ...GPT_IMAGE_MODELS];

const IMAGE_BY_ID: ReadonlyMap<string, ImageModelSpec> = new Map(IMAGE_MODELS.map((spec) => [spec.id, spec]));

const modelIds = (specs: ReadonlyArray<{ readonly id: string }>): readonly string[] =>
  specs.map((spec) => spec.id);

/** Banana 系的模型名，顺序与下拉框一致。 */
export const BANANA_MODEL_IDS: readonly string[] = modelIds(BANANA_MODELS);
/** GPT Image 系的模型名，顺序与下拉框一致。 */
export const GPT_IMAGE_MODEL_IDS: readonly string[] = modelIds(GPT_IMAGE_MODELS);

/** 漫画页的出图模型：两个系列的图像模型都在里面。 */
export const COMIC_IMAGE_MODELS: readonly string[] = [...BANANA_MODEL_IDS, ...GPT_IMAGE_MODEL_IDS];

export const TAB_MODELS: Readonly<Record<string, readonly string[]>> = {
  [TAB_BANANA_PRO]: BANANA_MODEL_IDS,
  [TAB_GPT_IMAGE]: GPT_IMAGE_MODEL_IDS,
};

/** 按模型名取条目；没有这个模型返回 null。旧模型名要先过 LEGACY_IMAGE_MODEL_ALIASES。 */
export function imageModelSpec(modelName: string | null | undefined): ImageModelSpec | null {
  return (modelName ? IMAGE_BY_ID.get(modelName) : undefined) ?? null;
}

const isBanana = (spec: ImageModelSpec): spec is BananaModelSpec => "sizes" in spec;

/** 模型排在生成页的哪个选项卡；没有这个模型返回 null。 */
export function imageModelTab(modelName: string | null | undefined): string | null {
  const spec = imageModelSpec(modelName);
  if (!spec) return null;
  return isBanana(spec) ? TAB_BANANA_PRO : TAB_GPT_IMAGE;
}

/** 两个系列的条目各有自己的开关，按名字取出来看是不是开了。 */
const hasFlag = (spec: ImageModelSpec, flag: "pixelOnly" | "transparent" | "vipModeration"): boolean =>
  (spec as unknown as Record<string, unknown>)[flag] === true;

const flagsOn = (flag: "pixelOnly" | "transparent" | "vipModeration"): readonly string[] =>
  IMAGE_MODELS.filter((spec) => hasFlag(spec, flag)).map((spec) => spec.id);

/** 各 Banana 模型可选的尺寸。 */
export const NANO_IMAGE_SIZE_OPTIONS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  BANANA_MODELS.map((spec) => [spec.id, spec.sizes]),
);

/** 只收像素值的 GPT Image 模型。 */
export const GPT_PIXEL_ONLY_MODELS: readonly string[] = flagsOn("pixelOnly");
/** 支持透明背景的 GPT Image 模型。 */
export const GPT_TRANSPARENT_MODELS: readonly string[] = flagsOn("transparent");

/** 各 GPT Image 模型支持的质量档位。 */
export const GPT_IMAGE_QUALITY_OPTIONS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  GPT_IMAGE_MODELS.map((spec) => [spec.id, spec.qualities]),
);

/** 各模型支持的输出格式（outputFormat）。没列出的模型不支持这个参数，请求里不带。 */
export const GPT_OUTPUT_FORMAT_OPTIONS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  GPT_IMAGE_MODELS.flatMap((spec) => (spec.outputFormats ? [[spec.id, spec.outputFormats] as const] : [])),
);

/** 因违规失败时默认不自动重试的模型，先是 Banana 再是 GPT Image。 */
export const VIP_MODELS: readonly string[] = flagsOn("vipModeration");

export function nanoRatioOptions(modelName: string | null | undefined): string[] {
  const spec = imageModelSpec(modelName);
  return [...(spec && isBanana(spec) ? spec.ratios : NANO_BASE_RATIOS)];
}

export function isGptPixelOnly(modelName: string): boolean {
  const spec = imageModelSpec(modelName);
  return spec !== null && !isBanana(spec) && spec.pixelOnly === true;
}

export function gptRatioOptions(modelName: string): string[] {
  const spec = imageModelSpec(modelName);
  return [...(spec && !isBanana(spec) ? spec.ratios : GPT_IMAGE_RATIOS)];
}

export function gptQualityOptions(modelName: string): string[] {
  const spec = imageModelSpec(modelName);
  return [...(spec && !isBanana(spec) ? spec.qualities : ["auto"])];
}

/** 模型支持的 outputFormat 选项；空数组表示不支持这个参数。 */
export function gptOutputFormatOptions(modelName: string): string[] {
  const spec = imageModelSpec(modelName);
  return [...(spec && !isBanana(spec) ? (spec.outputFormats ?? []) : [])];
}

/** 把比例和档位换算成像素值；比例不在对照表里时原样返回。 */
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

/** 参考视频条目里可选的两个字段，按模型区分（依据 agnes-video 接口文档）。 */
export type VideoReferenceField = "startSeconds" | "requireAudio";

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
  /** 使用首尾帧模式时是否必须同时提供首帧和尾帧（如 minimax-h3）。 */
  readonly requiresBothFrames?: boolean;
  /** 参考视频上限，0 表示不支持。 */
  readonly maxVideos: number;
  /** 每个参考视频除了 url 还带哪些字段：startSeconds 是从第几秒开始读，requireAudio 是是否必须有音轨。 */
  readonly videoFields?: readonly VideoReferenceField[];
  /** 参考视频总时长上限（秒）；不写表示文档没有限制。 */
  readonly maxVideoSeconds?: number;
  /**
   * 源项目给老模型留的三个配置键，为了旧配置照常可用。新模型不写这一项：
   * 它的参数存成一条 JSON，键见 videoParamsKey。
   */
  readonly configKeys?: VideoConfigKeys;
  /** 界面上那段模型说明的文案键；不给就不显示。 */
  readonly hintKey?: string;
}

/** 表里的顺序就是视频页下拉框的顺序。 */
export const VIDEO_MODELS: readonly VideoModelSpec[] = [
  {
    id: "minimax-h3",
    // 按 2026-11-25 线上接口文档 514679297e0 与实测：仅支持 portrait 和 landscape，不支持 square
    aspects: ["portrait", "landscape"],
    resolutions: ["480p", "768p", "1080p"],
    maxImages: 9,
    maxAudios: 3,
    minDuration: 1,
    maxDuration: 15,
    // 1080p 最多 10 秒
    durationLimits: { "1080p": 10 },
    defaultAspect: "landscape",
    defaultResolution: "480p",
    // 按 2026-11-25 线上接口文档 514679297e0：现已支持首尾帧，且首帧与尾帧必须同时填入
    supportsFrames: true,
    requiresBothFrames: true,
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
    // 文档没写段数上限，界面先按 5 段收着
    maxVideos: 5,
    videoFields: ["startSeconds", "requireAudio"],
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
    // 最多 5 段且总时长不超过 15 秒；参考视频按秒计费
    maxVideos: 5,
    maxVideoSeconds: 15,
    configKeys: { aspect: "wan_video_aspect_ratio", resolution: "wan_video_resolution", duration: "wan_video_duration" },
    hintKey: "video.hint_wan",
  },
];

/** 视频模型名，顺序与下拉框一致。 */
export const VIDEO_MODEL_IDS: readonly string[] = modelIds(VIDEO_MODELS);

/** 各视频模型的可选参数集，界面与请求构造共用这一份。 */
export const VIDEO_MODEL_SPECS: Readonly<Record<string, VideoModelSpec>> = Object.fromEntries(
  VIDEO_MODELS.map((spec) => [spec.id, spec]),
);

function videoSpec(model: string): VideoModelSpec {
  return lookup(VIDEO_MODEL_SPECS, model) ?? VIDEO_MODELS[0];
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

// ---- 对话模型和按大类判断用的集合 ----

/** 剧情规划用的对话模型。 */
export const CHAT_MODELS = ["gemini-3.1-pro", "gemini-3-pro", "gemini-2.5-pro"] as const;

export const NANO_MODELS: ReadonlySet<string> = new Set(BANANA_MODEL_IDS);
export const COMPLETION_MODELS: ReadonlySet<string> = new Set(GPT_IMAGE_MODEL_IDS);
export const VIDEO_MODEL_SET: ReadonlySet<string> = new Set(VIDEO_MODEL_IDS);
