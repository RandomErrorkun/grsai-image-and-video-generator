/**
 * Grsai 接口的请求构造与响应判定（对应 core/api_client.py）。
 *
 * 这里只拼请求、判响应，不碰网络；发送在 platform 的 http 里。
 * 请求体的每一处钳制和回退都以源码为准，单测逐条盯着。
 */
import {
  imageModelSpec,
  LEGACY_IMAGE_MODEL_ALIASES,
  VIDEO_MODEL_SET,
  videoAspectOptions,
  videoDefaultAspect,
  videoDefaultResolution,
  videoDurationBounds,
  videoDurationLimit,
  videoResolutions,
  videoSupportsFrames,
} from "./modelCatalog";
import { bytesToBase64, pyInt, pyStr } from "./py";

export const DEFAULT_API_BASE_URL = "https://grsai.dakka.com.cn";
export const GENERATE_PATH = "/v1/api/generate";
export const RESULT_PATH = "/v1/api/result";
export const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";

/** 各请求的超时秒数，与源项目一致。 */
export const SUBMIT_TIMEOUT_SECS = 60;
export const RESULT_TIMEOUT_SECS = 30;
export const CHAT_TIMEOUT_SECS = 120;
export const DOWNLOAD_TIMEOUT_SECS = 120;

/** 源项目里同样按旧名处理的两个对话模型名。 */
const LEGACY_COMPLETION_MODELS: ReadonlySet<string> = new Set(["sora-2", "veo3.1-fast-1080p"]);

/** 只认自有键的查表，与 dict.get 一致。 */
function lookup<V>(table: Readonly<Record<string, V>>, key: unknown): V | undefined {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(table, key)
    ? table[key]
    : undefined;
}

/** 一次 HTTP 请求的全部内容。超时按 requests 的含义：一个管连接，一个管每次读取。 */
export interface HttpRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
  connectTimeoutSecs: number;
  readTimeoutSecs: number;
}

/**
 * 一次 HTTP 调用的下场。网络问题用这三种结果表达，不靠解析错误字符串。
 * not_sent 的请求可以放心重试；unknown 的请求服务端可能已经处理过。
 */
export type HttpOutcome =
  | { outcome: "responded"; status: number; body: string }
  | { outcome: "not_sent"; message: string }
  | { outcome: "unknown"; message: string; status: number | null };

export interface ApiSettings {
  apiBaseUrl: unknown;
  apiKey: unknown;
}

/** Base URL：去空白，空了就用默认值。 */
export function resolveBaseUrl(apiBaseUrl: unknown): string {
  const base = typeof apiBaseUrl === "string" ? apiBaseUrl.trim() : "";
  return base || DEFAULT_API_BASE_URL;
}

function baseUrl(settings: ApiSettings): string {
  return resolveBaseUrl(settings.apiBaseUrl).replace(/\/+$/, "");
}

function bearerHeaders(apiKey: unknown): Record<string, string> {
  return { Authorization: `Bearer ${pyStr(apiKey)}` };
}

function jsonHeaders(apiKey: unknown): Record<string, string> {
  return { "Content-Type": "application/json", ...bearerHeaders(apiKey) };
}

export interface GenerateParams {
  prompt: string;
  model: string;
  aspectRatio?: string | null;
  /** 图像模型是尺寸；视频模型是分辨率。 */
  imageSize?: string | null;
  refImageUrls?: string[] | null;
  quality?: string | null;
  background?: string | null;
  outputFormat?: string | null;
  duration?: number | string | null;
  seed?: number | string | null;
  refAudios?: string[] | null;
  firstFrame?: string | null;
  lastFrame?: string | null;
  refVideos?: string[] | null;
}

/** 旧模型名换成现行模型名。 */
export function normalizeLegacyModel(model: unknown): unknown {
  return lookup(LEGACY_IMAGE_MODEL_ALIASES, model) ?? model;
}

/** 随机种子：1 到 2^31-1，两端都取得到。 */
function randomSeed(): number {
  return 1 + Math.floor(Math.random() * (2 ** 31 - 1));
}

/** Python 的真假判断：None、False、0、空串、空列表都算假。 */
function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
  return !(Array.isArray(value) && value.length === 0);
}

/** `x or []`：x 为假时给空列表。 */
function orEmpty(value: readonly string[] | null | undefined): string[] {
  return truthy(value) ? [...(value as string[])] : [];
}

/**
 * 按模型家族构造 /v1/api/generate 的请求体（不含 replyType）。
 * 模型不认识时返回 null。
 */
