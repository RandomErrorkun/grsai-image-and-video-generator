/**
 * 软件内媒体预览灯箱（Lightbox）：
 * - 图像（PNG/JPG/WEBP/BMP/SVG）：顺/逆时针旋转 90°、按钮与滚轮缩放（10%~800%）、缩放后拖拽平移、重置视图、右键菜单复制图像/打开所在目录/系统打开。
 * - GIF：基于 Chromium 原生 ImageDecoder 按帧解码，支持播放/暂停、左右方向键逐帧步进（上一帧/下一帧）、缩放旋转、右键复制当前帧。
 * - 视频：播放/暂停/停止、可拖拽进度条、静音与音量条、左右方向键逐帧步进、右键复制当前帧/打开所在目录/系统打开。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { Button, Tooltip } from "@fluentui/react-components";
import {
  ArrowClockwise20Regular,
  ArrowCounterclockwise20Regular,
  ArrowReset20Regular,
  Copy20Regular,
  Dismiss20Regular,
  FolderOpen20Regular,
  Next20Regular,
  Open20Regular,
  Pause20Regular,
  Play20Regular,
  Previous20Regular,
  Speaker220Regular,
  SpeakerMute20Regular,
  Stop20Regular,
  ZoomIn20Regular,
  ZoomOut20Regular,
} from "@fluentui/react-icons";
import { useTr } from "../hooks/useLanguage";
import { platform } from "../platform";
import { runAsync } from "../platform/async";
import { closePreview, getPreviewTarget, subscribePreview, type PreviewTarget } from "../state/preview";
import { notice } from "./Notice";
import "./MediaLightbox.css";

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.2;
const DEFAULT_VIDEO_FRAME_STEP = 1 / 30;
const GIF_FPS_PRESETS = [6, 8, 12, 15, 24, 30, 60] as const;

interface DecodedGifFrame {
  bitmap: ImageBitmap;
  /** 这一帧持续多少毫秒。 */
  durationMs: number;
}

interface NativeImageDecoder {
  tracks: { ready: Promise<void>; selectedTrack?: { frameCount?: number } | null };
  decode(options: { frameIndex: number }): Promise<{
    image: CanvasImageSource & { duration?: number | null; close?: () => void };
  }>;
  close(): void;
}

type ImageDecoderCtor = new (init: { data: BufferSource; type: string }) => NativeImageDecoder;

function imageMimeFor(path: string): string {
  const ext = platform.paths.splitExt(path)[1].replace(/^\./, "").toLowerCase();
  if (ext === "svg") return "image/svg+xml";
  if (ext === "gif") return "image/gif";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "bmp") return "image/bmp";
  if (ext === "avif") return "image/avif";
  return "image/png";
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
  const whole = Math.floor(seconds);
  const mins = Math.floor(whole / 60);
  const secs = whole % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

/** 把任意 CanvasImageSource（图片、SVG、GIF 帧、视频帧）按指定旋转角度画到离屏画布，取 RGBA 写入系统剪贴板。 */
async function copySourceToClipboard(
  source: CanvasImageSource,
  rawWidth: number,
  rawHeight: number,
  rotationDeg = 0,
): Promise<void> {
  const width = Math.max(1, Math.round(rawWidth));
  const height = Math.max(1, Math.round(rawHeight));
  const normalized = ((rotationDeg % 360) + 360) % 360;
  const swap = normalized === 90 || normalized === 270;
  const outW = swap ? height : width;
  const outH = swap ? width : height;
  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");
  ctx.translate(outW / 2, outH / 2);
  ctx.rotate((normalized * Math.PI) / 180);
  ctx.drawImage(source, -width / 2, -height / 2, width, height);
  const imageData = ctx.getImageData(0, 0, outW, outH);
  const rgba = new Uint8Array(imageData.data.buffer, imageData.data.byteOffset, imageData.data.byteLength);
  await platform.clipboard.writeImage(rgba, outW, outH);
}

