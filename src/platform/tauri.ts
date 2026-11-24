import { invoke } from "@tauri-apps/api/core";
import { resourceDir } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  copyFile,
  exists,
  mkdir,
  readDir,
  readFile,
  remove,
  rename,
  stat,
  writeFile,
  writeTextFile,
  readTextFile,
} from "@tauri-apps/plugin-fs";
import Database from "@tauri-apps/plugin-sql";
import { DOWNLOAD_TIMEOUT_SECS, type HttpOutcome, type HttpRequest } from "../core/api";
import { CONFIG_FILE_NAME, type ConfigStorage } from "../core/config";
import type { SqlExecutor } from "../core/history";
import { createPathTools } from "../core/paths";
import type { NativeTheme, Platform } from "./types";

const paths = createPathTools("\\");
let dataDir = "";

async function isType(path: string, want: "file" | "dir"): Promise<boolean> {
  try {
    const info = await stat(path);
    return want === "file" ? info.isFile : info.isDirectory;
  } catch {
    return false;
  }
}

const configPath = () => paths.join(dataDir, CONFIG_FILE_NAME);

/**
 * 命令本身出了岔子（参数没反序列化成功、Rust 侧 panic）时的兜底。
 * 这种情况说不清请求发出去没有，按「结果不明」处理，免得盲目重试。
 */
const invokeHttp = (command: "api_request" | "api_download", spec: unknown): Promise<HttpOutcome> =>
  invoke<HttpOutcome>(command, { spec }).catch((error: unknown): HttpOutcome => ({
    outcome: "unknown",
    message: error instanceof Error ? error.message : String(error),
    status: null,
  }));

export const tauriPlatform: Platform = {
  isTauri: true,

  // Windows 上 Tauri 的 resource 目录就是 exe 所在目录，所以数据都落在程序目录里
  async init() {
    dataDir = await resourceDir();
  },

  get dataDir() {
    return dataDir;
  },
  paths,

  window: {
    minimize: () => getCurrentWindow().minimize(),
    toggleMaximize: () => getCurrentWindow().toggleMaximize(),
    close: () => getCurrentWindow().close(),
    isMaximized: () => getCurrentWindow().isMaximized(),
    setTitle: (title: string) => getCurrentWindow().setTitle(title),
    setTheme: (theme: NativeTheme | null) => getCurrentWindow().setTheme(theme),
    onResized: (listener: () => void) => {
      let unlisten: (() => void) | undefined;
      let disposed = false;
      void getCurrentWindow()
        .onResized(() => listener())
        .then((stop) => {
          if (disposed) stop();
          else unlisten = stop;
        });
      return () => {
        disposed = true;
        unlisten?.();
      };
    },
  },

  fs: {
    exists: (path) => exists(path),
    isFile: (path) => isType(path, "file"),
    isDir: (path) => isType(path, "dir"),
    async makeDirs(path) {
      await mkdir(path, { recursive: true });
    },
    async readDir(path) {
      return (await readDir(path)).map((entry) => entry.name).sort();
    },
    readText: (path) => readTextFile(path),
    writeText: (path, text) => writeTextFile(path, text),
    read: (path) => readFile(path),
    async write(path, bytes) {
      await writeFile(path, bytes);
    },
    copyFile: (source, dest) => copyFile(source, dest),
    rename: (from, to) => rename(from, to),
    async remove(path) {
      await remove(path, { recursive: true });
    },
    async replaceWithBackup(path, backup) {
      if (await exists(backup)) await remove(backup);
      await rename(path, backup);
    },
  },

  http: {
    request: (request: HttpRequest) => invokeHttp("api_request", request),
    download: (url, destPath) =>
      invokeHttp("api_download", {
        url,
        headers: {},
        connectTimeoutSecs: DOWNLOAD_TIMEOUT_SECS,
        readTimeoutSecs: DOWNLOAD_TIMEOUT_SECS,
        destPath,
      }),
  },

  configStorage: {
    // 文件在却读不了时让 readTextFile 抛错，由配置存储回落到默认值且不回写
    async read() {
      return (await exists(configPath())) ? readTextFile(configPath()) : null;
    },
    async write(text) {
      await writeTextFile(configPath(), text);
    },
  } satisfies ConfigStorage,

  async openDatabase(path) {
    // 先放一个空库文件再加载：这样插件不会去系统的应用数据目录里另建文件夹
    if (!(await exists(path))) await writeFile(path, new Uint8Array(0));
    const db = await Database.load(`sqlite:${path}`, { autoCreate: false });
    return {
      select: <T>(sql: string, params: unknown[] = []) => db.select<T[]>(sql, params),
      execute: async (sql: string, params: unknown[] = []) => ({
        rowsAffected: (await db.execute(sql, params)).rowsAffected,
      }),
    } satisfies SqlExecutor;
  },
};

export type { FileSystemApi, NativeTheme, Platform, WindowApi } from "./types";