export function buildGeneratePayload(params: GenerateParams): Record<string, unknown> | null {
  const model = normalizeLegacyModel(params.model);
  const spec = typeof model === "string" ? imageModelSpec(model) : null;

  if (spec?.family === "banana") {
    const payload: Record<string, unknown> = {
      model,
      prompt: params.prompt,
      aspectRatio: params.aspectRatio || "auto",
    };
    // 源项目的 image_size 默认值是 "1K"，没给时也要带上
    const imageSize = params.imageSize === undefined ? "1K" : params.imageSize;
    if (spec.sizes && imageSize) {
      payload.imageSize = spec.sizes.includes(imageSize) ? imageSize : spec.sizes[0];
    }
    if (truthy(params.refImageUrls)) payload.images = params.refImageUrls;
    return payload;
  }

  // 源项目里同样按旧名处理的两个对话模型名，没有条目，按 gpt 系的默认值走
  if (spec?.family === "gpt" || (typeof model === "string" && LEGACY_COMPLETION_MODELS.has(model))) {
    const payload: Record<string, unknown> = {
      model,
      prompt: params.prompt,
      aspectRatio: params.aspectRatio || "auto",
    };
    const qualityOptions = spec?.qualities ?? ["auto"];
    payload.quality =
      params.quality !== null && (qualityOptions as readonly unknown[]).includes(params.quality)
        ? params.quality
        : qualityOptions[0];
    if (params.background === "transparent" && spec?.transparent === true) {
      payload.background = "transparent";
    }
    // outputFormat 仅 2.6 系列支持；非法取值回退到该模型第一个可选格式
    const formatOptions = spec?.outputFormats;
    if (formatOptions) {
      payload.outputFormat = formatOptions.includes(params.outputFormat ?? "")
        ? params.outputFormat
        : formatOptions[0];
    }
    if (truthy(params.refImageUrls)) payload.images = params.refImageUrls;
    return payload;
  }

  if (typeof model === "string" && VIDEO_MODEL_SET.has(model)) {
    const resolutions = videoResolutions(model) as readonly unknown[];
    const resolution = params.imageSize != null && resolutions.includes(params.imageSize)
      ? (params.imageSize as string)
      : videoDefaultResolution(model);
    const aspects = videoAspectOptions(model);
    const [minDuration, maxDuration] = videoDurationBounds(model);
    const durationValue = pyInt(params.duration) ?? 5;
    // 时长上限按各模型 spec 收窄（wan-3.0 支持 30 秒，没有全局 15 秒钳制）
    const duration = Math.max(
      minDuration,
      Math.min(durationValue, videoDurationLimit(model, resolution), maxDuration),
    );
    const seed = pyInt(params.seed) ?? randomSeed();
    const payload: Record<string, unknown> = {
      model,
      prompt: params.prompt,
      aspectRatio: aspects.includes(params.aspectRatio ?? "") ? params.aspectRatio : videoDefaultAspect(model),
      images: orEmpty(params.refImageUrls),
      audios: orEmpty(params.refAudios),
      seed,
      resolution,
      duration,
    };
    // 首尾帧与参考图、参考音频互斥：只要给了一帧就不再带 images 和 audios；
    // 仅对接口提供该参数的模型生效
    if ((params.firstFrame || params.lastFrame) && videoSupportsFrames(model)) {
      delete payload.images;
      delete payload.audios;
      if (params.firstFrame) payload.firstFrame = params.firstFrame;
      if (params.lastFrame) payload.lastFrame = params.lastFrame;
    }
    // 参考视频：上游开放后按文档接入，目前所有模型的上限都是 0
    if (truthy(params.refVideos)) payload.videos = params.refVideos;
    return payload;
  }

  return null;
}

const MIME_BY_KIND: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  audio: { mp3: "mpeg", wav: "wav", m4a: "mp4", aac: "aac", flac: "flac", ogg: "ogg" },
  video: { mp4: "mp4", webm: "webm", mov: "quicktime", mkv: "x-matroska", avi: "x-msvideo" },
};

/** 扩展名（不带点、已转小写）到 MIME 子类型。 */
export function mimeForExtension(ext: string, mediaKind: string): string {
  if (mediaKind === "audio") return lookup(MIME_BY_KIND.audio, ext) ?? "mpeg";
  if (mediaKind === "video") return lookup(MIME_BY_KIND.video, ext) ?? "mp4";
  return ext === "jpg" ? "jpeg" : ext;
}

function extensionOf(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return dot > slash ? filePath.slice(dot + 1).toLowerCase() : "";
}

