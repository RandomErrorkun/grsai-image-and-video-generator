/**
 * 历史记录持久化缩略图（方形低画质 WebP/JPEG data URL）与结果文件 SHA-256 完整性校验。
 *
 * - 图像 / GIF（自动取首帧）/ SVG（自动位图化）/ 视频（自动取首帧）均居中裁剪成 176×176（2x 清晰度对应 88×88 展示位）
 *   的低画质 data URL 存入 history_tasks.thumbnail，即使原文件被删除或移动，历史列表仍保留参考缩略图。
 * - 结果落盘时同步计算 SHA-256 存入 history_tasks.result_sha256；点击打开历史结果前先校验文件存在且哈希一致，
 *   防止原文件被删后被同名文件冒名顶替。
 */
import type { HistoryTask } from "../core/history";
import { isVideoResult } from "../pages/historyView";
import { platform } from "../platform";

/** 缩略图边长（像素）：88px 展示位的 2x 清晰度，同时严格控制在 256×256 以内，单张约 4–10 KB。 */
export const THUMBNAIL_SIZE = 176;
const THUMBNAIL_QUALITY = 0.78;
const IMAGE_DECODE_TIMEOUT_MS = 8000;
const VIDEO_DECODE_TIMEOUT_MS = 10000;

export interface ResultArtifacts {
  thumbnail: string | null;
  resultSha256: string | null;
}

export type VerifyResultOutcome =
  | { ok: true; path: string; needsBackfill: boolean }
  | { ok: false; reason: "missing" | "mismatch" };

export interface VerifyFileDeps {
  allowPath(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  sha256(path: string): Promise<string>;
}

/** 把任意源图像/视频帧按 center-crop 画进方形画布并编码成低画质 data URL（优先 WebP，回退 JPEG）。 */
function encodeSquareCanvas(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
): string | null {
  if (typeof document === "undefined") return null;
  const w = sourceWidth > 0 ? sourceWidth : THUMBNAIL_SIZE;
  const h = sourceHeight > 0 ? sourceHeight : THUMBNAIL_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = THUMBNAIL_SIZE;
  canvas.height = THUMBNAIL_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  // 居中裁切正方形，确保在 88×88 缩略图框里不拉伸不变形
  const side = Math.min(w, h);
  const sx = (w - side) / 2;
  const sy = (h - side) / 2;
  try {
    ctx.drawImage(source, sx, sy, side, side, 0, 0, THUMBNAIL_SIZE, THUMBNAIL_SIZE);
    const webp = canvas.toDataURL("image/webp", THUMBNAIL_QUALITY);
    if (webp.startsWith("data:image/webp")) return webp;
    const jpeg = canvas.toDataURL("image/jpeg", THUMBNAIL_QUALITY);
    return jpeg.startsWith("data:image/") ? jpeg : null;
  } catch {
    return null;
  }
}

function captureImageThumbnail(url: string): Promise<string | null> {
  if (typeof Image === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    let settled = false;
    const finish = (result: string | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      resolve(result);
    };
    const timer = window.setTimeout(() => finish(null), IMAGE_DECODE_TIMEOUT_MS);
    img.onload = () => {
      finish(encodeSquareCanvas(img, img.naturalWidth, img.naturalHeight));
    };
    img.onerror = () => finish(null);
    img.src = url;
  });
}

function captureVideoThumbnail(url: string): Promise<string | null> {
  if (typeof document === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";
    let settled = false;
    const cleanup = () => {
      window.clearTimeout(timer);
      video.onloadeddata = null;
      video.onseeked = null;
      video.onerror = null;
      video.removeAttribute("src");
      video.load();
    };
    const finish = (result: string | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const timer = window.setTimeout(() => finish(null), VIDEO_DECODE_TIMEOUT_MS);
    const draw = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        finish(encodeSquareCanvas(video, video.videoWidth, video.videoHeight));
      } else {
        finish(null);
      }
    };
    video.onloadeddata = () => {
      if (video.readyState >= 2 && video.videoWidth > 0) {
        draw();
        return;
      }
      try {
        video.currentTime = 0.01;
      } catch {
        draw();
      }
    };
    video.onseeked = draw;
    video.onerror = () => finish(null);
    video.src = url;
    video.load();
  });
}

/** 为本地结果文件生成 176×176 低画质缩略图 data URL；在无 DOM 环境或解码失败时返回 null。 */
export async function generateThumbnailDataUrl(path: string): Promise<string | null> {
  if (typeof document === "undefined" || !path) return null;
  try {
    await platform.media.allow([path]);
  } catch {
    // 放行失败仍尝试继续
  }
  const url = platform.media.url(path);
  if (!url) return null;
  return isVideoResult(path) ? captureVideoThumbnail(url) : captureImageThumbnail(url);
}

/** 并行计算本地结果文件的 SHA-256 与持久化缩略图；任何单项失败都安全返回 null，不影响主流程。 */
export async function computeResultArtifacts(path: string): Promise<ResultArtifacts> {
  if (!path) return { thumbnail: null, resultSha256: null };
  try {
    await platform.media.allow([path]);
  } catch {
    // ignore
  }
  const [resultSha256, thumbnail] = await Promise.all([
    platform.fs.sha256(path).catch(() => null),
    generateThumbnailDataUrl(path).catch(() => null),
  ]);
  return { thumbnail, resultSha256 };
}

/**
 * 校验历史记录的结果文件是否仍在本地且内容与记录的 SHA-256 一致。
 * - 文件不存在 -> missing
 * - 记录了 result_sha256 且当前文件哈希不一致 -> mismatch（防止同名替换）
 * - 文件存在且校验通过（或老记录尚无哈希）-> ok（老记录带 needsBackfill: true）
 */
export async function verifyHistoryResultFile(
  task: Pick<HistoryTask, "result_path" | "result_sha256">,
  deps: VerifyFileDeps = {
    allowPath: (p) => platform.media.allow([p]),
    exists: (p) => platform.fs.exists(p),
    sha256: (p) => platform.fs.sha256(p),
  },
): Promise<VerifyResultOutcome> {
  const path = task.result_path;
  if (!path) return { ok: false, reason: "missing" };
  try {
    await deps.allowPath(path);
  } catch {
    // ignore
  }
  const exists = await deps.exists(path).catch(() => false);
  if (!exists) return { ok: false, reason: "missing" };

  if (task.result_sha256) {
    const actual = await deps.sha256(path).catch(() => null);
    if (!actual || actual.toLowerCase() !== task.result_sha256.toLowerCase()) {
      return { ok: false, reason: "mismatch" };
    }
    return { ok: true, path, needsBackfill: false };
  }
  return { ok: true, path, needsBackfill: true };
}