/** 挂在 AppProvider 里的全局灯箱宿主（用于浏览器 mock 或回退场景）。 */
export function MediaLightboxHost() {
  const target = useSyncExternalStore(subscribePreview, getPreviewTarget);
  if (!target) return null;
  return <MediaLightbox key={target.path} target={target} onClose={closePreview} />;
}

interface ContextMenuState {
  x: number;
  y: number;
}

export function MediaLightbox({ target, onClose = closePreview }: { target: PreviewTarget; onClose?: () => void }) {
  const t = useTr();
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [ready, setReady] = useState(false);

  // 允许访问本地路径后再渲染
  useEffect(() => {
    let cancelled = false;
    runAsync(
      platform.media.allow([target.path]).then(
        () => {
          if (!cancelled) setReady(true);
        },
        () => {
          if (!cancelled) setReady(true);
        },
      ),
    );
    return () => {
      cancelled = true;
    };
  }, [target.path]);

  // 点击别处关闭右键菜单
  useEffect(() => {
    if (!menu) return;
    const hide = () => setMenu(null);
    document.addEventListener("pointerdown", hide);
    return () => document.removeEventListener("pointerdown", hide);
  }, [menu]);

  const openMenu = useCallback((event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const x = Math.min(event.clientX, Math.max(8, window.innerWidth - 230));
    const y = Math.min(event.clientY, Math.max(8, window.innerHeight - 190));
    setMenu({ x, y });
  }, []);

  const openFolder = useCallback(() => {
    setMenu(null);
    runAsync(platform.opener.openPath(platform.paths.dirname(target.path)));
  }, [target.path]);

  const openSystem = useCallback(() => {
    setMenu(null);
    runAsync(platform.opener.openPath(target.path));
  }, [target.path]);

  const filename = platform.paths.basename(target.path);

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={filename}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="lightbox__header">
        <span className="lightbox__filename" title={target.path}>
          {filename}
        </span>
        <Tooltip content={t("preview.close")} relationship="label">
          <Button
            appearance="transparent"
            className="lightbox__icon-btn"
            icon={<Dismiss20Regular />}
            aria-label={t("preview.close")}
            onClick={onClose}
          />
        </Tooltip>
      </div>

      {!ready ? (
        <div className="lightbox__stage" />
      ) : target.kind === "video" ? (
        <VideoLightboxBody
          path={target.path}
          menu={menu}
          onClose={onClose}
          onCloseMenu={() => setMenu(null)}
          onOpenMenu={openMenu}
          onOpenFolder={openFolder}
          onOpenSystem={openSystem}
        />
      ) : (
        <ImageLightboxBody
          path={target.path}
          kind={target.kind}
          menu={menu}
          onClose={onClose}
          onCloseMenu={() => setMenu(null)}
          onOpenMenu={openMenu}
          onOpenFolder={openFolder}
          onOpenSystem={openSystem}
        />
      )}
    </div>
  );
}

interface BodyProps {
  path: string;
  menu: ContextMenuState | null;
  onClose(): void;
  onCloseMenu(): void;
  onOpenMenu(event: ReactMouseEvent): void;
  onOpenFolder(): void;
  onOpenSystem(): void;
}

