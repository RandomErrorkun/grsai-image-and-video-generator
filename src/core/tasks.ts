/**
 * 任务调度器（对应 core/task_manager.py 的 TaskWorker，并按手册第 5 节改写）。
 *
 * - 所有提交与轮询都经这一个异步调度器；
 * - 提交有并发闸，同时在途的提交请求数有上限；
 * - 提交失败时区分「没送达」和「已发出但结果不明」，后者不能盲目自动重试；
 * - 提交响应一回来就上报服务端任务 id，不等首次轮询。
 *
 * 生命周期、轮询节奏、文件命名和失败分类都以源码为准。
 */
import {
  buildGeneratePayload,
  buildResultRequest,
  isTaskNotFoundResponse,
  normalizeLegacyModel,
  parseSubmitResponse,
  parseTaskResult,
  prepareSubmission,
  type GenerateParams,
  type HttpOutcome,
  type HttpRequest,
  type LocalFiles,
} from "./api";
import type { HistoryStore } from "./history";
import { VIDEO_MODEL_SET } from "./modelCatalog";
import { formatFileTime, pyInt, pyStr } from "./py";

/** 结果地址里能认出的扩展名；认不出时视频用 mp4，其余用 png。 */
export const RESULT_URL_EXTENSIONS = [
  ".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg", ".mp4", ".webm", ".mov", ".avi", ".mkv",
] as const;

/**
 * 源项目下载结果时不检查状态码，服务端的出错页也会被当成图片存下来。
 * 这里不存这种文件，属于待用户确认的差异。
 */
const REQUIRE_SUCCESS_STATUS_FOR_DOWNLOAD = true;

/** 两次轮询之间的间隔，以及连续多少次查询出错后放弃。 */
const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ERRORS = 10;

export interface TaskSpec extends GenerateParams {
  /** 不给就用配置里的 output_folder。 */
  outputDir?: string | null;
  filenamePrefix?: string | null;
  /** 历史任务再获取/接续时可指定已有文件路径；文件若已在磁盘上则直接复用不重下。 */
  preferredResultPath?: string | null;
  /** 历史任务再获取/接续时使用的确定性文件主名（不含扩展名），确保同一任务多次获取不产生重复文件。 */
  deterministicStem?: string | null;
  /** 成功后是否清空历史记录里旧的失败原因（仅用于从失败/过期状态恢复的历史任务）。 */
  clearFailureOnSuccess?: boolean;
}

/** 单次查询 /v1/api/result 后的结构化分类结果。 */
export type TaskProbeResult =
  | { kind: "running"; progress: number; status: string }
  | { kind: "succeeded"; progress: number; status: "succeeded"; data: Record<string, unknown> }
  | { kind: "failed"; progress: number; status: "failed" | "violation"; failureReason: string; errorMessage: string }
  | { kind: "expired"; errorMessage: string }
  | { kind: "network_error"; message: string }
  | { kind: "processing_error"; message: string };

/** 下载结果并写回历史库的返回结果。 */
export type DownloadResultsOutcome =
  | { ok: true; resultPath: string | null; previewUrl: string | null; reused: boolean }
  | { ok: false; reason: string; failureReason: string };

export interface TaskDeps {
  /** 每次用到时才读，设置改了立刻生效。 */
  settings(): { apiBaseUrl: unknown; apiKey: unknown; outputFolder: unknown };
  files: LocalFiles & {
    exists(path: string): Promise<boolean>;
    makeDirs(path: string): Promise<void>;
    join(...parts: string[]): string;
  };
  history: Pick<HistoryStore, "addTask" | "updateTask">;
  http: {
    submit(request: HttpRequest): Promise<HttpOutcome>;
    query(request: HttpRequest): Promise<HttpOutcome>;
    /** 把地址下载到 destPath，只在完整收到内容后才落盘。 */
    download(url: string, destPath: string): Promise<HttpOutcome>;
  };
  /** 结果文件落盘后可选地生成持久化缩略图与 SHA-256，供历史库保存。失败不阻断任务完成。 */
  artifacts?(path: string): Promise<{ thumbnail?: string | null; resultSha256?: string | null }>;
  now?: () => Date;
  sleep?(ms: number): Promise<void>;
  log?(message: string): void;
}

/** 提交没成功时，说明请求到底发出去没有。 */
export type FailureDelivery = "not_sent" | "unknown";

export type TaskEvent =
  /** 提交材料已备好，正在并发闸里排队等空位。 */
  | { type: "queued" }
  /** 过了并发闸，提交请求正在路上。 */
  | { type: "submitting" }
  | { type: "submitted"; taskId: string }
  | { type: "progress"; progress: number; status: string }
  | { type: "succeeded"; resultPath: string | null }
  | { type: "failed"; reason: string; failureReason: string; delivery?: FailureDelivery };

