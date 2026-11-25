/**
 * 把 core 里的各个模块接到当前运行环境上。界面层只从这里取服务，不自己拼依赖。
 */
import { DEFAULT_API_BASE_URL, type ApiSettings, type LocalFiles } from "../core/api";
import { createComicProjectStore } from "../core/comicProject";
import { DEFAULT_CONFIG } from "../core/config";
import { createHistoryStore, HISTORY_DB_FILE, type HistoryStore } from "../core/history";
import { TaskScheduler } from "../core/tasks";
import { platform } from "../platform";
import { diag } from "../platform/diagnostics";
import { cfg } from "./config";
import { computeResultArtifacts } from "./thumbnail";

export function apiSettings(): ApiSettings {
  return { apiBaseUrl: cfg.get("api_base_url", DEFAULT_API_BASE_URL), apiKey: cfg.get("api_key", "") };
}

/** 输出文件夹：相对路径按数据目录解析，对应源项目按工作目录解析。 */
export function resolveOutputFolder(folder: unknown): unknown {
  return typeof folder === "string" ? platform.paths.absolute(folder, platform.dataDir) : folder;
}

/** 提交并发闸的取值：不是正整数时按 1 处理。 */
function submitConcurrency(): number {
  const value = Number(cfg.get("submit_concurrency", DEFAULT_CONFIG.submit_concurrency));
  return Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : 1;
}

export const localFiles: LocalFiles = {
  isFile: (path) => platform.fs.isFile(path),
  read: async (path) => {
    try {
      return await platform.fs.read(path);
    } catch {
      return null;
    }
  },
};

let historyPromise: Promise<HistoryStore> | null = null;

/** 历史库在数据目录里，第一次用到时建表并迁移旧数据。 */
export function openHistory(): Promise<HistoryStore> {
  historyPromise ??= (async () => {
    const store = createHistoryStore({
      db: await platform.openDatabase(platform.paths.join(platform.dataDir, HISTORY_DB_FILE)),
      dataDir: platform.dataDir,
      join: platform.paths.join,
      files: platform.fs,
    });
    await store.ensureSchema();
    await store.migrateLegacyJson();
    return store;
  })();
  return historyPromise;
}

const historyListeners = new Set<() => void>();

/** 订阅历史库变更通知（如任务完成、接续任务结束、再获取更新状态时刷新历史页）。 */
export function subscribeHistoryChanged(listener: () => void): () => void {
  historyListeners.add(listener);
  return () => {
    historyListeners.delete(listener);
  };
}

export function notifyHistoryChanged(): void {
  for (const listener of [...historyListeners]) listener();
}

let scheduler: TaskScheduler | null = null;

/** 全应用只有一个调度器，提交和轮询都从它这里走。 */
export function taskScheduler(): TaskScheduler {
  scheduler ??= new TaskScheduler(
    {
      settings: () => ({
        apiBaseUrl: cfg.get("api_base_url", DEFAULT_API_BASE_URL),
        apiKey: cfg.get("api_key", ""),
        outputFolder: resolveOutputFolder(cfg.get("output_folder", "./output")),
      }),
      files: {
        ...localFiles,
        exists: (path) => platform.fs.exists(path),
        makeDirs: (path) => platform.fs.makeDirs(path),
        join: platform.paths.join,
      },
      history: {
        addTask: (input) =>
          openHistory()
            .then((history) => history.addTask(input))
            .then((task) => {
              notifyHistoryChanged();
              return task;
            }),
        updateTask: (taskId, status, update) =>
          openHistory()
            .then((history) => history.updateTask(taskId, status, update))
            .then((task) => {
              notifyHistoryChanged();
              return task;
            }),
      },
      http: {
        submit: (request) => platform.http.request(request),
        query: (request) => platform.http.request(request),
        download: (url, destPath) => platform.http.download(url, destPath),
      },
      artifacts: computeResultArtifacts,
      // 调度器只在轮询出错和下载出错时写日志，实机测试时要能在日志文件里看到
      log: diag,
    },
    { submitConcurrency: submitConcurrency },
  );
  return scheduler;
}

let projects: ReturnType<typeof createComicProjectStore> | null = null;

/** 漫画项目都在输出文件夹下。 */
export function comicProjects() {
  projects ??= createComicProjectStore({
    outputFolder: () => String(resolveOutputFolder(cfg.get("output_folder", "./output"))),
    fs: {
      ...platform.fs,
      join: platform.paths.join,
      relative: (from, to) => platform.paths.relative(from, to, platform.dataDir),
      absolute: (path) => platform.paths.absolute(path, platform.dataDir),
      splitExt: platform.paths.splitExt,
    },
  });
  return projects;
}
