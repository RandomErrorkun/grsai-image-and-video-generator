/**
 * 浏览器 mock：窗口操作是空操作，配置落在 localStorage，文件在内存里，接口是内存里的假接口。
 * 单独跑 npm run dev 调界面时用它，不依赖 Tauri，也碰不到真实接口。
 *
 * 对话框给出数据目录下的样例文件；剪贴板和拖放拿到的东西先存进内存文件系统再交出去，
 * 和真环境一样给的是路径。
 */
import { bytesToBase64 } from "../core/py";
import { CONFIG_FILE_NAME } from "../core/config";
import { createPathTools } from "../core/paths";
import { notice } from "../components/Notice";
import { createMemoryFs } from "./memoryFs";
import { createMemoryDatabase } from "./memoryDb";
import { createMockHttp } from "./mockApi";
import type { ClipboardSnapshot, DragDropEvent, Platform } from "./types";

const DATA_DIR = "C:\\mock-data";
const paths = createPathTools("\\");
const noop = (): Promise<void> => Promise.resolve();

/** 点选文件时给的样例文件。 */
const SAMPLES = {
  image: ["ref_01.png", "ref_02.png", "ref_03.png"],
  audio: ["voice_01.wav", "voice_02.wav"],
  video: ["clip_01.mp4", "clip_02.mp4"],
};
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "m4a", "aac", "flac", "ogg"]);
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif", "bmp", "svg"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "m4v", "mkv"]);

const fs = createMemoryFs(paths, DATA_DIR);

/** 已经有了页面地址的文件：规整后的路径到 blob 地址。 */
const mediaUrls = new Map<string, string>();
const mediaKey = (path: string) => paths.absolute(path, DATA_DIR);

function mimeForPath(path: string): string {
  const extension = paths.splitExt(path)[1].replace(/^\./, "").toLowerCase();
  if (extension === "jpg") return "image/jpeg";
  if (IMAGE_EXTENSIONS.has(extension)) return `image/${extension}`;
  if (VIDEO_EXTENSIONS.has(extension)) return `video/${extension === "mov" ? "quicktime" : extension}`;
  if (extension === "mp3") return "audio/mpeg";
  if (AUDIO_EXTENSIONS.has(extension)) return `audio/${extension}`;
  return "application/octet-stream";
}

function remember(path: string, bytes: Uint8Array): void {
  const key = mediaKey(path);
  const previous = mediaUrls.get(key);
  if (previous) URL.revokeObjectURL(previous);
  // 复制一份：Blob 不接受可能指向共享内存的视图
  const copy = new Uint8Array(bytes);
  mediaUrls.set(key, URL.createObjectURL(new Blob([copy], { type: mimeForPath(path) })));
}

/** 把一份内容存进内存文件系统，顺便登记它的页面地址。 */
async function storeBytes(bytes: Uint8Array, path: string): Promise<string> {
  await fs.makeDirs(paths.dirname(path));
  await fs.write(path, bytes);
  remember(path, bytes);
  return path;
}

function canvasBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) {
        reject(new Error("could not draw the mock image"));
        return;
      }
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, "image/png");
  });
}

/** 样例参考图：一张写着名字的蓝红渐变图。 */
async function sampleImage(label: string): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 320;
  const context = canvas.getContext("2d");
  if (context) {
    const gradient = context.createLinearGradient(0, 0, 320, 320);
    gradient.addColorStop(0, "#4a90d9");
    gradient.addColorStop(1, "#d94a6a");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 320, 320);
    context.fillStyle = "rgba(255, 255, 255, 0.92)";
    context.font = '600 28px "Segoe UI", "Microsoft YaHei", sans-serif';
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(label, 160, 160);
  }
  return canvasBytes(canvas);
}