export interface TaskHandle {
  id: number;
  /** 停止跟进这个任务。已经提交到服务端的任务不受影响。 */
  cancel(): void;
  done: Promise<void>;
}

export interface TaskSchedulerOptions {
  /** 同时在途的提交请求数上限，至少为 1。每次提交时读取，所以设置改了立刻生效。 */
  submitConcurrency?: () => number;
}

interface CancellationToken {
  stopped: boolean;
}

class TaskCancelled extends Error {
  constructor() {
    super("task cancelled");
  }
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : pyStr(error);

/** 按地址后缀认扩展名（问号后的部分不算），认不出用 defaultExt。 */
export function extensionForUrl(url: unknown, defaultExt: string): string {
  const path = pyStr(url ?? "")
    .toLowerCase()
    .split("?")[0];
  for (const ext of RESULT_URL_EXTENSIONS) {
    if (path.endsWith(ext)) return ext.slice(1);
  }
  return defaultExt;
}

/** 结果文件去掉序号和扩展名的那部分：grsai_<时间戳>，有前缀时是 grsai_<前缀>_<时间戳>。 */
export function resultFileStem(prefix: string | null | undefined, timestamp: string): string {
  const cleaned = (prefix ?? "").trim();
  return cleaned ? `grsai_${cleaned}_${timestamp}` : `grsai_${timestamp}`;
}

/**
 * 为某个历史任务生成唯一且确定的文件主名（不含扩展名），格式符合 grsai_* 约定：
 * 同一任务多次点击「再获取」始终映射到同一路径，不会产生重复副本。
 */
export function deterministicResultStem(createdAt: string | null | undefined, taskId: string): string {
  const stamp = (createdAt ?? "").trim().replace(/[\s:]+/g, "-").replace(/[^0-9A-Za-z_-]/g, "");
  const safeId = taskId.replace(/[^0-9A-Za-z_-]/g, "").slice(0, 16) || "task";
  return stamp ? `grsai_${stamp}_${safeId}` : `grsai_${safeId}`;
}

/** 提交并发闸：超过上限的提交严格按先来后到排队，释放槽位时精确唤醒需要补位的任务，避免惊群。 */
class SubmissionGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: () => number) {}

  /** 同步预占名额再唤醒对应数量的等待者，防止所有等待者一起被唤醒或被新任务插队。 */
  private admit(): void {
    const max = Math.max(1, this.limit());
    while (this.waiting.length > 0 && this.active < max) {
      this.active += 1;
      this.waiting.shift()?.();
    }
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    const max = Math.max(1, this.limit());
    if (this.active >= max || this.waiting.length > 0) {
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
      });
    } else {
      this.active += 1;
    }
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.admit();
    }
  }
}

export class TaskScheduler {
  private counter = 0;
  private readonly running = new Map<number, CancellationToken>();
  private readonly gate: SubmissionGate;
  private readonly deps: TaskDeps;

  constructor(deps: TaskDeps, options: TaskSchedulerOptions = {}) {
    this.deps = deps;
    this.gate = new SubmissionGate(options.submitConcurrency ?? (() => 1));
  }

  /** 正在跟进的任务数，含还在排队的提交。 */
  get activeCount(): number {
    return this.running.size;
  }

  /** 启动一个任务，过程通过 onEvent 上报。 */
  start(spec: TaskSpec, onEvent: (event: TaskEvent) => void): TaskHandle {
    const id = ++this.counter;
    const token: CancellationToken = { stopped: false };
    this.running.set(id, token);
    const done = this.run(spec, token, onEvent).finally(() => {
      this.running.delete(id);
    });
    return {
      id,
      cancel: () => {
        token.stopped = true;
      },
      done,
    };
  }

  /** 接续一个已提交到服务端的历史任务：直接进入轮询与结果下载，不重新提交。 */
  resume(taskId: string, spec: TaskSpec, onEvent: (event: TaskEvent) => void): TaskHandle {
    const id = ++this.counter;
    const token: CancellationToken = { stopped: false };
    this.running.set(id, token);
    const emit = (event: TaskEvent) => {
      if (!token.stopped) onEvent(event);
    };
    const done = (async () => {
      try {
        emit({ type: "submitted", taskId });
        await this.poll(spec, taskId, token, emit);
      } catch (error) {
        emit({ type: "failed", reason: errorText(error), failureReason: "Unexpected Error" });
      }
    })().finally(() => {
      this.running.delete(id);
    });
    return {
      id,
      cancel: () => {
        token.stopped = true;
      },
      done,
    };
  }

