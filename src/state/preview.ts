/**
 * 媒体预览状态仓：统一接管所有图片/GIF/SVG/视频预览入口。
 * 按配置 preview_mode 决定：默认 "internal" 弹出软件内灯箱；"system" 交给系统默认软件打开。
 */
import { platform } from "../platform";
import { runAsync } from "../platform/async";
import { cfg } from "./config";

export type PreviewMode = "internal" | "system";
export type PreviewMediaKind = "image" | "gif" | "svg" | "video" | "other";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "bmp", "ico", "avif"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "m4v", "mkv", "avi"]);

export function normalizePreviewMode(value: unknown): PreviewMode {
  return value === "system" ? "system" : "internal";
}

export function classifyPreviewMedia(path: string): PreviewMediaKind {
  const match = /\.([^.\\/]+)$/.exec(path.trim());
  const ext = match ? match[1].toLowerCase() : "";
  if (ext === "gif") return "gif";
  if (ext === "svg") return "svg";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  return "other";
}

export interface PreviewTarget {
  path: string;
  kind: Exclude<PreviewMediaKind, "other">;
}

let currentTarget: PreviewTarget | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

export function subscribePreview(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getPreviewTarget(): PreviewTarget | null {
  return currentTarget;
}

export function closePreview(): void {
  if (currentTarget === null) return;
  currentTarget = null;
  notify();
}

/** 统一预览入口：根据设置选择软件内灯箱或系统默认程序；不支持的类型始终交给系统。 */
export function openPreview(path: string): void {
  if (!path) return;
  const kind = classifyPreviewMedia(path);
  const mode = normalizePreviewMode(cfg.get("preview_mode", "internal"));
  if (mode === "system" || kind === "other") {
    runAsync(platform.opener.openPath(path));
    return;
  }
  currentTarget = { path, kind };
  notify();
}
