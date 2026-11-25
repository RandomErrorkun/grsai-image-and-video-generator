/**
 * 生成页的取值、切换和任务参数（对应 ui/generator_page.py）。
 * 不依赖 React 和平台层，可以直接单测。页面只认模型清单里的条目，不按模型名判断。
 */
import { normalizeLegacyModel } from "../core/api";
import { DEFAULT_CONFIG, type ConfigStore } from "../core/config";
import type { HistoryTask } from "../core/history";
import {
  BANANA_MODEL_IDS,
  GPT_IMAGE_MODEL_IDS,
  GPT_PIXEL_TIERS,
  TAB_BANANA_PRO,
  TAB_GPT_IMAGE,
  VIP_MODELS,
  gptPixelValue,
  imageModelSpec,
  imageModelTab,
} from "../core/modelCatalog";

export type GeneratorTab = typeof TAB_BANANA_PRO | typeof TAB_GPT_IMAGE;

/** 这里只用到配置的读写：页面传全局的 cfg，测试里传一个内存里的假存储。 */
export type GeneratorConfig = Pick<ConfigStore, "get" | "set">;

export interface GeneratorState {
  tab: GeneratorTab;
  /** 当前模型，清单里的现行模型名。 */
  model: string;
  /** Banana：比例和尺寸。 */
  ratio: string;
  size: string;
  /** GPT Image：比例、质量、像素档位、输出格式。 */
  gptRatio: string;
  quality: string;
  tier: string;
  format: string;
  transparent: boolean;
  /** 变体数。接口没有 variants 参数，多变体靠多提几个任务。 */
  variants: number;
}

/**
 * 当前模型在两行参数之外还要显示的控件，全看它在清单里的条目。
 * 比例行属于哪个系列由条目本身决定（有 sizes 的是 Banana），不在这里重复。
 */
export interface ModelControls {
  /** 变体数，只有 GPT Image 系有。 */
  variants: boolean;
  /** 质量下拉框，模型的档位不止一个才显示。 */
  quality: boolean;
  /** 像素档位，只收像素值的模型才有。 */
  tier: boolean;
  /** 透明背景，支持它的模型才有。 */
  transparent: boolean;
  /** 输出格式，接口给这个参数的模型才有。 */
  format: boolean;
  /** VIP 模型：违规失败默认不自动重试，要给出说明。 */
  vip: boolean;
}

/** 一次生成里每个任务都一样的参数；提示词和参考图由页面另外填。 */
export interface TaskParams {
  model: string;
  aspectRatio: string;
  imageSize: string;
  quality: string | null;
  background: string | null;
  outputFormat: string | null;
}

/** 并行任务数的滑块范围，与源项目一致。 */
export const PARALLEL_MIN = 1;
export const PARALLEL_MAX = 10;

const NO_CONTROLS: ModelControls = {
  variants: false,
  quality: false,
  tier: false,
  transparent: false,
  format: false,
  vip: false,
};

/** 值在选项里就留下，不在就落到第一项，对应源项目的 _set_combo_items。 */
function firstOr(items: readonly string[], preferred: unknown): string {
  return typeof preferred === "string" && items.includes(preferred) ? preferred : (items[0] ?? "");
}

export function tabModels(tab: GeneratorTab): readonly string[] {
  return tab === TAB_GPT_IMAGE ? GPT_IMAGE_MODEL_IDS : BANANA_MODEL_IDS;
}

/** 并行任务数：不是数字就用默认值，越界的按滑块的范围收进来。 */
export function parallelTasksOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_CONFIG.parallel_tasks;
  return Math.min(PARALLEL_MAX, Math.max(PARALLEL_MIN, Math.trunc(value)));
}

/** 选项卡记住的模型；没记住、记的是旧名或已经下线的模型时用该选项卡的第一个。 */
function rememberedModel(tab: GeneratorTab, config: GeneratorConfig): string {
  const remembered = normalizeLegacyModel(config.get(`last_model_tab_${tab}`, ""));
  const models = tabModels(tab);
  return typeof remembered === "string" && models.includes(remembered) ? remembered : (models[0] ?? "");
}

/**
 * 对应 on_model_changed 里重填下拉框的那几步：各项按配置里上次的取值恢复，
 * 取值不在该模型的选项里就落到第一项。透明背景和变体数不动。
 */
function withModel(state: GeneratorState, model: string, config: GeneratorConfig): GeneratorState {
  const next: GeneratorState = { ...state, model };
  const spec = imageModelSpec(model);
  if (!spec) return next;
  if ("sizes" in spec) {
    return {
      ...next,
      ratio: firstOr(spec.ratios, config.get("nano_banana_aspect_ratio", DEFAULT_CONFIG.nano_banana_aspect_ratio)),
      size: firstOr(spec.sizes, config.get("nano_banana_image_size", DEFAULT_CONFIG.nano_banana_image_size)),
    };
  }
  return {
    ...next,
    gptRatio: firstOr(spec.ratios, config.get("gpt_image_size", DEFAULT_CONFIG.gpt_image_size)),
    quality: firstOr(spec.qualities, config.get("gpt_image_quality", DEFAULT_CONFIG.gpt_image_quality)),
    tier: firstOr(GPT_PIXEL_TIERS, config.get("gpt_image_tier", DEFAULT_CONFIG.gpt_image_tier)),
    format: spec.outputFormats?.length
      ? firstOr(spec.outputFormats, config.get("gpt_image_output_format", DEFAULT_CONFIG.gpt_image_output_format))
      : state.format,
  };
}