  /** 对指定服务端任务 ID 发起单次 /v1/api/result 查询并返回结构化分类。 */
  async probeOnce(taskId: string): Promise<TaskProbeResult> {
    let outcome: HttpOutcome;
    try {
      outcome = await this.deps.http.query(buildResultRequest(taskId, this.deps.settings()));
    } catch (error) {
      return { kind: "network_error", message: errorText(error) };
    }
    if (outcome.outcome !== "responded") {
      return { kind: "network_error", message: outcome.message };
    }
    const parsed = parseTaskResult(outcome.status, outcome.body);
    if (parsed.code !== 0) {
      if (isTaskNotFoundResponse(outcome.status, outcome.body)) {
        return { kind: "expired", errorMessage: parsed.error };
      }
      return { kind: "network_error", message: parsed.error };
    }
    const data = parsed.data;
    const status = data.status;
    const progress = pyInt("progress" in data ? data.progress : 0);
    if (progress === null) {
      return {
        kind: "processing_error",
        message: "int() argument must be a string, a bytes-like object or a real number",
      };
    }
    if (status === "succeeded") {
      return { kind: "succeeded", progress, status: "succeeded", data };
    }
    if (status === "failed" || status === "violation") {
      const failureReason = data.failure_reason
        ? pyStr(data.failure_reason)
        : status === "violation"
          ? "violation"
          : "Unknown";
      const rawError = "error" in data ? data.error : "";
      const errorMessage = rawError ? pyStr(rawError) : "";
      return { kind: "failed", progress, status, failureReason, errorMessage };
    }
    return { kind: "running", progress, status: pyStr(status) };
  }

