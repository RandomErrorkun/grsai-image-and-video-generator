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
  buildResultRequest,
  parseSubmitResponse,
  parseTaskResult,
  prepareSubmission,
  type GenerateParams,
  type HttpOutcome,
  type HttpRequest,
  type LocalFiles,
  type TaskResultQuery,
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
}

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
  now?: () => Date;
  sleep?(ms: number): Promise<void>;
  log?(message: string): void;
}

/** 提交没成功时，说明请求到底发出去没有。 */
export type FailureDelivery = "not_sent" | "unknown";

export type TaskEvent =
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

/** 提交并发闸：超过上限的提交按先来后到排队。 */
class SubmissionGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: () => number) {}

  /** 上限允许几个就叫醒几个；上限中途调大时，排队的提交也能立刻补位。 */
  private admit(): void {
    while (this.waiting.length > 0 && this.active < Math.max(1, this.limit())) {
      this.waiting.shift()?.();
    }
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    while (this.active >= Math.max(1, this.limit())) {
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
      });
    }
    this.active += 1;
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
      const prepared = await prepareSubmission(spec, this.deps.settings(), this.deps.files);
      if (token.stopped) return;
      if ("error" in prepared) {
        emit({ type: "failed", reason: prepared.error, failureReason: "Submission failed" });
        return;
      }

      let taskId: string;
      try {
        const outcome = await this.gate.run(async () => {
          if (token.stopped) throw new TaskCancelled();
          return this.deps.http.submit(prepared.request);
        });
        if (token.stopped) return;
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
      let result: TaskResultQuery;
      try {
        const outcome = await this.deps.http.query(buildResultRequest(taskId, this.deps.settings()));
        result = outcome.outcome === "responded"
          ? parseTaskResult(outcome.status, outcome.body)
          : { code: -1, error: outcome.message };
        if (result.code !== 0) throw new Error(result.error);
        errorCount = 0;
      } catch (error) {
        errorCount += 1;
        this.deps.log?.(`[TaskScheduler] API call error (attempt ${errorCount}): ${errorText(error)}`);
        if (errorCount > MAX_POLL_ERRORS) {
          emit({ type: "failed", reason: `Network error: ${errorText(error)}`, failureReason: "Network Error" });
          return;
        }
        if (await this.wait(POLL_INTERVAL_MS, token)) return;
        continue;
      }
      if (token.stopped) return;

      try {
        const data = (result as { data: Record<string, unknown> }).data;
        const status = data.status;
        const progress = pyInt("progress" in data ? data.progress : 0);
        if (progress === null) {
          throw new TypeError("int() argument must be a string, a bytes-like object or a real number");
        }
        emit({ type: "progress", progress, status: pyStr(status) });

        if (status === "succeeded") {
          await this.finish(spec, taskId, data, emit);
          return;
        }
        if (status === "failed" || status === "violation") {
          const reason = data.failure_reason
            ? pyStr(data.failure_reason)
            : status === "violation"
              ? "violation"
              : "Unknown";
          const rawError = "error" in data ? data.error : "";
          const errorMsg = rawError ? pyStr(rawError) : "";
          await this.deps.history.updateTask(taskId, status, { failureReason: reason, errorMessage: errorMsg });
          emit({
            type: "failed",
            reason: errorMsg ? `${reason}: ${errorMsg}` : reason,
            failureReason: reason,
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

  private async finish(
    spec: TaskSpec,
    taskId: string,
    data: Record<string, unknown>,
    emit: (event: TaskEvent) => void,
  ) {
    const results = data.results ?? [];
    if (!Array.isArray(results) || results.length === 0) {
      await this.deps.history.updateTask(taskId, "failed", { failureReason: "No results found" });
      emit({ type: "failed", reason: "No results found", failureReason: "No Results" });
      return;
    }

    const downloaded: string[] = [];
    let firstFile: string | null = null;
    for (const [index, result] of results.entries()) {
      if (typeof result !== "object" || result === null || Array.isArray(result)) {
        throw new Error(`'${pyStr(result)}' object has no attribute 'get'`);
      }
      const imgUrl = (result as Record<string, unknown>).url;
      if (!imgUrl) continue;
      try {
        const timestamp = formatFileTime(this.now());
        const defaultExt = VIDEO_MODEL_SET.has(spec.model) ? "mp4" : "png";
        const ext = extensionForUrl(imgUrl, defaultExt);
        const outputDir = spec.outputDir || this.deps.settings().outputFolder;
        if (typeof outputDir !== "string") {
          throw new TypeError("expected str, bytes or os.PathLike object, not NoneType");
        }
        if (!(await this.deps.files.exists(outputDir))) await this.deps.files.makeDirs(outputDir);
        const baseStem = resultFileStem(spec.filenamePrefix, timestamp);
        const filepath = await this.resolveResultPath(outputDir, baseStem, ext, index, results.length);
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

    const firstUrl = (results[0] as Record<string, unknown>).url;
    const previewUrl = firstUrl ? (typeof firstUrl === "string" ? firstUrl : pyStr(firstUrl)) : null;
    if (downloaded.length) {
      await this.deps.history.updateTask(taskId, "succeeded", { resultPath: firstFile, previewUrl });
      emit({ type: "succeeded", resultPath: firstFile });
    } else {
      await this.deps.history.updateTask(taskId, "failed", { failureReason: "Download failed" });
      emit({ type: "failed", reason: "Download failed", failureReason: "Download Failed" });
    }
  }
}
