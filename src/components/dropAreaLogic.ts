/**
 * 参考图区和参考音频区共用的纯逻辑，对应 image_drop_area.py 和 audio_drop_area.py 里的常量与几个小函数。
 * 不依赖 React 和 DOM，单测在 Node 里直接跑。
 */
import type { FileFilter } from "../platform/types";

export const IMAGE_EXTENSIONS: readonly string[] = [".png", ".jpg", ".jpeg", ".webp", ".bmp"];
export const AUDIO_EXTENSIONS: readonly string[] = [".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"];

/** 对应 _is_supported_image / _is_supported_audio：空串不算，按整个路径的小写后缀判断。 */
function endsWithAny(path: string, extensions: readonly string[]): boolean {
  const lower = path.toLowerCase();
  return lower !== "" && extensions.some((extension) => lower.endsWith(extension));
}

export function isSupportedImage(path: string): boolean {
  return endsWithAny(path, IMAGE_EXTENSIONS);
}

export function isSupportedAudio(path: string): boolean {
  return endsWithAny(path, AUDIO_EXTENSIONS);
}

/**
 * 对应 Windows 上的 os.path.normpath：斜杠统一成反斜杠，消掉重复分隔符、空段和 `.`，
 * `..` 弹出上一段（已经在根下的弹不掉，直接丢掉）。不改大小写，不解析符号链接。
 */
export function normalizePath(path: string): string {
  const unified = path.replace(/\//g, "\\");
  if (unified === "") return ".";
  const drive = /^[a-zA-Z]:/.exec(unified)?.[0] ?? "";
  let rest = unified.slice(drive.length);
  let root = "";
  // 网络路径：\\server\share\ 之后才是目录部分
  if (rest.startsWith("\\\\") && rest[2] !== "\\") {
    const serverEnd = rest.indexOf("\\", 2);
    const shareEnd = serverEnd === -1 ? -1 : rest.indexOf("\\", serverEnd + 1);
    root = shareEnd === -1 ? rest : rest.slice(0, shareEnd + 1);
    rest = shareEnd === -1 ? "" : rest.slice(shareEnd + 1);
  } else if (rest.startsWith("\\")) {
    root = "\\";
    rest = rest.slice(1);
  }
  const prefix = drive + root;
  const segments: string[] = [];
  for (const segment of rest.split("\\")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") segments.pop();
      else if (!root) segments.push("..");
      continue;
    }
    segments.push(segment);
  }
  // 盘符后面没跟分隔符（C:foo）时不算有根，.. 照留
  return prefix === "" && segments.length === 0 ? "." : prefix + segments.join("\\");
}

/** 一次加入的名额怎么分，对应 add_images / add_files 里算名额的那一段。 */
export interface SlotPlan {
  /** 这次真正加进去的路径，按给定顺序。 */
  toAdd: string[];
  /** 名额不够，被跳过的个数。 */
  skipped: number;
  /** 一个名额都没有；源项目在这时给 limit_reached 提示。 */
  full: boolean;
}

/**
 * 先看名额，再看内容，顺序与源项目一致：没有名额时哪怕送来的全是重复或不支持的路径，也算「已满」。
 * accept 判断格式；已经在列表里或这次重复出现的路径只算一次。
 */
export function planSlots(
  existing: readonly string[],
  candidates: readonly string[],
  max: number,
  accept: (path: string) => boolean,
): SlotPlan {
  const untouched: SlotPlan = { toAdd: [], skipped: 0, full: false };
  if (candidates.length === 0) return untouched;
  const available = Math.max(max - existing.length, 0);
  if (available === 0) return { toAdd: [], skipped: 0, full: true };
  const fresh: string[] = [];
  for (const path of candidates) {
    if (!accept(path) || existing.includes(path) || fresh.includes(path)) continue;
    fresh.push(path);
  }
  if (fresh.length === 0) return untouched;
  const toAdd = fresh.slice(0, available);
  return { toAdd, skipped: fresh.length - toAdd.length, full: false };
}

const pad2 = (value: number) => String(value).padStart(2, "0");

/** Python 的 round()：恰好一半时向偶数舍入，2.5 得 2、3.5 得 4。 */
function pyRound(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction < 0.5) return floor;
  if (fraction > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** 对应 _format_duration：没有时长或时长不大于 0 时显示 --:--；分钟不满两位补零，超过两位照写。 */
export function formatDuration(ms: number | undefined): string {
  if (!ms || ms <= 0) return "--:--";
  const total = pyRound(ms / 1000);
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

/**
 * 把源项目写法的筛选文案拆成对话框要的结构：
 * "Image files (*.jpg *.png)" 变成 { name: "Image files", extensions: ["jpg", "png"] }。没有括号的文案按全部文件处理。
 */
export function parseFileFilter(text: string): FileFilter {
  const name = text.trim();
  const match = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(name);
  if (!match) return { name, extensions: [] };
  const extensions = match[2]
    .split(/\s+/)
    .map((token) => token.replace(/^\*\./, "").replace(/^\./, "").toLowerCase())
    .filter((token) => token !== "");
  return { name: match[1].trim(), extensions };
}

/** Ctrl+V 的判断：只按着 Ctrl（或 macOS 的 Command）的 V。源项目里同时按着 Shift 或 Alt 不算，大小写锁定不影响键名。 */
export function isPasteShortcut(event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  return (event.key === "v" || event.key === "V") && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey;
}

/** 点是否落在矩形内；右边和下边不算在内，与 getBoundingClientRect 的右下角开区间一致。 */
export function containsPoint(rect: { left: number; top: number; right: number; bottom: number }, x: number, y: number): boolean {
  return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
}

/**
 * 拖放事件的光标是否落在这个元素身上。所在的页面隐藏（display: none）时量不到矩形，不算在内。
 * 只要元素的两个量尺寸方法，测试里可以拿假对象代替。
 */
export function isDragOver(
  element: Pick<HTMLElement, "getClientRects" | "getBoundingClientRect"> | null,
  event: { position: { x: number; y: number } },
): boolean {
  if (element === null || element.getClientRects().length === 0) return false;
  return containsPoint(element.getBoundingClientRect(), event.position.x, event.position.y);
}

/**
 * 一次 Ctrl+V 只能落进一个素材区：可见的里面先挑还有名额的那个，都满了就挑排在最前的可见的那个。
 * 这与源项目视频页的 _paste_target 同路：首尾帧模式下先贴空的帧槽，都满了贴首帧（随后提示已满）。
 */
export function pickPasteTarget<T extends { visible: boolean; freeSlots: number }>(candidates: readonly T[]): T | undefined {
  const visible = candidates.filter((candidate) => candidate.visible);
  return visible.find((candidate) => candidate.freeSlots > 0) ?? visible[0];
}
