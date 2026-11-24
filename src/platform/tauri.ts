import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { resourceDir } from "@tauri-apps/api/path";
import { getCurrentWebview } from "@tauri-apps/api/webview";
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
import { open } from "@tauri-apps/plugin-dialog";
import { readImage, readText } from "@tauri-apps/plugin-clipboard-manager";
import Database from "@tauri-apps/plugin-sql";
import { DOWNLOAD_TIMEOUT_SECS, type HttpOutcome, type HttpRequest } from "../core/api";
import { CONFIG_FILE_NAME, type ConfigStorage } from "../core/config";
import type { SqlExecutor } from "../core/history";
import { createPathTools } from "../core/paths";
import type { ClipboardSnapshot, NativeTheme, Platform } from "./types";
import { encodePng } from "./png";

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

/** 读剪贴板里的位图，存成 input 目录下的 PNG，返回文件路径；没有位图返回 null。 */
async function readClipboardImage(): Promise<string | null> {
  let image: Awaited<ReturnType<typeof readImage>> | null = null;
  try {
    image = await readImage();
    const { width, height } = await image.size();
    const png = await encodePng(await image.rgba(), width, height);
    const inputDir = paths.join(dataDir, "input");
    await mkdir(inputDir, { recursive: true });
    const target = paths.join(inputDir, `grsai_clipboard_${Math.floor(Date.now() / 1000)}.png`);
    await writeFile(target, png);
    return target;
  } catch {
    return null;
  } finally {
    image?.close();
  }
}

async function readClipboard(): Promise<ClipboardSnapshot> {
  // 与源项目同序：位图、文件、文本
  const image = await readClipboardImage();
  if (image) return { kind: "image", path: image };

  const files = await invoke<string[]>("clipboard_files").catch(() => [] as string[]);
  if (files.length > 0) return { kind: "files", paths: files };

  try {
    const text = await readText();
    if (text) return { kind: "text", text };
  } catch {
    // 剪贴板里没有文本
  }
  return { kind: "empty" };
}

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

  dialog: {
    async pickFiles(options = {}) {
      const picked = await open({
        title: options.title,
        multiple: options.multiple ?? false,
        directory: false,
        filters: options.filters,
      });
      if (!picked) return [];
      return Array.isArray(picked) ? picked : [picked];
    },
    async pickDirectory(options = {}) {
      const picked = await open({ title: options.title, directory: true, defaultPath: options.defaultPath ?? undefined });
      return typeof picked === "string" ? picked : null;
    },
  },

  opener: {
    // 打开本地路径的权限不在 opener 插件的默认集合里，要配一整套作用域规则；
    // 这里直接走自写的命令，它调的是插件底层的同一个函数
    openPath: (path) => invoke<void>("open_path", { path }),
  },

  clipboard: {
    read: readClipboard,
  },

  dragDrop: {
    subscribe(handler) {
      let unlisten: (() => void) | undefined;
      let disposed = false;
      void getCurrentWebview()
        .onDragDropEvent(({ payload }) => {
          // Tauri 给的是物理像素，页面用的是 CSS 像素
          const ratio = window.devicePixelRatio || 1;
          // over 事件只带位置，没有路径
          const paths = "paths" in payload ? payload.paths : [];
          if (payload.type === "leave") {
            handler({ type: "leave", position: { x: -1, y: -1 }, paths: [] });
            return;
          }
          handler({
            type: payload.type,
            position: { x: payload.position.x / ratio, y: payload.position.y / ratio },
            paths,
          });
        })
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

  media: {
    allow: (mediaPaths, recursive = false) =>
      invoke<void>("allow_paths", { paths: mediaPaths, recursive }),
    url: (path) => convertFileSrc(path),
  },
};