/** 本地文件内容转 data URI。 */
export function bytesToDataUri(bytes: Uint8Array, filePath: string, mediaKind: string): string {
  const mime = mimeForExtension(extensionOf(filePath), mediaKind);
  return `data:${mediaKind}/${mime};base64,${bytesToBase64(bytes)}`;
}

export interface LocalFiles {
  /** 路径是否指向一个本地文件。不是文件的路径按地址原样透传。 */
  isFile(path: string): Promise<boolean>;
  /** 读取本地文件；读不了返回 null，这一项就被丢弃。 */
  read(path: string): Promise<Uint8Array | null>;
}

/**
 * 把一组路径里的本地文件转成 data URI；http(s) 地址和现成的 data URI 原样透传。
 * 是文件却读不了的直接丢弃。一条都不剩时返回 null，与源项目一致。
 */
export async function convertPathsToDataUris(
  paths: readonly string[] | null | undefined,
  mediaKind: string,
  files: LocalFiles,
): Promise<string[] | null> {
  if (!paths) return null;
  const converted: string[] = [];
  for (const path of paths) {
    if (!(await files.isFile(path))) {
      converted.push(path);
      continue;
    }
    const bytes = await files.read(path);
    if (bytes) converted.push(bytesToDataUri(bytes, path, mediaKind));
  }
  return converted.length ? converted : null;
}

export interface ChatMessage {
  role: string;
  content: unknown;
}

/**
 * 对话消息里的本地图片路径转成 data URI。
 * image_url 既可能是 {"url": ...}，也可能直接是地址字符串。
 */
export async function normalizeChatMessages(
  messages: readonly unknown[] | null | undefined,
  files: LocalFiles,
): Promise<unknown[]> {
  if (!messages) return [];
  const toDataUri = async (url: unknown): Promise<string | null> => {
    if (typeof url !== "string" || !(await files.isFile(url))) return null;
    const bytes = await files.read(url);
    return bytes ? bytesToDataUri(bytes, url, "image") : null;
  };
  const result: unknown[] = [];
  for (const message of messages) {
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      result.push(message);
      continue;
    }
    const normalized = { ...(message as Record<string, unknown>) };
    const content = normalized.content;
    if (!Array.isArray(content)) {
      result.push(normalized);
      continue;
    }
    const normalizedContent: unknown[] = [];
    for (const item of content) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        normalizedContent.push(item);
        continue;
      }
      const normalizedItem = { ...(item as Record<string, unknown>) };
      if (normalizedItem.type === "image_url") {
        const imageUrl = normalizedItem.image_url;
        if (typeof imageUrl === "object" && imageUrl !== null && !Array.isArray(imageUrl)) {
          const dataUri = await toDataUri((imageUrl as Record<string, unknown>).url);
          if (dataUri) {
            normalizedItem.image_url = { ...(imageUrl as Record<string, unknown>), url: dataUri };
          }
        } else {
          const dataUri = await toDataUri(imageUrl);
          if (dataUri) normalizedItem.image_url = { url: dataUri };
        }
      }
      normalizedContent.push(normalizedItem);
    }
    normalized.content = normalizedContent;
    result.push(normalized);
  }
  return result;
}

/** /v1/api/generate 的完整提交请求。 */
export function buildSubmitRequest(params: GenerateParams, settings: ApiSettings): HttpRequest {
  const payload = buildGeneratePayload(params);
  if (payload === null) throw new Error(`Unknown model: ${pyStr(normalizeLegacyModel(params.model))}`);
  const body: Record<string, unknown> = { ...payload, replyType: "async" };
  return {
    method: "POST",
    url: `${baseUrl(settings)}${GENERATE_PATH}`,
    headers: jsonHeaders(settings.apiKey),
    body: JSON.stringify(body),
    connectTimeoutSecs: SUBMIT_TIMEOUT_SECS,
    readTimeoutSecs: SUBMIT_TIMEOUT_SECS,
  };
}

/** 查询任务结果的请求。 */
export function buildResultRequest(taskId: string, settings: ApiSettings): HttpRequest {
  const query = new URLSearchParams({ id: taskId }).toString();
  return {
    method: "GET",
    url: `${baseUrl(settings)}${RESULT_PATH}?${query}`,
    headers: bearerHeaders(settings.apiKey),
    connectTimeoutSecs: RESULT_TIMEOUT_SECS,
    readTimeoutSecs: RESULT_TIMEOUT_SECS,
  };
}

