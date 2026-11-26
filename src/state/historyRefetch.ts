/**
 * 历史记录「进度/生成结果再获取」与「本页未完成任务再获取」服务。
 *
 * 规则：
 * - 按 taskId 维度的内存互斥锁（inFlight），同一任务连续点击不会并发发多条请求或重复下载；
 * - 批量「本页未完成任务再获取」（refetchPage）直接跳过所有 status === "succeeded" 的历史记录，0 网络请求；
 * - 手动点击单条历史记录的「再获取」（refetchTask）时，若该记录已是 succeeded：
 *   1. 远端未过期且本地文件存在：
 *      - 若能直接获得远端 SHA-256 校验码，直接与本地文件比对：一致则不下载；不一致则重下覆盖本地并更新缩略图与 SHA-256；
 *      - 若无法直接获得远端校验码，先下载到临时文件，再比对 SHA-256 与文件大小：
 *        * SHA-256 不同且新文件大小 >= 本地文件大小 -> 覆盖本地文件并更新 SQLite 缩略图与 SHA-256；
 *        * SHA-256 相同，或不同但新文件小于本地文件 -> 删除临时文件，不做任何修改。
 *   2. 远端未过期且本地文件不存在：直接下载远端文件并更新 SQLite 缩略图与 SHA-256。
 *   3. 远端已过期（无论本地文件存在或缺失）：不做任何修改。
 */
import type { HttpOutcome } from "../core/api";
import type { HistoryTask, TaskUpdate } from "../core/history";
import { pyStr } from "../core/py";
import {
  deterministicResultStem,
  type DownloadResultsOutcome,
  type TaskProbeResult,
  type TaskSpec,
} from "../core/tasks";
import { platform } from "../platform";
import { notifyHistoryChanged, openHistory, syncTaskToUsageLedger, taskScheduler } from "./services";
import { isTaskIdActive, resumeHistoryTask } from "./taskLists";
import { computeResultArtifacts, type ResultArtifacts } from "./thumbnail";