/** 图像 / SVG / GIF 预览主体。 */
function ImageLightboxBody({ path, kind, menu, onClose, onCloseMenu, onOpenMenu, onOpenFolder, onOpenSystem }: BodyProps & { kind: "image" | "gif" | "svg" }) {
  const t = useTr();
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const gifCanvasRef = useRef<HTMLCanvasElement>(null);

  // 本地字节转同源 blob URL，确保 PNG/JPG/SVG 复制到剪贴板时画布永远不被跨域污染
  const [blobSrc, setBlobSrc] = useState<string | null>(null);

  // GIF 帧解码状态
  const [gifFrames, setGifFrames] = useState<DecodedGifFrame[] | null>(null);
  const [gifIndex, setGifIndex] = useState(0);
  const [gifPlaying, setGifPlaying] = useState(true);
  // 空串表示按 GIF 原始帧延时播放；填正数表示按指定 FPS 匀速播放
  const [gifFpsText, setGifFpsText] = useState("");
  const [fpsMenuOpen, setFpsMenuOpen] = useState(false);

  // 点击别处关闭帧率预设菜单
  useEffect(() => {
    if (!fpsMenuOpen) return;
    const hide = () => setFpsMenuOpen(false);
    document.addEventListener("pointerdown", hide);
    return () => document.removeEventListener("pointerdown", hide);
  }, [fpsMenuOpen]);

  const stepGifFps = (delta: number) => {
    setFpsMenuOpen(false);
    const trimmed = gifFpsText.trim();
    const parsed = trimmed === "" ? 12 : Number(trimmed);
    const base = Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 12;
    const next = Math.min(120, Math.max(1, trimmed === "" ? base : base + delta));
    setGifFpsText(String(next));
  };

  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;
    const bitmaps: ImageBitmap[] = [];

    runAsync(
      (async () => {
        const bytes = await platform.fs.read(path).catch(() => null);
        if (cancelled) return;
        if (!bytes) {
          setBlobSrc(platform.media.url(path));
          return;
        }
        const copy = new Uint8Array(bytes);
        createdUrl = URL.createObjectURL(new Blob([copy], { type: imageMimeFor(path) }));
        setBlobSrc(createdUrl);

        if (kind === "gif" && typeof (globalThis as Record<string, unknown>).ImageDecoder === "function") {
          try {
            const Ctor = (globalThis as unknown as { ImageDecoder: ImageDecoderCtor }).ImageDecoder;
            const decoder = new Ctor({ data: copy, type: "image/gif" });
            try {
              await decoder.tracks.ready;
              const count = decoder.tracks.selectedTrack?.frameCount ?? 0;
              if (count > 1) {
                const decoded: DecodedGifFrame[] = [];
                for (let index = 0; index < count; index += 1) {
                  if (cancelled) break;
                  const result = await decoder.decode({ frameIndex: index });
                  const frame = result.image;
                  const durationUs = typeof frame.duration === "number" && frame.duration > 0 ? frame.duration : 100_000;
                  const bitmap = await createImageBitmap(frame);
                  frame.close?.();
                  bitmaps.push(bitmap);
                  decoded.push({ bitmap, durationMs: Math.max(20, Math.round(durationUs / 1000)) });
                }
                if (!cancelled && decoded.length > 0) setGifFrames(decoded);
              }
            } finally {
              decoder.close();
            }
          } catch {
            // ImageDecoder 解码失败时回退到普通 img 播放
          }
        }
      })(),
    );

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
      for (const bmp of bitmaps) bmp.close();
    };
  }, [path, kind]);

  // 把当前 GIF 帧画到画布上
  useEffect(() => {
    const canvas = gifCanvasRef.current;
    const frame = gifFrames?.[gifIndex];
    if (!canvas || !frame) return;
    if (canvas.width !== frame.bitmap.width || canvas.height !== frame.bitmap.height) {
      canvas.width = frame.bitmap.width;
      canvas.height = frame.bitmap.height;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(frame.bitmap, 0, 0);
  }, [gifFrames, gifIndex]);

  // GIF 自动轮播：未指定 FPS 时用每帧原始延时，指定 FPS 时按 1000/fps 匀速播放
  useEffect(() => {
    if (!gifFrames || gifFrames.length <= 1 || !gifPlaying) return;
    const trimmed = gifFpsText.trim();
    const parsed = trimmed === "" ? Number.NaN : Number(trimmed);
    const delay =
      Number.isFinite(parsed) && parsed > 0
        ? Math.max(8, Math.round(1000 / Math.min(120, Math.max(0.5, parsed))))
        : (gifFrames[gifIndex]?.durationMs ?? 100);
    const timer = window.setTimeout(() => {
      setGifIndex((current) => (current + 1) % gifFrames.length);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [gifFrames, gifIndex, gifPlaying, gifFpsText]);

  const stepGifFrame = useCallback(
    (delta: number) => {
      if (!gifFrames || gifFrames.length <= 1) return;
      setGifPlaying(false);
      setGifIndex((current) => (current + delta + gifFrames.length) % gifFrames.length);
    },
    [gifFrames],
  );

  const resetView = useCallback(() => {
    setZoom(1);
    setRotation(0);
    setPan({ x: 0, y: 0 });
  }, []);

  const zoomBy = useCallback((factor: number) => {
    setZoom((current) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(current * factor * 100) / 100)));
  }, []);

  // 键盘快捷键
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (fpsMenuOpen) setFpsMenuOpen(false);
        else if (menu) onCloseMenu();
        else onClose();
        return;
      }
      // 在 FPS 输入框里打字时不抢占方向键、空格和数字键
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (gifFrames && gifFrames.length > 1) {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          stepGifFrame(-1);
          return;
        }
        if (event.key === "ArrowRight") {
          event.preventDefault();
          stepGifFrame(1);
          return;
        }
        if (event.key === " ") {
          event.preventDefault();
          setGifPlaying((p) => !p);
          return;
        }
      }
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomBy(ZOOM_STEP);
      } else if (event.key === "-") {
        event.preventDefault();
        zoomBy(1 / ZOOM_STEP);
      } else if (event.key === "0") {
        event.preventDefault();
        resetView();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fpsMenuOpen, gifFrames, menu, onClose, onCloseMenu, resetView, stepGifFrame, zoomBy]);

  const copyCurrent = useCallback(async () => {
    onCloseMenu();
    try {
      const frame = gifFrames?.[gifIndex];
      if (frame) {
        await copySourceToClipboard(frame.bitmap, frame.bitmap.width, frame.bitmap.height, rotation);
      } else if (imgRef.current) {
        const img = imgRef.current;
        const w = img.naturalWidth || img.clientWidth || 1024;
        const h = img.naturalHeight || img.clientHeight || 1024;
        await copySourceToClipboard(img, w, h, rotation);
      } else {
        throw new Error("Image not loaded yet");
      }
      notice("success", t("common.success"), t("preview.copied"));
    } catch (error) {
      notice("warning", t("common.warning"), error instanceof Error ? error.message : t("preview.copy_failed"));
    }
  }, [gifFrames, gifIndex, onCloseMenu, rotation, t]);

  const onWheel = (event: ReactWheelEvent) => {
    event.preventDefault();
    zoomBy(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
  };

  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { startX: event.clientX, startY: event.clientY, origX: pan.x, origY: pan.y };
  };

  const onPointerMove = (event: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    setPan({ x: drag.origX + (event.clientX - drag.startX), y: drag.origY + (event.clientY - drag.startY) });
  };

  const onPointerUp = () => {
    dragRef.current = null;
  };

  const transformStyle: CSSProperties = {
    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rotation}deg)`,
  };
  const hasGifStepper = Boolean(gifFrames && gifFrames.length > 1);

  return (
    <>
      <div
        className="lightbox__stage"
        onWheel={onWheel}
        onContextMenu={onOpenMenu}
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <div
          className="lightbox__canvas-wrap"
          style={transformStyle}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {hasGifStepper ? (
            <canvas ref={gifCanvasRef} className="lightbox__media" />
          ) : blobSrc ? (
            <img ref={imgRef} src={blobSrc} alt="" draggable={false} className="lightbox__media" />
          ) : null}
        </div>
      </div>

      <div className="lightbox__toolbar">
        {hasGifStepper ? (
          <>
            <Tooltip content={t("preview.prev_frame")} relationship="label">
              <Button
                appearance="transparent"
                className="lightbox__icon-btn"
                icon={<Previous20Regular />}
                aria-label={t("preview.prev_frame")}
                onClick={() => stepGifFrame(-1)}
              />
            </Tooltip>
            <Tooltip content={gifPlaying ? t("preview.pause") : t("preview.play")} relationship="label">
              <Button
                appearance="transparent"
                className="lightbox__icon-btn"
                icon={gifPlaying ? <Pause20Regular /> : <Play20Regular />}
                aria-label={gifPlaying ? t("preview.pause") : t("preview.play")}
                onClick={() => setGifPlaying((p) => !p)}
              />
            </Tooltip>
            <Tooltip content={t("preview.next_frame")} relationship="label">
              <Button
                appearance="transparent"
                className="lightbox__icon-btn"
                icon={<Next20Regular />}
                aria-label={t("preview.next_frame")}
                onClick={() => stepGifFrame(1)}
              />
            </Tooltip>
            <span className="lightbox__badge">
              {gifIndex + 1} / {gifFrames!.length}
            </span>
            <div className="lightbox__fps" title={t("preview.gif_fps")} onPointerDown={(event) => event.stopPropagation()}>
              <button
                type="button"
                className="lightbox__fps-step"
                aria-label="Decrease FPS"
                onClick={() => stepGifFps(-1)}
              >
                −
              </button>
              <input
                type="text"
                inputMode="decimal"
                className="lightbox__fps-input"
                placeholder={t("preview.gif_fps_auto")}
                aria-label={t("preview.gif_fps")}
                value={gifFpsText}
                onChange={(event) => {
                  const next = event.target.value;
                  if (next === "" || /^\d{0,3}(\.\d{0,2})?$/.test(next)) setGifFpsText(next);
                }}
              />
              <button
                type="button"
                className="lightbox__fps-step"
                aria-label="Increase FPS"
                onClick={() => stepGifFps(1)}
              >
                +
              </button>
              <button
                type="button"
                className="lightbox__fps-preset-btn"
                aria-haspopup="menu"
                aria-expanded={fpsMenuOpen}
                onClick={() => setFpsMenuOpen((open) => !open)}
              >
                FPS ▾
              </button>
              {fpsMenuOpen ? (
                <div className="lightbox__fps-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    className={gifFpsText.trim() === "" ? "lightbox__fps-option lightbox__fps-option--active" : "lightbox__fps-option"}
                    onClick={() => {
                      setGifFpsText("");
                      setFpsMenuOpen(false);
                    }}
                  >
                    {t("preview.gif_fps_auto")}
                  </button>
                  {GIF_FPS_PRESETS.map((fps) => (
                    <button
                      key={fps}
                      type="button"
                      role="menuitem"
                      className={
                        gifFpsText.trim() === String(fps)
                          ? "lightbox__fps-option lightbox__fps-option--active"
                          : "lightbox__fps-option"
                      }
                      onClick={() => {
                        setGifFpsText(String(fps));
                        setFpsMenuOpen(false);
                      }}
                    >
                      {fps} FPS
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <span className="lightbox__divider" />
          </>
        ) : null}

        <Tooltip content={t("preview.rotate_left")} relationship="label">
          <Button
            appearance="transparent"
            className="lightbox__icon-btn"
            icon={<ArrowCounterclockwise20Regular />}
            aria-label={t("preview.rotate_left")}
            onClick={() => setRotation((r) => r - 90)}
          />
        </Tooltip>
        <Tooltip content={t("preview.rotate_right")} relationship="label">
          <Button
            appearance="transparent"
            className="lightbox__icon-btn"
            icon={<ArrowClockwise20Regular />}
            aria-label={t("preview.rotate_right")}
            onClick={() => setRotation((r) => r + 90)}
          />
        </Tooltip>
        <span className="lightbox__divider" />
        <Tooltip content={t("preview.zoom_out")} relationship="label">
          <Button
            appearance="transparent"
            className="lightbox__icon-btn"
            icon={<ZoomOut20Regular />}
            aria-label={t("preview.zoom_out")}
            onClick={() => zoomBy(1 / ZOOM_STEP)}
          />
        </Tooltip>
        <button type="button" className="lightbox__zoom-badge" onClick={resetView} title={t("preview.reset_view")}>
          {Math.round(zoom * 100)}%
        </button>
        <Tooltip content={t("preview.zoom_in")} relationship="label">
          <Button
            appearance="transparent"
            className="lightbox__icon-btn"
            icon={<ZoomIn20Regular />}
            aria-label={t("preview.zoom_in")}
            onClick={() => zoomBy(ZOOM_STEP)}
          />
        </Tooltip>
        <Tooltip content={t("preview.reset_view")} relationship="label">
          <Button
            appearance="transparent"
            className="lightbox__icon-btn"
            icon={<ArrowReset20Regular />}
            aria-label={t("preview.reset_view")}
            onClick={resetView}
          />
        </Tooltip>
        <span className="lightbox__divider" />
        <Tooltip content={hasGifStepper ? t("preview.copy_frame") : t("preview.copy_image")} relationship="label">
          <Button
            appearance="transparent"
            className="lightbox__icon-btn"
            icon={<Copy20Regular />}
            aria-label={hasGifStepper ? t("preview.copy_frame") : t("preview.copy_image")}
            onClick={() => runAsync(copyCurrent())}
          />
        </Tooltip>
        <Tooltip content={t("preview.open_folder")} relationship="label">
          <Button
            appearance="transparent"
            className="lightbox__icon-btn"
            icon={<FolderOpen20Regular />}
            aria-label={t("preview.open_folder")}
            onClick={onOpenFolder}
          />
        </Tooltip>
        <Tooltip content={t("preview.open_system")} relationship="label">
          <Button
            appearance="transparent"
            className="lightbox__icon-btn"
            icon={<Open20Regular />}
            aria-label={t("preview.open_system")}
            onClick={onOpenSystem}
          />
        </Tooltip>
      </div>

      {menu ? (
        <div
          className="lightbox__menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button type="button" role="menuitem" className="lightbox__menu-item" onClick={() => runAsync(copyCurrent())}>
            {hasGifStepper ? t("preview.copy_frame") : t("preview.copy_image")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="lightbox__menu-item"
            onClick={() => {
              onCloseMenu();
              resetView();
            }}
          >
            {t("preview.reset_view")}
          </button>
          <button type="button" role="menuitem" className="lightbox__menu-item" onClick={onOpenFolder}>
            {t("preview.open_folder")}
          </button>
          <button type="button" role="menuitem" className="lightbox__menu-item" onClick={onOpenSystem}>
            {t("preview.open_system")}
          </button>
        </div>
      ) : null}
    </>
  );
}

/** 视频预览主体：播放/暂停/停止、进度条、音量条、左右键逐帧步进、右键复制当前帧。 */
function VideoLightboxBody({ path, menu, onClose, onCloseMenu, onOpenMenu, onOpenFolder, onOpenSystem }: BodyProps) {
  const t = useTr();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const src = platform.media.url(path);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused || video.ended) runAsync(video.play());
    else video.pause();
  }, []);

  const stop = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    video.currentTime = 0;
    setCurrentTime(0);
    setPlaying(false);
  }, []);

  const stepFrame = useCallback((direction: -1 | 1) => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    const maxTime = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Number.POSITIVE_INFINITY;
    const next = Math.min(maxTime, Math.max(0, video.currentTime + direction * DEFAULT_VIDEO_FRAME_STEP));
    video.currentTime = next;
    setCurrentTime(next);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (menu) onCloseMenu();
        else onClose();
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        stepFrame(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        stepFrame(1);
      } else if (event.key === " ") {
        event.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menu, onClose, onCloseMenu, stepFrame, togglePlay]);

  const copyCurrentFrame = useCallback(async () => {
    onCloseMenu();
    const video = videoRef.current;
    if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) {
      notice("warning", t("common.warning"), t("preview.copy_failed"));
      return;
    }
    try {
      await copySourceToClipboard(video, video.videoWidth, video.videoHeight, 0);
      notice("success", t("common.success"), t("preview.copied"));
    } catch (error) {
      notice("warning", t("common.warning"), error instanceof Error ? error.message : t("preview.copy_failed"));
    }
  }, [onCloseMenu, t]);

  return (
    <>
      <div
        className="lightbox__stage"
        onContextMenu={onOpenMenu}
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <video
          ref={videoRef}
          className="lightbox__video"
          src={src}
          crossOrigin="anonymous"
          preload="auto"
          playsInline
          onClick={togglePlay}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onLoadedMetadata={(event) => {
            const v = event.currentTarget;
            if (Number.isFinite(v.duration)) setDuration(v.duration);
          }}
          onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        />
      </div>

      <div className="lightbox__toolbar lightbox__toolbar--video">
        <Tooltip content={t("preview.prev_frame")} relationship="label">
          <Button
            appearance="transparent"
            className="lightbox__icon-btn"
            icon={<Previous20Regular />}
            aria-label={t("preview.prev_frame")}
            onClick={() => stepFrame(-1)}
          />
        </Tooltip>
        <Tooltip content={playing ? t("preview.pause") : t("preview.play")} relationship="label">
          <Button
            appearance="transparent"
            className="lightbox__icon-btn"
            icon={playing ? <Pause20Regular /> : <Play20Regular />}
            aria-label={playing ? t("preview.pause") : t("preview.play")}
            onClick={togglePlay}
          />
        </Tooltip>
        <Tooltip content={t("preview.stop")} relationship="label">
          <Button
            appearance="transparent"
            className="lightbox__icon-btn"
            icon={<Stop20Regular />}
            aria-label={t("preview.stop")}
            onClick={stop}
          />
        </Tooltip>
        <Tooltip content={t("preview.next_frame")} relationship="label">
          <Button
            appearance="transparent"
            className="lightbox__icon-btn"
            icon={<Next20Regular />}
            aria-label={t("preview.next_frame")}
            onClick={() => stepFrame(1)}
          />
        </Tooltip>

        <span className="lightbox__time">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
        <input
          type="range"
          className="lightbox__seek"
          min={0}
          max={duration > 0 ? duration : 0}
          step={0.01}
          value={Math.min(currentTime, duration || 0)}
          aria-label="Seek"
          onChange={(event) => {
            const next = Number(event.target.value);
            if (videoRef.current) videoRef.current.currentTime = next;
            setCurrentTime(next);
          }}
        />

        <Tooltip content={muted ? t("preview.unmute") : t("preview.mute")} relationship="label">
          <Button
            appearance="transparent"
            className="lightbox__icon-btn"
            icon={muted || volume === 0 ? <SpeakerMute20Regular /> : <Speaker220Regular />}
            aria-label={muted ? t("preview.unmute") : t("preview.mute")}
            onClick={() => {
              const next = !muted;
              setMuted(next);
              if (videoRef.current) videoRef.current.muted = next;
            }}
          />
        </Tooltip>
        <input
          type="range"
          className="lightbox__volume"
          min={0}
          max={1}
          step={0.05}
          value={muted ? 0 : volume}
          aria-label="Volume"
          onChange={(event) => {
            const next = Number(event.target.value);
            setVolume(next);
            const isMuted = next === 0;
            setMuted(isMuted);
            if (videoRef.current) {
              videoRef.current.volume = next;
              videoRef.current.muted = isMuted;
            }
          }}
        />

        <span className="lightbox__divider" />
        <Tooltip content={t("preview.copy_frame")} relationship="label">
          <Button
            appearance="transparent"
            className="lightbox__icon-btn"
            icon={<Copy20Regular />}
            aria-label={t("preview.copy_frame")}
            onClick={() => runAsync(copyCurrentFrame())}
          />
        </Tooltip>
        <Tooltip content={t("preview.open_folder")} relationship="label">
          <Button
            appearance="transparent"
            className="lightbox__icon-btn"
            icon={<FolderOpen20Regular />}
            aria-label={t("preview.open_folder")}
            onClick={onOpenFolder}
          />
        </Tooltip>
        <Tooltip content={t("preview.open_system")} relationship="label">
          <Button
            appearance="transparent"
            className="lightbox__icon-btn"
            icon={<Open20Regular />}
            aria-label={t("preview.open_system")}
            onClick={onOpenSystem}
          />
        </Tooltip>
      </div>

      {menu ? (
        <div
          className="lightbox__menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="lightbox__menu-item"
            onClick={() => runAsync(copyCurrentFrame())}
          >
            {t("preview.copy_frame")}
          </button>
          <button type="button" role="menuitem" className="lightbox__menu-item" onClick={onOpenFolder}>
            {t("preview.open_folder")}
          </button>
          <button type="button" role="menuitem" className="lightbox__menu-item" onClick={onOpenSystem}>
            {t("preview.open_system")}
          </button>
        </div>
      ) : null}
    </>
  );
}