/** chat completions 的请求。 */
export function buildChatRequest(
  model: string,
  messages: readonly unknown[],
  options: { stream?: boolean; temperature?: number | null },
  settings: ApiSettings,
): HttpRequest {
  const payload: Record<string, unknown> = { model, stream: options.stream ?? false, messages };
  if (options.temperature !== null && options.temperature !== undefined) {
    payload.temperature = options.temperature;
  }
  return {
    method: "POST",
    url: `${baseUrl(settings)}${CHAT_COMPLETIONS_PATH}`,
    headers: jsonHeaders(settings.apiKey),
    body: JSON.stringify(payload),
    connectTimeoutSecs: CHAT_TIMEOUT_SECS,
    readTimeoutSecs: CHAT_TIMEOUT_SECS,
  };
}

/** 一份已准备好的提交材料：请求体里的本地文件已转成 data URI。 */
export interface PreparedSubmission {
  params: GenerateParams;
  request: HttpRequest;
}

/**
 * 提交前的准备：把参考图、参考音频、首尾帧和参考视频里的本地文件转成 data URI。
 * 首尾帧是单图，转完取第一项；地址原样透传。
 */
export async function prepareSubmission(
  params: GenerateParams,
  settings: ApiSettings,
  files: LocalFiles,
): Promise<PreparedSubmission | { error: string }> {
  const normalized = { ...params, model: normalizeLegacyModel(params.model) as string };
  const singleFrame = async (frame: string | null | undefined): Promise<string | undefined> =>
    frame ? ((await convertPathsToDataUris([frame], "image", files)) ?? [undefined])[0] : undefined;
  const [refImageUrls, refAudios, firstFrame, lastFrame, refVideos] = await Promise.all([
    convertPathsToDataUris(params.refImageUrls, "image", files),
    convertPathsToDataUris(params.refAudios, "audio", files),
    singleFrame(params.firstFrame),
    singleFrame(params.lastFrame),
    convertPathsToDataUris(params.refVideos, "video", files),
  ]);
  const prepared: GenerateParams = {
    ...normalized,
    refImageUrls,
    refAudios,
    firstFrame,
    lastFrame,
    refVideos,
  };
  try {
    return { params: prepared, request: buildSubmitRequest(prepared, settings) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** 提交接口的判定结果：成功时 code 为 0 并带原始响应。 */
export type SubmitResult =
  | { code: 0; data: Record<string, unknown> }
  | { code: -1; msg: string; status?: unknown };

function parseJsonObject(text: string): Record<string, unknown> | null | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

/**
 * 提交响应的判定：HTTP 200 且 JSON 里带 id 才算成功，其余一律按失败处理。
 * 返回 undefined 表示响应不是合法 JSON。
 */
export function parseSubmitResponse(status: number, text: string): SubmitResult {
  const data = parseJsonObject(text);
  if (data === undefined) return { code: -1, msg: `HTTP ${status}: invalid JSON response` };
  if (status === 200 && data && data.id) return { code: 0, data };
  if (data) {
    const raw = data.error || data.msg || `HTTP ${status}`;
    return { code: -1, msg: typeof raw === "string" ? raw : pyStr(raw), status: data.status };
  }
  return { code: -1, msg: `HTTP ${status}: ${pyStr(JSON.parse(text))}` };
}

/** 查询接口的判定结果。成功判定同样是 HTTP 200 且带 id；出错时把原因放进 error。 */
export type TaskResultQuery =
  | { code: 0; data: Record<string, unknown> }
  | { code: -1; error: string };

export function parseTaskResult(status: number, text: string): TaskResultQuery {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { code: -1, error: `HTTP ${status}: invalid JSON response` };
  }
  if (typeof data === "object" && data !== null && !Array.isArray(data) && (data as Record<string, unknown>).id) {
    return { code: 0, data: data as Record<string, unknown> };
  }
  const summary = pyStr(data).slice(0, 200);
  return { code: -1, error: status === 200 ? summary : `HTTP ${status}: ${summary}` };
}

const REASON_PHRASES: Readonly<Record<number, string>> = {
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  408: "Request Timeout",
  409: "Conflict",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

/** chat completions 的判定结果。出错时带一条与 requests 的 raise_for_status 同款的说明。 */
export type ChatResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; message: string };

export function parseChatResponse(status: number, text: string, url: string): ChatResult {
  const fail = (message: string): ChatResult => ({ ok: false, message });
  if (status < 200 || status >= 300) {
    const kind = status >= 500 ? "Server" : "Client";
    const reason = lookup(REASON_PHRASES, status) ?? "None";
    return fail(`${status} ${kind} Error: ${reason} for url: ${url}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return fail(`Expecting value: line 1 column 1 (char 0)`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return fail(`chat completions returned ${pyStr(data)}`);
  }
  return { ok: true, data: data as Record<string, unknown> };
}