  /** 停止跟进所有任务。已提交的服务端任务照常在服务端跑完，与源项目一致。 */
  cancelAll(): void {
    for (const token of this.running.values()) token.stopped = true;
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private sleep(ms: number): Promise<void> {
    return (this.deps.sleep ?? ((duration: number) => new Promise((resolve) => setTimeout(resolve, duration))))(ms);
  }

  /** 分小段等待，这样取消能很快生效。返回 true 表示等待期间任务被取消。 */
  private async wait(ms: number, token: CancellationToken): Promise<boolean> {
    const slice = 500;
    for (let waited = 0; waited < ms; waited += slice) {
      if (token.stopped) return true;
      await this.sleep(slice);
    }
    return token.stopped;
  }

  private async run(spec: TaskSpec, token: CancellationToken, onEvent: (event: TaskEvent) => void) {
    const emit = (event: TaskEvent) => {
      if (!token.stopped) onEvent(event);
    };
    try {
      // 模型不认识时立刻在入队前拦截，不碰文件系统和网络
      if (buildGeneratePayload(spec) === null) {
        emit({
          type: "failed",
          reason: `Unknown model: ${pyStr(normalizeLegacyModel(spec.model))}`,
          failureReason: "Submission failed",
        });
        return;
      }

      let taskId: string;
      emit({ type: "queued" });
      try {
        // 把读取大文件转 Base64 放在并发闸里执行，避免 10 个并行任务同时把多份大媒体编码常驻内存
        const gateResult = await this.gate.run(async () => {
          if (token.stopped) throw new TaskCancelled();
          emit({ type: "submitting" });
          const prepared = await prepareSubmission(spec, this.deps.settings(), this.deps.files);
          if (token.stopped) throw new TaskCancelled();
          if ("error" in prepared) return { kind: "prep_error" as const, error: prepared.error };
          const outcome = await this.deps.http.submit(prepared.request);
          return { kind: "http" as const, outcome };
        });
        if (token.stopped) return;
        if (gateResult.kind === "prep_error") {
          emit({ type: "failed", reason: gateResult.error, failureReason: "Submission failed" });
          return;
        }
        const outcome = gateResult.outcome;
        if (outcome.outcome !== "responded") {
          emit({
            type: "failed",
            reason: outcome.message,
            failureReason: "Submission failed",
            delivery: outcome.outcome,
          });
          return;
        }
        const submit = parseSubmitResponse(outcome.status, outcome.body);
        if (submit.code !== 0) {
          emit({ type: "failed", reason: submit.msg, failureReason: "Submission failed" });
          return;
        }
        taskId = pyStr(submit.data.id);
        // 历史库的 duration 和 seed 两列是整数；界面交上来的 seed 是整数或留空
        await this.deps.history.addTask({
          id: taskId,
          prompt: spec.prompt,
          model: pyStr(spec.model),
          aspectRatio: pyStr(spec.aspectRatio),
          imageSize: pyStr(spec.imageSize),
          refImages: spec.refImageUrls ?? null,
          duration: pyInt(spec.duration),
          seed: pyInt(spec.seed),
          refAudios: spec.refAudios ?? null,
          firstFrame: spec.firstFrame ?? null,
          lastFrame: spec.lastFrame ?? null,
          refVideos: spec.refVideos ?? null,
          refVideoOptions: spec.videoOptions && spec.videoOptions.length > 0 ? [...spec.videoOptions] : null,
        });
      } catch (error) {
        if (error instanceof TaskCancelled || token.stopped) return;
        emit({ type: "failed", reason: errorText(error), failureReason: "Submission Exception" });
        return;
      }

      // 提交一成功就告诉界面服务端任务 id，不等第一次轮询
      emit({ type: "submitted", taskId });
      await this.poll(spec, taskId, token, emit);
    } catch (error) {
      emit({ type: "failed", reason: errorText(error), failureReason: "Unexpected Error" });
    }
  }

  private async poll(spec: TaskSpec, taskId: string, token: CancellationToken, emit: (event: TaskEvent) => void) {
    let errorCount = 0;
    while (!token.stopped) {
      const probe = await this.probeOnce(taskId);
      if (token.stopped) return;

      if (probe.kind === "network_error") {
        errorCount += 1;
        this.deps.log?.(`[TaskScheduler] API call error (attempt ${errorCount}): ${probe.message}`);
        if (errorCount > MAX_POLL_ERRORS) {
          emit({ type: "failed", reason: `Network error: ${probe.message}`, failureReason: "Network Error" });
          return;
        }
        if (await this.wait(POLL_INTERVAL_MS, token)) return;
        continue;
      }

      if (probe.kind === "expired") {
        await this.deps.history.updateTask(taskId, "failed", {
          failureReason: "Task expired",
          errorMessage: probe.errorMessage,
        });
        emit({
          type: "failed",
          reason: probe.errorMessage ? `Task expired: ${probe.errorMessage}` : "Task expired",
          failureReason: "Task expired",
        });
        return;
      }

      if (probe.kind === "processing_error") {
        this.deps.log?.(`[TaskScheduler] Processing error: ${probe.message}`);
        emit({ type: "failed", reason: probe.message, failureReason: "Processing Error" });
        return;
      }

      errorCount = 0;
      try {
        emit({ type: "progress", progress: probe.progress, status: probe.status });

        if (probe.kind === "succeeded") {
          await this.finish(spec, taskId, probe.data, emit);
          return;
        }
        if (probe.kind === "failed") {
          await this.deps.history.updateTask(taskId, probe.status, {
            failureReason: probe.failureReason,
            errorMessage: probe.errorMessage,
          });
          emit({
            type: "failed",
            reason: probe.errorMessage ? `${probe.failureReason}: ${probe.errorMessage}` : probe.failureReason,
            failureReason: probe.failureReason,
          });
          return;
        }
      } catch (error) {
        this.deps.log?.(`[TaskScheduler] Processing error: ${errorText(error)}`);
        emit({ type: "failed", reason: errorText(error), failureReason: "Processing Error" });
        return;
      }

      if (await this.wait(POLL_INTERVAL_MS, token)) return;
    }
  }

  /** 多结果按序号命名，不查重；单结果和别的任务撞名时追加计数。 */
  private async resolveResultPath(outputDir: string, baseStem: string, ext: string, index: number, total: number) {
    const { join, exists } = this.deps.files;
    if (total > 1) return join(outputDir, `${baseStem}_${index + 1}.${ext}`);
    const plain = join(outputDir, `${baseStem}.${ext}`);
    if (!(await exists(plain))) return plain;
    let counter = 1;
    while (await exists(join(outputDir, `${baseStem}_${counter}.${ext}`))) counter += 1;
    return join(outputDir, `${baseStem}_${counter}.${ext}`);
  }

  /**
   * 下载远端已完成任务的结果并写回历史库。
   * 当 spec 指定了 preferredResultPath 或 deterministicStem 且对应文件已在本地存在时，直接复用不重复下载。
   */
  async downloadResults(
    spec: TaskSpec,
    taskId: string,
    data: Record<string, unknown>,
  ): Promise<DownloadResultsOutcome> {
    const results = data.results ?? [];
    if (!Array.isArray(results) || results.length === 0) {
      await this.deps.history.updateTask(taskId, "failed", { failureReason: "No results found" });
      return { ok: false, reason: "No results found", failureReason: "No Results" };
    }

    const firstEntry = results[0];
    if (typeof firstEntry !== "object" || firstEntry === null || Array.isArray(firstEntry)) {
      throw new Error(`'${pyStr(firstEntry)}' object has no attribute 'get'`);
    }
    const firstUrl = (firstEntry as Record<string, unknown>).url;
    const previewUrl = firstUrl ? (typeof firstUrl === "string" ? firstUrl : pyStr(firstUrl)) : null;

    // 历史任务已记录本地路径且文件仍在磁盘上时，直接复用，不重复下载
    if (spec.preferredResultPath && (await this.deps.files.exists(spec.preferredResultPath))) {
      const extra = await this.collectArtifacts(spec.preferredResultPath);
      await this.deps.history.updateTask(taskId, "succeeded", {
        resultPath: spec.preferredResultPath,
        previewUrl,
        ...extra,
        ...(spec.clearFailureOnSuccess ? { clearFailure: true } : {}),
      });
      return { ok: true, resultPath: spec.preferredResultPath, previewUrl, reused: true };
    }

    const downloaded: string[] = [];
    let firstFile: string | null = null;
    let reusedAny = false;
    for (const [index, result] of results.entries()) {
      if (typeof result !== "object" || result === null || Array.isArray(result)) {
        throw new Error(`'${pyStr(result)}' object has no attribute 'get'`);
      }
      const imgUrl = (result as Record<string, unknown>).url;
      if (!imgUrl) continue;
      try {
        const defaultExt = VIDEO_MODEL_SET.has(spec.model) ? "mp4" : "png";
        const ext = extensionForUrl(imgUrl, defaultExt);
        const outputDir = spec.outputDir || this.deps.settings().outputFolder;
        if (typeof outputDir !== "string") {
          throw new TypeError("expected str, bytes or os.PathLike object, not NoneType");
        }
        if (!(await this.deps.files.exists(outputDir))) await this.deps.files.makeDirs(outputDir);
        let filepath: string;
        if (spec.deterministicStem) {
          const filename = results.length > 1 ? `${spec.deterministicStem}_${index + 1}.${ext}` : `${spec.deterministicStem}.${ext}`;
          filepath = this.deps.files.join(outputDir, filename);
          if (await this.deps.files.exists(filepath)) {
            downloaded.push(filepath);
            reusedAny = true;
            if (index === 0) firstFile = filepath;
            continue;
          }
        } else {
          const timestamp = formatFileTime(this.now());
          const baseStem = resultFileStem(spec.filenamePrefix, timestamp);
          filepath = await this.resolveResultPath(outputDir, baseStem, ext, index, results.length);
        }
        const outcome = await this.deps.http.download(pyStr(imgUrl), filepath);
        const succeeded =
          outcome.outcome === "responded" && outcome.status >= 200 && outcome.status < 300;
        if (!succeeded && (REQUIRE_SUCCESS_STATUS_FOR_DOWNLOAD || outcome.outcome !== "responded")) {
          throw new Error(outcome.outcome === "responded" ? `HTTP ${outcome.status}` : outcome.message);
        }
        downloaded.push(filepath);
        if (index === 0) firstFile = filepath;
      } catch (error) {
        this.deps.log?.(`[TaskScheduler] Download error for result ${index}: ${errorText(error)}`);
      }
    }

    if (downloaded.length) {
      const extra = firstFile ? await this.collectArtifacts(firstFile) : {};
      await this.deps.history.updateTask(taskId, "succeeded", {
        resultPath: firstFile,
        previewUrl,
        ...extra,
        ...(spec.clearFailureOnSuccess ? { clearFailure: true } : {}),
      });
      return { ok: true, resultPath: firstFile, previewUrl, reused: reusedAny && downloaded.length === results.length };
    }
    await this.deps.history.updateTask(taskId, "failed", { failureReason: "Download failed" });
    return { ok: false, reason: "Download failed", failureReason: "Download Failed" };
  }

  private async collectArtifacts(
    path: string,
  ): Promise<{ thumbnail?: string | null; resultSha256?: string | null }> {
    if (!this.deps.artifacts) return {};
    try {
      return await this.deps.artifacts(path);
    } catch {
      return {};
    }
  }

  private async finish(
    spec: TaskSpec,
    taskId: string,
    data: Record<string, unknown>,
    emit: (event: TaskEvent) => void,
  ) {
    const outcome = await this.downloadResults(spec, taskId, data);
    if (outcome.ok) {
      emit({ type: "succeeded", resultPath: outcome.resultPath });
    } else {
      emit({ type: "failed", reason: outcome.reason, failureReason: outcome.failureReason });
    }
  }
}