/** 生成结果用的假图：底色随提示词变，中间写上提示词和尺寸。 */
async function drawMockImage(label: string, width: number, height: number): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context) {
    let hash = 0;
    for (const char of label) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
    const hue = hash % 360;
    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, `hsl(${hue} 72% 64%)`);
    gradient.addColorStop(1, `hsl(${(hue + 70) % 360} 62% 36%)`);
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);

    const fontSize = Math.max(14, Math.round(width / 30));
    context.font = `${fontSize}px "Segoe UI", "Microsoft YaHei", sans-serif`;
    context.fillStyle = "rgba(255, 255, 255, 0.94)";
    context.textAlign = "center";
    context.textBaseline = "middle";
    // 提示词折成最多四行，放不下的加省略号
    const maxWidth = width * 0.84;
    const lines: string[] = [];
    let line = "";
    for (const char of label) {
      if (context.measureText(line + char).width > maxWidth) {
        lines.push(line);
        line = "";
        if (lines.length === 3) {
          line = "…";
          break;
        }
      }
      line += char;
    }
    lines.push(line || "(empty prompt)");
    lines.forEach((text, index) => {
      context.fillText(text, width / 2, height / 2 + (index - (lines.length - 1) / 2) * fontSize * 1.4);
    });
    context.font = `${Math.round(fontSize * 0.8)}px "Segoe UI", sans-serif`;
    context.fillStyle = "rgba(255, 255, 255, 0.75)";
    context.fillText(`${width} × ${height}`, width / 2, height - fontSize * 1.6);
  }
  return canvasBytes(canvas);
}

/** 半秒 440 赫兹的正弦波，给样例音频用。 */
function sampleWav(): Uint8Array {
  const sampleRate = 8000;
  const sampleCount = Math.floor(sampleRate * 0.6);
  const view = new DataView(new ArrayBuffer(44 + sampleCount * 2));
  const writeText = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, sampleCount * 2, true);
  for (let index = 0; index < sampleCount; index += 1) {
    view.setInt16(44 + index * 2, Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 5000), true);
  }
  return new Uint8Array(view.buffer);
}

let wavUrl: string | null = null;

