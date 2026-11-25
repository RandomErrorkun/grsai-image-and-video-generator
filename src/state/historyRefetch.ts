/**
 * 历史记录「进度/生成结果再获取」与「获取本页状态」服务。
 *
 * 关键保护：
 * - 按 taskId 维度的内存互斥锁（inFlight），同一任务连续点击 5 次或单条/批量同时点不会并发发多条请求或重复下载；
 * - 若任务已在任务列表中活跃轮询（isActive），直接返回 already_tracking，0 网络请求、不重复建卡片；
 * - 若任务已是 succeeded 且本地结果文件存在，直接返回 already_complete，0 网络请求、不误改超过 2 小时的老记录；
 * - 确定性文件命名（deterministicResultStem）+ 下载前检查文件是否存在，同一任务绝不产生重复副本；
 * - 批量获取限制并发（默认 3），配合 SQLite 写队列防止限流与锁冲突。
 */
import type { HistoryTask, TaskUpdate } from "../core/history";
import {
  deterministicResultStem,
  type DownloadResultsOutcome,
  type TaskProbeResult,
  type TaskSpec,
} from "../core/tasks";
import { platform } from "../platform";
import { notifyHistoryChanged, openHistory, taskScheduler } from "./services";
import { isTaskIdActive, resumeHistoryTask } from "./taskLists";

export type RefetchOutcome =
  | { kind: "in_flight" }
  | { kind: "already_tracking" }
  | { kind: "already_complete"; resultPath: string }
  | { kind: "resumed"; progress: number }
  | { kind: "updated_succeeded"; resultPath: string | null; downloaded: boolean }
  | { kind: "updated_failed"; status: "failed" | "violation"; reason: string }
  | { kind: "marked_expired" }
  | { kind: "expired_unchanged" }
  | { kind: "download_failed"; message: string }
  | { kind: "network_error"; message: string };

export interface PageRefetchSummary {
  total: number;
  resumed: number;
  downloaded: number;
  updatedSucceeded: number;
  updatedFailed: number;
  markedExpired: number;
  alreadyComplete: number;
  alreadyTracking: number;
  skippedInFlight: number;
  expiredUnchanged: number;
  errors: number;
}