/** 页面刚建好时的样子，对应 initUI 末尾那一句 on_tab_changed。只读配置，写入由页面挂载后补上。 */
export function initialState(config: GeneratorConfig): GeneratorState {
  // 旧配置里的标签名在读配置时已经迁移过，认不出的按 Banana 处理
  const tab: GeneratorTab = config.get("last_tab", DEFAULT_CONFIG.last_tab) === TAB_GPT_IMAGE ? TAB_GPT_IMAGE : TAB_BANANA_PRO;
  const blank: GeneratorState = {
    tab,
    model: rememberedModel(tab, config),
    ratio: "",
    size: "",
    gptRatio: "",
    quality: "",
    tier: "",
    format: DEFAULT_CONFIG.gpt_image_output_format,
    transparent: config.get("gpt_transparent_background", DEFAULT_CONFIG.gpt_transparent_background) === true,
    variants: 1,
  };
  return withModel(blank, blank.model, config);
}

/** 对应 on_tab_changed：记住选项卡，选中它记住的模型，再按模型重填各项。 */
export function changeTab(state: GeneratorState, tab: GeneratorTab, config: GeneratorConfig): GeneratorState {
  config.set("last_tab", tab);
  const next = withModel({ ...state, tab }, rememberedModel(tab, config), config);
  config.set(`last_model_tab_${tab}`, next.model);
  return next;
}

/** 对应 on_model_changed：记住当前选项卡上选的模型，再按它重填各项。 */
export function changeModel(state: GeneratorState, model: string, config: GeneratorConfig): GeneratorState {
  config.set(`last_model_tab_${state.tab}`, model);
  return withModel(state, model, config);
}

export function modelControls(model: string): ModelControls {
  const spec = imageModelSpec(model);
  const vip = VIP_MODELS.includes(model);
  if (!spec || "sizes" in spec) return vip ? { ...NO_CONTROLS, vip } : NO_CONTROLS;
  return {
    ...NO_CONTROLS,
    variants: true,
    quality: spec.qualities.length > 1,
    tier: spec.pixelOnly === true,
    transparent: spec.transparent === true,
    format: Boolean(spec.outputFormats?.length),
    vip,
  };
}

/**
 * 对应 on_generate：按当前模型取参数，并把配置该记住的写进去，写回的时刻与源项目一致。
 * GPT Image 系的比例也存进 imageSize：源项目就是这样写进历史 image_size 列的。
 */
export function taskParams(state: GeneratorState, config: GeneratorConfig): TaskParams {
  const params: TaskParams = {
    model: state.model,
    aspectRatio: "auto",
    imageSize: "1K",
    quality: null,
    background: null,
    outputFormat: null,
  };
  const spec = imageModelSpec(state.model);
  // 下拉框里只会有清单内的模型，这一支走不到，取值与源项目的初始值一致
  if (!spec) return params;

  if ("sizes" in spec) {
    config.set("nano_banana_aspect_ratio", state.ratio);
    config.set("nano_banana_image_size", state.size);
    return { ...params, aspectRatio: state.ratio, imageSize: state.size };
  }

  config.set("gpt_image_size", state.gptRatio);
  params.imageSize = state.gptRatio;
  // 只收像素值的 vip 系模型：比例按档位换算成像素
  if (spec.pixelOnly === true) {
    config.set("gpt_image_tier", state.tier);
    params.aspectRatio = gptPixelValue(state.gptRatio, state.tier);
  } else {
    params.aspectRatio = state.gptRatio;
  }
  if (spec.qualities.length > 1) {
    params.quality = state.quality;
    config.set("gpt_image_quality", state.quality);
  }
  if (spec.transparent === true && state.transparent) params.background = "transparent";
  config.set("gpt_transparent_background", state.transparent);
  if (spec.outputFormats?.length) {
    params.outputFormat = state.format;
    config.set("gpt_image_output_format", state.format);
  }
  return params;
}

/** 一次点击提交的任务数，全部一起启动。 */
export function taskCount(parallel: number, variants: number): number {
  return Math.max(parallel * variants, 1);
}

/** 历史记录里的参考图：旧记录可能存的是一个路径，也可能是路径数组。 */
export function refImagesOf(task: HistoryTask): string[] {
  const raw = task.ref_images;
  if (!raw) return [];
  const paths = Array.isArray(raw) ? raw : [raw];
  return paths.filter((path): path is string => typeof path === "string" && path !== "");
}

/**
 * 对应 main_window.py 的 regenerate_task 里填回生成页的那几步，只回填，不提交。
 * 先切到模型所在的选项卡（这一步会把该选项卡记住的模型和参数先恢复一遍），再选模型，
 * 最后按记录改比例和尺寸；记录里的值不在该模型的选项里就保持前一步恢复出来的。
 */
export function restoreTask(state: GeneratorState, task: HistoryTask, config: GeneratorConfig): GeneratorState {
  const model = normalizeLegacyModel(task.model);
  // 清单外的模型没有条目，按源项目最后一档的落点放到 GPT Image，下拉框保持原样
  const tab: GeneratorTab =
    typeof model === "string" && imageModelTab(model) === TAB_BANANA_PRO ? TAB_BANANA_PRO : TAB_GPT_IMAGE;
  let next = tab === state.tab ? state : changeTab(state, tab, config);
  if (typeof model === "string" && model !== next.model && tabModels(tab).includes(model)) {
    next = changeModel(next, model, config);
  }
  const spec = typeof model === "string" ? imageModelSpec(model) : null;
  if (!spec) return next;
  if ("sizes" in spec) {
    return {
      ...next,
      ratio: spec.ratios.includes(task.aspect_ratio) ? task.aspect_ratio : next.ratio,
      size: spec.sizes.includes(task.image_size) ? task.image_size : next.size,
    };
  }
  return spec.ratios.includes(task.image_size) ? { ...next, gptRatio: task.image_size } : next;
}