export type RefetchOutcome =
  | { kind: "in_flight" }
  | { kind: "already_tracking" }
  | { kind: "already_complete"; resultPath: string }
  | { kind: "skipped_succeeded" }
  | { kind: "replaced_succeeded"; resultPath: string }
  | { kind: "kept_local_larger" }
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
  /** 单文件校验/重下所需的直接下载能力（用于 Succeeded 单条再获取比对与覆盖）。 */
  downloadFile(url: string, destPath: string): Promise<HttpOutcome>;
  /** 可选：尝试通过 HEAD 请求获取远端显式 SHA-256 校验码，拿不到返回 null。 */
  probeRemoteSha256?(url: string): Promise<string | null>;
  isActive(taskId: string): boolean;
  resume(task: HistoryTask, spec: TaskSpec, progress: number, serverStatus: string): void;
  allowPath(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  fileSize(path: string): Promise<number>;
  sha256(path: string): Promise<string>;
  /** 用临时文件原子替换目标文件。 */
  replaceFile(sourceTempPath: string, destPath: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  computeArtifacts?(path: string): Promise<ResultArtifacts>;
  onChanged(): void;
}

export interface HistoryRefetcher {
  /** 指定任务是否正在执行再获取/下载。 */
  isInFlight(taskId: string): boolean;
  /** 订阅在途集合变化，供历史页更新按钮禁用/加载态。 */
  subscribe(listener: () => void): () => void;
  /** 对单条历史记录执行再获取（含对 Succeeded 记录的完整性比对/重下）。 */
  refetchTask(task: HistoryTask): Promise<RefetchOutcome>;
  /** 对当前页所有未完成任务按并发上限执行再获取（跳过所有 Succeeded 记录）。 */
  refetchPage(tasks: readonly HistoryTask[], options?: { concurrency?: number }): Promise<PageRefetchSummary>;
}

/** 批量获取本页未完成任务时的默认最大并发数，避免每页条数调到 100 时瞬间打爆限流。 */
export const DEFAULT_PAGE_REFETCH_CONCURRENCY = 3;

const HEX_SHA256 = /^[0-9a-f]{64}$/i;

function extractFirstResultInfo(data: Record<string, unknown>): {
  url: string | null;
  remoteSha256: string | null;
} {
  const results = data.results;
  if (!Array.isArray(results) || results.length === 0) return { url: null, remoteSha256: null };
  const first = results[0];
  if (typeof first !== "object" || first === null || Array.isArray(first)) {
    return { url: null, remoteSha256: null };
  }
  const entry = first as Record<string, unknown>;
  const rawUrl = entry.url;
  const url = rawUrl ? (typeof rawUrl === "string" ? rawUrl : pyStr(rawUrl)) : null;
  let remoteSha256: string | null = null;
  for (const key of ["sha256", "file_sha256", "checksum", "hash"]) {
    const val = entry[key];
    if (typeof val === "string" && HEX_SHA256.test(val.trim())) {
      remoteSha256 = val.trim().toLowerCase();
      break;
    }
  }
  return { url, remoteSha256 };
}

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

function makeStagingPath(localPath: string, seq: number): string {
  const dot = localPath.lastIndexOf(".");
  const sep = Math.max(localPath.lastIndexOf("/"), localPath.lastIndexOf("\\"));
  const stamp = `${Date.now()}.${seq}`;
  if (dot > sep) {
    return `${localPath.slice(0, dot)}.refetch.${stamp}${localPath.slice(dot)}`;
  }
  return `${localPath}.refetch.${stamp}.tmp`;
}

function isDownloadOk(outcome: HttpOutcome): boolean {
  return outcome.outcome === "responded" && outcome.status >= 200 && outcome.status < 300;
}

function downloadErrorText(outcome: HttpOutcome): string {
  return outcome.outcome === "responded" ? `HTTP ${outcome.status}` : outcome.message;
}

export function createHistoryRefetcher(deps: HistoryRefetchDeps): HistoryRefetcher {
  const inFlight = new Map<string, Promise<RefetchOutcome>>();
  const listeners = new Set<() => void>();
  let stagingSeq = 0;

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  async function localFileExists(path: string | null): Promise<boolean> {
    if (!path) return false;
    try {
      await deps.allowPath(path);
    } catch {
      // 放行失败仍尝试查存在
    }
    try {
      return await deps.exists(path);
    } catch {
      return false;
    }
  }

  async function collectArtifacts(path: string): Promise<{ thumbnail?: string | null; resultSha256?: string | null }> {
    if (deps.computeArtifacts) {
      try {
        return await deps.computeArtifacts(path);
      } catch {
        // 回退仅算 SHA-256
      }
    }
    try {
      return { resultSha256: await deps.sha256(path) };
    } catch {
      return {};
    }
  }

  /**
   * 规则 2.2.1–2.2.4：手动点击单条 Succeeded 记录的「再获取」。
   */
  async function refetchSucceededTask(fresh: HistoryTask): Promise<RefetchOutcome> {
    const localPath = fresh.result_path;
    const existsLocally = await localFileExists(localPath);
    const probe = await deps.probeOnce(fresh.id);

    switch (probe.kind) {
      case "expired":
        // 2.2.3 & 2.2.4：远端已过期时，无论本地文件存在或不存在均不做修改
        return { kind: "expired_unchanged" };
      case "network_error":
      case "processing_error":
        return { kind: "network_error", message: probe.message };
      case "running": {
        if (deps.isActive(fresh.id)) return { kind: "already_tracking" };
        deps.resume(fresh, buildResumeSpec(fresh, existsLocally), probe.progress, probe.status);
        return { kind: "resumed", progress: probe.progress };
      }
      case "failed":
        // 本地已标记为 succeeded，不降级覆盖
        return { kind: "expired_unchanged" };
      case "succeeded":
        break;
    }

    const { url: remoteUrl, remoteSha256: apiSha256 } = extractFirstResultInfo(probe.data);
    if (!remoteUrl) {
      return { kind: "download_failed", message: "No result URL in remote response" };
    }

    // 2.2.2：远端未过期且本地文件不存在 -> 直接下载远端文件并更新 SQLite 的缩略图与 SHA-256
    if (!existsLocally || !localPath) {
      if (localPath) {
        const dl = await deps.downloadFile(remoteUrl, localPath);
        if (!isDownloadOk(dl)) {
          return { kind: "download_failed", message: downloadErrorText(dl) };
        }
        const artifacts = await collectArtifacts(localPath);
        await deps.updateTask(fresh.id, "succeeded", {
          resultPath: localPath,
          previewUrl: remoteUrl,
          ...artifacts,
        });
        deps.onChanged();
        return { kind: "updated_succeeded", resultPath: localPath, downloaded: true };
      }
      const dl = await deps.downloadResults(buildResumeSpec(fresh, false), fresh.id, probe.data);
      deps.onChanged();
      if (!dl.ok) return { kind: "download_failed", message: dl.reason };
      return { kind: "updated_succeeded", resultPath: dl.resultPath, downloaded: !dl.reused };
    }

    // 2.2.1：远端未过期且本地文件存在
    const localSha256 = (await deps.sha256(localPath).catch(() => null)) ?? fresh.result_sha256;
    const remoteSha256 =
      apiSha256 ?? (deps.probeRemoteSha256 ? await deps.probeRemoteSha256(remoteUrl).catch(() => null) : null);

    // 情况 A：能直接获得远端文件校验码 -> 直接与本地 SHA-256 比对
    if (remoteSha256) {
      if (localSha256 && remoteSha256.toLowerCase() === localSha256.toLowerCase()) {
        return { kind: "already_complete", resultPath: localPath };
      }
      const dl = await deps.downloadFile(remoteUrl, localPath);
      if (!isDownloadOk(dl)) {
        return { kind: "download_failed", message: downloadErrorText(dl) };
      }
      const artifacts = await collectArtifacts(localPath);
      await deps.updateTask(fresh.id, "succeeded", {
        resultPath: localPath,
        previewUrl: remoteUrl,
        ...artifacts,
      });
      deps.onChanged();
      return { kind: "replaced_succeeded", resultPath: localPath };
    }

    // 情况 B：无法直接获得远端校验码 -> 下载到临时文件（保留原扩展名以触发对应容器校验），再比对 SHA-256 与文件大小
    stagingSeq += 1;
    const stagingPath = makeStagingPath(localPath, stagingSeq);
    try {
      const dl = await deps.downloadFile(remoteUrl, stagingPath);
      if (!isDownloadOk(dl)) {
        return { kind: "download_failed", message: downloadErrorText(dl) };
      }
      const [newSha256, newSize, localSize] = await Promise.all([
        deps.sha256(stagingPath),
        deps.fileSize(stagingPath),
        deps.fileSize(localPath),
      ]);

      // SHA-256 一致 -> 无需覆盖
      if (localSha256 && newSha256.toLowerCase() === localSha256.toLowerCase()) {
        return { kind: "already_complete", resultPath: localPath };
      }

      // SHA-256 不一致且新文件大小 >= 本地文件大小 -> 覆盖本地文件并更新缩略图与 SHA-256
      if (newSize >= localSize) {
        await deps.replaceFile(stagingPath, localPath);
        const artifacts = await collectArtifacts(localPath);
        await deps.updateTask(fresh.id, "succeeded", {
          resultPath: localPath,
          previewUrl: remoteUrl,
          thumbnail: artifacts.thumbnail,
          resultSha256: artifacts.resultSha256 ?? newSha256,
        });
        deps.onChanged();
        return { kind: "replaced_succeeded", resultPath: localPath };
      }

      // SHA-256 不一致且新文件小于本地文件 -> 不做修改
      return { kind: "kept_local_larger" };
    } finally {
      // 无论走哪条分支都清理临时文件（若已被 replaceFile 移走则静默忽略）
      await deps.removeFile(stagingPath).catch(() => {});
    }
  }

  async function runOne(task: HistoryTask, options: { skipSucceeded: boolean }): Promise<RefetchOutcome> {
    if (deps.isActive(task.id)) return { kind: "already_tracking" };

    // 每次都先读库里最新的一行，防止连续点击时拿到过期的 React props
    const fresh = (await deps.getTask(task.id)) ?? task;

    if (fresh.status === "succeeded") {
      // 2.2.5：批量「本页未完成任务再获取」不触发 Succeeded 记录的再获取
      if (options.skipSucceeded) return { kind: "skipped_succeeded" };
      return refetchSucceededTask(fresh);
    }

    const existsLocally = await localFileExists(fresh.result_path);
    const spec = buildResumeSpec(fresh, existsLocally);
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
        if (existsLocally && fresh.result_path) {
          const artifacts = await collectArtifacts(fresh.result_path);
          await deps.updateTask(fresh.id, "succeeded", {
            resultPath: fresh.result_path,
            ...artifacts,
            clearFailure: true,
          });
          deps.onChanged();
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
        // 只有本地仍卡在 running 的任务才标成过期失败；已有真实失败/违规原因的记录保留不动
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

  function scheduleTask(task: HistoryTask, options: { skipSucceeded: boolean }): Promise<RefetchOutcome> {
    if (options.skipSucceeded && task.status === "succeeded") {
      return Promise.resolve({ kind: "skipped_succeeded" });
    }
    if (inFlight.has(task.id)) return Promise.resolve({ kind: "in_flight" });
    if (deps.isActive(task.id)) return Promise.resolve({ kind: "already_tracking" });

    const work = runOne(task, options).finally(() => {
      inFlight.delete(task.id);
      notify();
    });
    inFlight.set(task.id, work);
    notify();
    return work;
  }

  function refetchTask(task: HistoryTask): Promise<RefetchOutcome> {
    return scheduleTask(task, { skipSucceeded: false });
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
        // 2.2.5：批量再获取跳过 Succeeded 记录
        const outcome = await scheduleTask(current, { skipSucceeded: true });
        switch (outcome.kind) {
          case "resumed":
            summary.resumed += 1;
            break;
          case "updated_succeeded":
            summary.updatedSucceeded += 1;
            if (outcome.downloaded) summary.downloaded += 1;
            break;
          case "replaced_succeeded":
            summary.updatedSucceeded += 1;
            summary.downloaded += 1;
            break;
          case "updated_failed":
            summary.updatedFailed += 1;
            break;
          case "marked_expired":
            summary.markedExpired += 1;
            break;
          case "already_complete":
          case "skipped_succeeded":
          case "kept_local_larger":
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
  updateTask: (taskId, status, update) =>
    openHistory()
      .then((history) => history.updateTask(taskId, status, update))
      .then(async (task) => {
        await syncTaskToUsageLedger(task).catch(() => {});
        return task;
      }),
  probeOnce: (taskId) => taskScheduler().probeOnce(taskId),
  downloadResults: (spec, taskId, data) => taskScheduler().downloadResults(spec, taskId, data),
  downloadFile: (url, destPath) => platform.http.download(url, destPath),
  probeRemoteSha256: (url) =>
    platform.http.probeRemoteSha256 ? platform.http.probeRemoteSha256(url) : Promise.resolve(null),
  isActive: (taskId) => isTaskIdActive(taskId),
  resume: (task, spec, progress, serverStatus) => {
    resumeHistoryTask(task, spec, progress, serverStatus, {
      onSucceeded: () => notifyHistoryChanged(),
      onFailed: () => notifyHistoryChanged(),
    });
  },
  allowPath: (path) => platform.media.allow([path]),
  exists: (path) => platform.fs.exists(path),
  fileSize: (path) => platform.fs.fileSize(path),
  sha256: (path) => platform.fs.sha256(path),
  replaceFile: (sourceTempPath, destPath) => platform.fs.replaceWithBackup(sourceTempPath, destPath),
  removeFile: (path) => platform.fs.remove(path),
  computeArtifacts: (path) => computeResultArtifacts(path),
  onChanged: () => notifyHistoryChanged(),
});