export interface HistoryRefetchDeps {
  getTask(taskId: string): Promise<HistoryTask | null>;
  updateTask(taskId: string, status: string, update?: TaskUpdate): Promise<HistoryTask | null>;
  probeOnce(taskId: string): Promise<TaskProbeResult>;
  downloadResults(
    spec: TaskSpec,
    taskId: string,
    data: Record<string, unknown>,
  ): Promise<DownloadResultsOutcome>;
  isActive(taskId: string): boolean;
  resume(task: HistoryTask, spec: TaskSpec, progress: number, serverStatus: string): void;
  allowPath(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  sha256?(path: string): Promise<string>;
  onChanged(): void;
}

export interface HistoryRefetcher {
  /** 指定任务是否正在执行再获取/下载。 */
  isInFlight(taskId: string): boolean;
  /** 订阅在途集合变化，供历史页更新按钮禁用/加载态。 */
  subscribe(listener: () => void): () => void;
  /** 对单条历史记录执行再获取。 */
  refetchTask(task: HistoryTask): Promise<RefetchOutcome>;
  /** 对当前页所有历史记录按并发上限执行再获取。 */
  refetchPage(tasks: readonly HistoryTask[], options?: { concurrency?: number }): Promise<PageRefetchSummary>;
}

/** 批量获取本页状态时的默认最大并发数，避免每页条数调到 100 时瞬间打爆限流。 */
export const DEFAULT_PAGE_REFETCH_CONCURRENCY = 3;

function buildResumeSpec(task: HistoryTask, hasLocalFile: boolean): TaskSpec {
  const refImageUrls = Array.isArray(task.ref_images)
    ? task.ref_images
    : typeof task.ref_images === "string" && task.ref_images
      ? [task.ref_images]
      : null;
  return {
    prompt: task.prompt,
    model: task.model,
    aspectRatio: task.aspect_ratio,
    imageSize: task.image_size,
    refImageUrls,
    duration: task.duration,
    seed: task.seed,
    refAudios: task.ref_audios,
    firstFrame: task.first_frame,
    lastFrame: task.last_frame,
    refVideos: task.ref_videos,
    videoOptions: task.ref_video_options,
    preferredResultPath: hasLocalFile ? task.result_path : null,
    deterministicStem: deterministicResultStem(task.created_at, task.id),
    clearFailureOnSuccess: true,
  };
}

export function createHistoryRefetcher(deps: HistoryRefetchDeps): HistoryRefetcher {
  const inFlight = new Map<string, Promise<RefetchOutcome>>();
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  async function localFileValid(path: string | null, expectedSha256: string | null): Promise<boolean> {
    if (!path) return false;
    try {
      await deps.allowPath(path);
    } catch {
      // 放行失败时仍尝试查存在
    }
    let present = false;
    try {
      present = await deps.exists(path);
    } catch {
      return false;
    }
    if (!present) return false;
    if (expectedSha256 && deps.sha256) {
      try {
        const actual = await deps.sha256(path);
        return actual.toLowerCase() === expectedSha256.toLowerCase();
      } catch {
        return false;
      }
    }
    return true;
  }

  async function runOne(task: HistoryTask): Promise<RefetchOutcome> {
    if (deps.isActive(task.id)) return { kind: "already_tracking" };

    // 每次都先读库里最新的一行，防止连续点击时拿到过期的 React props
    const fresh = (await deps.getTask(task.id)) ?? task;
    const hasLocalFile = await localFileValid(fresh.result_path, fresh.result_sha256);

    // 已成功且本地结果完好：直接短路，0 网络请求，不触发多余下载也不会误伤超过 2 小时的老记录
    if (fresh.status === "succeeded" && hasLocalFile && fresh.result_path) {
      return { kind: "already_complete", resultPath: fresh.result_path };
    }

    const spec = buildResumeSpec(fresh, hasLocalFile);
    const probe = await deps.probeOnce(fresh.id);

    switch (probe.kind) {
      case "running": {
        if (deps.isActive(fresh.id)) return { kind: "already_tracking" };
        if (fresh.status !== "running") {
          await deps.updateTask(fresh.id, "running");
          deps.onChanged();
        }
        deps.resume(fresh, spec, probe.progress, probe.status);
        return { kind: "resumed", progress: probe.progress };
      }
      case "succeeded": {
        if (hasLocalFile && fresh.result_path) {
          if (fresh.status !== "succeeded") {
            await deps.updateTask(fresh.id, "succeeded", {
              resultPath: fresh.result_path,
              clearFailure: true,
            });
            deps.onChanged();
          }
          return { kind: "updated_succeeded", resultPath: fresh.result_path, downloaded: false };
        }
        const dl = await deps.downloadResults(spec, fresh.id, probe.data);
        deps.onChanged();
        if (!dl.ok) return { kind: "download_failed", message: dl.reason };
        return { kind: "updated_succeeded", resultPath: dl.resultPath, downloaded: !dl.reused };
      }
      case "failed": {
        await deps.updateTask(fresh.id, probe.status, {
          failureReason: probe.failureReason,
          errorMessage: probe.errorMessage,
        });
        deps.onChanged();
        return { kind: "updated_failed", status: probe.status, reason: probe.failureReason };
      }
      case "expired": {
        // 只有本地仍卡在 running 的任务才标成过期失败；已成功或已有真实失败原因的记录保留不动
        if (fresh.status === "running") {
          await deps.updateTask(fresh.id, "failed", {
            failureReason: "Task expired",
            errorMessage: probe.errorMessage,
          });
          deps.onChanged();
          return { kind: "marked_expired" };
        }
        return { kind: "expired_unchanged" };
      }
      case "network_error":
      case "processing_error":
        return { kind: "network_error", message: probe.message };
    }
  }

  function refetchTask(task: HistoryTask): Promise<RefetchOutcome> {
    if (inFlight.has(task.id)) return Promise.resolve({ kind: "in_flight" });
    if (deps.isActive(task.id)) return Promise.resolve({ kind: "already_tracking" });

    const work = runOne(task).finally(() => {
      inFlight.delete(task.id);
      notify();
    });
    inFlight.set(task.id, work);
    notify();
    return work;
  }

  async function refetchPage(
    tasks: readonly HistoryTask[],
    options: { concurrency?: number } = {},
  ): Promise<PageRefetchSummary> {
    const unique: HistoryTask[] = [];
    const seen = new Set<string>();
    for (const task of tasks) {
      if (!seen.has(task.id)) {
        seen.add(task.id);
        unique.push(task);
      }
    }

    const summary: PageRefetchSummary = {
      total: unique.length,
      resumed: 0,
      downloaded: 0,
      updatedSucceeded: 0,
      updatedFailed: 0,
      markedExpired: 0,
      alreadyComplete: 0,
      alreadyTracking: 0,
      skippedInFlight: 0,
      expiredUnchanged: 0,
      errors: 0,
    };
    if (unique.length === 0) return summary;

    let cursor = 0;
    const workerCount = Math.min(unique.length, Math.max(1, options.concurrency ?? DEFAULT_PAGE_REFETCH_CONCURRENCY));
    const worker = async () => {
      while (cursor < unique.length) {
        const current = unique[cursor];
        cursor += 1;
        const outcome = await refetchTask(current);
        switch (outcome.kind) {
          case "resumed":
            summary.resumed += 1;
            break;
          case "updated_succeeded":
            summary.updatedSucceeded += 1;
            if (outcome.downloaded) summary.downloaded += 1;
            break;
          case "updated_failed":
            summary.updatedFailed += 1;
            break;
          case "marked_expired":
            summary.markedExpired += 1;
            break;
          case "already_complete":
            summary.alreadyComplete += 1;
            break;
          case "already_tracking":
            summary.alreadyTracking += 1;
            break;
          case "in_flight":
            summary.skippedInFlight += 1;
            break;
          case "expired_unchanged":
            summary.expiredUnchanged += 1;
            break;
          case "download_failed":
          case "network_error":
            summary.errors += 1;
            break;
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return summary;
  }

  return {
    isInFlight: (taskId) => inFlight.has(taskId),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refetchTask,
    refetchPage,
  };
}

/** 全应用共享的默认历史再获取实例。 */
export const historyRefetcher = createHistoryRefetcher({
  getTask: (taskId) => openHistory().then((history) => history.getTask(taskId)),
  updateTask: (taskId, status, update) => openHistory().then((history) => history.updateTask(taskId, status, update)),
  probeOnce: (taskId) => taskScheduler().probeOnce(taskId),
  downloadResults: (spec, taskId, data) => taskScheduler().downloadResults(spec, taskId, data),
  isActive: (taskId) => isTaskIdActive(taskId),
  resume: (task, spec, progress, serverStatus) => {
    resumeHistoryTask(task, spec, progress, serverStatus, {
      onSucceeded: () => notifyHistoryChanged(),
      onFailed: () => notifyHistoryChanged(),
    });
  },
  allowPath: (path) => platform.media.allow([path]),
  exists: (path) => platform.fs.exists(path),
  sha256: (path) => platform.fs.sha256(path),
  onChanged: () => notifyHistoryChanged(),
});
