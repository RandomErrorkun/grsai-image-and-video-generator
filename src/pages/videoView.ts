/**
 * 视频页的取值、切换和任务参数（对应 ui/video_page.py）。
 * 不依赖 React 和平台层，可以直接单测。页面只认模型清单里的条目，不按模型名判断。
 */
import type { VideoReference } from "../components/dropAreaTypes";
import type { VideoReferenceOption } from "../core/api";
import type { ConfigStore } from "../core/config";
import type { HistoryTask } from "../core/history";
import {
  VIDEO_MODEL_IDS,
  VIDEO_MODELS,
  videoAspectOptions,
  videoConfigKeys,
  videoDefaultAspect,
  videoDefaultResolution,
  videoDurationBounds,
  videoDurationLimit,
  videoParamsKey,
  videoResolutions,
  videoSupportsFrames,
  type VideoModelSpec,
} from "../core/modelCatalog";
import { pyInt } from "../core/py";

/** 这里只用到配置的读写：页面传全局的 cfg，测试里传一个内存里的假存储。 */
export type VideoConfig = Pick<ConfigStore, "get" | "set">;

export interface VideoState {
  /** 当前模型，清单里的模型名。 */
  model: string;
  /** 比例的参数值；portrait、landscape、square 在界面上换成文案。 */
  aspect: string;
  /** 分辨率，请求里放在 imageSize。 */
  resolution: string;
  /** 时长，整数秒。 */
  duration: number;
}

/** 素材模式：参考图加参考音频，或者首尾帧，二者互斥（接口不允许两套参数同时提交）。 */
export type RefMode = "refs" | "frames";
export const REF_MODE_REFS: RefMode = "refs";
export const REF_MODE_FRAMES: RefMode = "frames";

/** 并行任务数的滑块范围，与源项目一致。 */
export const PARALLEL_MIN = 1;
export const PARALLEL_MAX = 10;

/** 时长读不出来时的落点，与源项目一致。 */
const DEFAULT_DURATION = 5;

const ASPECT_LABEL_KEYS: Readonly<Record<string, string>> = {
  portrait: "video.aspect.portrait",
  landscape: "video.aspect.landscape",
  square: "video.aspect.square",
};

/** 比例在界面上显示的文案键；其余比例（16:9 这类）没有文案，返回 null，按参数值原样显示。 */
export function aspectLabelKey(aspect: string): string | null {
  return Object.prototype.hasOwnProperty.call(ASPECT_LABEL_KEYS, aspect) ? ASPECT_LABEL_KEYS[aspect] : null;
}

/** 并行任务数：不是数字就用默认值，越界的按滑块的范围收进来。 */
export function parallelTasksOf(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(PARALLEL_MAX, Math.max(PARALLEL_MIN, Math.trunc(value)));
}

/** 当前生效的素材模式：不支持首尾帧的模型临时回退到参考图模式，配置里的偏好不动。 */
export function refModeOf(model: string, framesPreferred: unknown): RefMode {
  return videoSupportsFrames(model) && framesPreferred === true ? REF_MODE_FRAMES : REF_MODE_REFS;
}

/** 模型记在配置里的三个参数，还没按选项和范围收过。 */
interface RememberedParams {
  aspect: unknown;
  resolution: unknown;
  duration: unknown;
}

/** 没有专门配置键的模型把参数存成一条 JSON；不是字符串或解不出来都按没存过处理。 */
function readJsonParams(raw: unknown): Partial<RememberedParams> {
  if (typeof raw !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Partial<RememberedParams>) : {};
  } catch {
    return {};
  }
}

function rememberedParams(model: string, config: VideoConfig): RememberedParams {
  const keys = videoConfigKeys(model);
  if (keys) {
    return {
      aspect: config.get(keys.aspect, videoDefaultAspect(model)),
      resolution: config.get(keys.resolution, videoDefaultResolution(model)),
      duration: config.get(keys.duration, DEFAULT_DURATION),
    };
  }
  const saved = readJsonParams(config.get(videoParamsKey(model), ""));
  return {
    aspect: saved.aspect ?? videoDefaultAspect(model),
    resolution: saved.resolution ?? videoDefaultResolution(model),
    duration: saved.duration ?? DEFAULT_DURATION,
  };
}

/** 把这一刻的三个参数记进配置：有专门键的模型各记各的键，其余的记成一条 JSON。 */
function rememberParams(state: VideoState, config: VideoConfig): void {
  const keys = videoConfigKeys(state.model);
  if (keys) {
    config.set(keys.aspect, state.aspect);
    config.set(keys.resolution, state.resolution);
    config.set(keys.duration, state.duration);
    return;
  }
  const { aspect, resolution, duration } = state;
  config.set(videoParamsKey(state.model), JSON.stringify({ aspect, resolution, duration }));
}

/** 值在该模型的选项里就留下，不在就落到它的默认值。 */
function inOptions(options: readonly string[], value: unknown, fallback: string): string {
  return typeof value === "string" && options.includes(value) ? value : fallback;
}