/** 还没登记过地址的文件给一张占位图或一段占位音频，免得界面上是空白。 */
function placeholderUrl(path: string): string {
  const extension = paths.splitExt(path)[1].replace(/^\./, "").toLowerCase();
  if (AUDIO_EXTENSIONS.has(extension)) {
    wavUrl ??= `data:audio/wav;base64,${bytesToBase64(sampleWav())}`;
    return wavUrl;
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    const name = paths.basename(path).replace(/[<>&]/g, "");
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320">` +
      `<rect width="320" height="320" fill="#8a8a8a"/>` +
      `<text x="160" y="160" fill="#fff" font-size="16" text-anchor="middle" dominant-baseline="middle">${name}</text></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }
  return "";
}

async function ensureSamples(kind: "image" | "audio" | "video"): Promise<string[]> {
  const result: string[] = [];
  for (const name of SAMPLES[kind]) {
    const path = paths.join(DATA_DIR, "samples", name);
    result.push(path);
    if (mediaUrls.has(mediaKey(path))) continue;
    const bytes =
      kind === "audio"
        ? sampleWav()
        : kind === "video"
          ? // 假视频放一段说明文字，浏览器解不了码，界面会走它的占位分支
            new TextEncoder().encode("mock video for the browser preview")
          : await sampleImage(paths.splitExt(name)[0]);
    await storeBytes(bytes, path);
  }
  return result;
}

async function readClipboard(): Promise<ClipboardSnapshot> {
  // 浏览器只在用户手势里才肯给剪贴板读权限，拿不到就当剪贴板是空的
  if (!navigator.clipboard?.read) return { kind: "empty" };
  try {
    for (const item of await navigator.clipboard.read()) {
      // 与源项目同序：位图、文件、文本；浏览器里读不到文件列表
      const imageType = item.types.find((type) => type.startsWith("image/"));
      if (imageType) {
        const blob = await item.getType(imageType);
        const name = `grsai_clipboard_${Math.floor(Date.now() / 1000)}.png`;
        return { kind: "image", path: await storeBytes(new Uint8Array(await blob.arrayBuffer()), paths.join(DATA_DIR, "input", name)) };
      }
      if (item.types.includes("text/plain")) {
        return { kind: "text", text: await (await item.getType("text/plain")).text() };
      }
    }
  } catch {
    // 没有权限，或者剪贴板里没有可读的内容
  }
  return { kind: "empty" };
}

function subscribeDragDrop(handler: (event: DragDropEvent) => void): () => void {
  const positionOf = (event: DragEvent) => ({ x: event.clientX, y: event.clientY });
  const isFileDrag = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
  let inside = false;

  const onDragEnter = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    inside = true;
    handler({ type: "enter", position: positionOf(event), paths: [] });
  };
  const onDragOver = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    handler({ type: "over", position: positionOf(event), paths: [] });
  };
  // 拖出窗口时 relatedTarget 是 null；在窗口里换元素不算离开
  const onDragLeave = (event: DragEvent) => {
    if (!inside || event.relatedTarget !== null) return;
    inside = false;
    handler({ type: "leave", position: { x: -1, y: -1 }, paths: [] });
  };
  const onDrop = async (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    inside = false;
    const dropped: string[] = [];
    for (const file of Array.from(event.dataTransfer?.files ?? [])) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      dropped.push(await storeBytes(bytes, paths.join(DATA_DIR, "input", file.name)));
    }
    handler({ type: "drop", position: positionOf(event), paths: dropped });
  };

  window.addEventListener("dragenter", onDragEnter);
  window.addEventListener("dragover", onDragOver);
  window.addEventListener("dragleave", onDragLeave);
  window.addEventListener("drop", onDrop);
  return () => {
    window.removeEventListener("dragenter", onDragEnter);
    window.removeEventListener("dragover", onDragOver);
    window.removeEventListener("dragleave", onDragLeave);
    window.removeEventListener("drop", onDrop);
  };
}

export const browserPlatform: Platform = {
  isTauri: false,
  init: noop,
  get dataDir() {
    return DATA_DIR;
  },
  paths,
  window: {
    minimize: noop,
    toggleMaximize: noop,
    close: noop,
    destroy: noop,
    isMaximized: () => Promise.resolve(false),
    setTitle: noop,
    setTheme: noop,
    onResized: () => () => {},
    onCloseRequested: () => () => {},
  },
  fs,
  http: createMockHttp({
    fs,
    paths,
    makeImage: drawMockImage,
    onWritten: (path, bytes) => remember(path, bytes),
  }),
  configStorage: {
    read: () => window.localStorage.getItem(CONFIG_FILE_NAME),
    write: (text) => {
      window.localStorage.setItem(CONFIG_FILE_NAME, text);
    },
  },
  // 历史库在浏览器里是内存实现，刷新页面就清空
  openDatabase: async () => createMemoryDatabase(),

  dialog: {
    async pickFiles(options = {}) {
      const extensions = (options.filters ?? []).flatMap((filter) => filter.extensions);
      const lowered = extensions.map((extension) => extension.toLowerCase());
      const kind = lowered.some((extension) => VIDEO_EXTENSIONS.has(extension))
        ? "video"
        : lowered.some((extension) => AUDIO_EXTENSIONS.has(extension))
          ? "audio"
          : "image";
      const files = await ensureSamples(kind);
      return options.multiple ? files : files.slice(0, 1);
    },
    async pickDirectory() {
      const path = paths.join(DATA_DIR, "picked-output");
      await fs.makeDirs(path);
      return path;
    },
  },

  opener: {
    // 浏览器里不真的打开东西，弹一条提示说明会打开哪个路径
    openPath: async (path) => {
      notice("info", "Browser mock", `open ${path}`);
    },
  },

  clipboard: {
    read: readClipboard,
  },

  dragDrop: {
    subscribe: subscribeDragDrop,
  },

  media: {
    allow: () => noop(),
    url: (path) => mediaUrls.get(mediaKey(path)) ?? placeholderUrl(path),
  },
};