/**
 * 对应 _apply_model_options：按模型重刷比例、分辨率和时长的范围，并恢复该模型上次的参数；
 * 取值不在该模型的选项里就落到它的默认值。只读配置，写入由生成时补上。
 */
function withModel(state: VideoState, model: string, config: VideoConfig): VideoState {
  const [minDuration, maxDuration] = videoDurationBounds(model);
  const saved = rememberedParams(model, config);
  const aspect = inOptions(videoAspectOptions(model), saved.aspect, videoDefaultAspect(model));
  const resolution = inOptions(videoResolutions(model), saved.resolution, videoDefaultResolution(model));
  // 时长读不出来按 5；再按模型的范围和这个分辨率的上限收进来，这一步不提示
  const duration = Math.max(
    minDuration,
    Math.min(pyInt(saved.duration) ?? DEFAULT_DURATION, videoDurationLimit(model, resolution), maxDuration),
  );
  return { ...state, model, aspect, resolution, duration };
}

/** 页面刚建好时的样子：上次用的模型（认不出用第一个）和它记住的参数。 */
export function initialState(config: VideoConfig): VideoState {
  const remembered = config.get("video_last_model", VIDEO_MODELS[0].id);
  const model = typeof remembered === "string" && VIDEO_MODEL_IDS.includes(remembered) ? remembered : VIDEO_MODELS[0].id;
  const blank: VideoState = { model, aspect: "", resolution: "", duration: DEFAULT_DURATION };
  return withModel(blank, model, config);
}

/** 对应 on_model_changed：换模型，按它重填各项。 */
export function changeModel(state: VideoState, model: string, config: VideoConfig): VideoState {
  return withModel(state, model, config);
}

/** 时长输入框的范围就是模型的时长范围，越界的收进来，与源项目的 SpinBox 一致。 */
export function clampDuration(model: string, value: number): number {
  const [minDuration, maxDuration] = videoDurationBounds(model);
  return Math.min(maxDuration, Math.max(minDuration, Math.trunc(value)));
}

/** 当前模型与分辨率下实际允许的时长范围 [min, max]。 */
export function effectiveDurationBounds(model: string, resolution: string): [number, number] {
  const [minDuration, maxDuration] = videoDurationBounds(model);
  return [minDuration, Math.min(maxDuration, videoDurationLimit(model, resolution))];
}

export type DurationValidation =
  | { ok: true; value: number }
  | { ok: false; min: number; max: number };

/** 校验用户输入的视频时长：必须是当前模型和分辨率允许范围内的整数。 */
export function validateDurationInput(text: string, model: string, resolution: string): DurationValidation {
  const [min, max] = effectiveDurationBounds(model, resolution);
  const trimmed = text.trim();
  if (!/^-?\d+$/.test(trimmed)) return { ok: false, min, max };
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < min || value > max) return { ok: false, min, max };
  return { ok: true, value };
}

export interface ResolutionChange {
  state: VideoState;
  /** 时长被封顶时的上限，界面据此给 video.duration_capped 提示；没封顶是 null。 */
  cappedAt: number | null;
}

/** 对应 on_resolution_changed：换到上限更低的分辨率时时长跟着封顶。 */
export function changeResolution(state: VideoState, resolution: string): ResolutionChange {
  const limit = videoDurationLimit(state.model, resolution);
  const next: VideoState = { ...state, resolution };
  if (state.duration <= limit) return { state: next, cappedAt: null };
  return { state: { ...next, duration: limit }, cappedAt: limit };
}

/** 对应 on_generate 里读种子的那几步：留空是 null，由请求构造给每次尝试随机一个；解不出整数返回 "invalid"。 */
export function parseSeed(text: string): { seed: number | null } | "invalid" {
  const trimmed = text.trim();
  if (trimmed === "") return { seed: null };
  const seed = pyInt(trimmed);
  return seed === null ? "invalid" : { seed };
}

/** 一次生成里每个任务都一样的参数；提示词和素材由页面另外填。 */
export interface VideoTaskParams {
  model: string;
  aspectRatio: string;
  /** 分辨率。 */
  imageSize: string;
  duration: number;
  /** 整数，留空是 null。 */
  seed: number | null;
}

/**
 * 对应 on_generate 里算参数、记配置的那几步。种子解不出时返回 "seed_invalid"，这时什么都不写。
 * 时长按当前分辨率的上限再收一次：从历史恢复来的时长可能高于这个上限，而输入框的范围只有模型的上下限。
 */
export function taskParams(state: VideoState, seedText: string, config: VideoConfig): VideoTaskParams | "seed_invalid" {
  const parsed = parseSeed(seedText);
  if (parsed === "invalid") return "seed_invalid";
  const [minDuration, maxDuration] = videoDurationBounds(state.model);
  const duration = Math.max(
    minDuration,
    Math.min(state.duration, videoDurationLimit(state.model, state.resolution), maxDuration),
  );
  rememberParams({ ...state, duration }, config);
  config.set("video_last_model", state.model);
  return { model: state.model, aspectRatio: state.aspect, imageSize: state.resolution, duration, seed: parsed.seed };
}

/** 历史记录里的参考音频：旧记录可能存的是一个路径，也可能是路径数组。 */
export function refAudiosOf(task: HistoryTask): string[] {
  const raw = task.ref_audios;
  if (!raw) return [];
  const paths = Array.isArray(raw) ? raw : [raw];
  return paths.filter((path): path is string => typeof path === "string" && path !== "");
}

/** 历史记录里的参考视频路径列表。 */
export function refVideosOf(task: HistoryTask): string[] {
  const raw = task.ref_videos;
  if (!raw) return [];
  const paths = Array.isArray(raw) ? raw : [raw];
  return paths.filter((path): path is string => typeof path === "string" && path !== "");
}

/** 历史记录里的参考视频附加参数列表，与 ref_videos 按下标对应。 */
export function refVideoOptionsOf(task: HistoryTask): VideoReferenceOption[] {
  const raw = task.ref_video_options;
  return Array.isArray(raw) ? raw : [];
}

export type VideoRefValidation =
  | { ok: true }
  | { ok: false; kind: "total_too_long"; total: number; max: number }
  | { ok: false; kind: "start_invalid"; max: number };

/**
 * 提交前的两道参考视频检查：
 * 1. 有 maxVideoSeconds 的模型，已知时长的视频加起来不能超过上限；
 * 2. 带 startSeconds 的模型，起始秒数必须是 >= 0 的整数，且不能大于视频总秒数。
 */
export function validateVideoRefs(
  videos: readonly VideoReference[],
  spec: Pick<VideoModelSpec, "maxVideos" | "maxVideoSeconds" | "videoFields">,
): VideoRefValidation {
  if (spec.maxVideos <= 0 || videos.length === 0) return { ok: true };
  const active = videos.slice(0, spec.maxVideos);

  if (spec.maxVideoSeconds !== undefined) {
    let total = 0;
    for (const item of active) {
      if (typeof item.durationSeconds === "number" && Number.isFinite(item.durationSeconds) && item.durationSeconds > 0) {
        total += item.durationSeconds;
      }
    }
    if (total > spec.maxVideoSeconds) {
      return { ok: false, kind: "total_too_long", total: Math.round(total * 10) / 10, max: spec.maxVideoSeconds };
    }
  }

  if (spec.videoFields?.includes("startSeconds")) {
    for (const item of active) {
      if (item.startSeconds === null) continue;
      const knownDuration =
        typeof item.durationSeconds === "number" && Number.isFinite(item.durationSeconds) && item.durationSeconds > 0
          ? Math.floor(item.durationSeconds)
          : null;
      if (!Number.isInteger(item.startSeconds) || item.startSeconds < 0) {
        return { ok: false, kind: "start_invalid", max: knownDuration ?? 0 };
      }
      if (knownDuration !== null && item.startSeconds > knownDuration) {
        return { ok: false, kind: "start_invalid", max: knownDuration };
      }
    }
  }

  return { ok: true };
}

export interface RestoreResult {
  state: VideoState;
  /** 输入框里的种子文字；记录里没有种子是空串。 */
  seedText: string;
  /** 换到记录里的分辨率时时长被封顶的上限，界面据此给提示；没封顶是 null。 */
  cappedAt: number | null;
  /** 记录里带首帧或尾帧、模型又支持：切到首尾帧模式。 */
  framesMode: boolean;
}

/**
 * 对应 apply_history_task 里改表单的那几步，只回填，不提交。
 * 模型认不出按第一个；比例、分辨率不在该模型的选项里就保持前一步恢复出来的。
 * 换分辨率时先按时长的上限封顶一次（与源项目同一个顺序，提示也出在这里），
 * 再按记录改时长，这一步只受模型的上下限约束。
 */
export function restoreTask(state: VideoState, task: HistoryTask, config: VideoConfig): RestoreResult {
  const model = VIDEO_MODEL_IDS.includes(task.model) ? task.model : VIDEO_MODELS[0].id;
  let next = withModel(state, model, config);
  next = {
    ...next,
    aspect: inOptions(videoAspectOptions(model), task.aspect_ratio || videoDefaultAspect(model), videoDefaultAspect(model)),
  };
  let cappedAt: number | null = null;
  const resolution = task.image_size || videoDefaultResolution(model);
  if (videoResolutions(model).includes(resolution)) {
    const changed = changeResolution(next, resolution);
    next = changed.state;
    cappedAt = changed.cappedAt;
  }
  const [minDuration, maxDuration] = videoDurationBounds(model);
  // 记录里没有时长或读不出：用这个模型记住的时长
  const duration = pyInt(task.duration) ?? pyInt(rememberedParams(model, config).duration) ?? DEFAULT_DURATION;
  const seed = pyInt(task.seed);
  return {
    state: { ...next, duration: Math.max(minDuration, Math.min(duration, maxDuration)) },
    seedText: seed === null ? "" : String(seed),
    cappedAt,
    framesMode: videoSupportsFrames(model) && Boolean(task.first_frame || task.last_frame),
  };
}
