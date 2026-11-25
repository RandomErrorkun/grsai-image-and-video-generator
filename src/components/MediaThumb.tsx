/**
 * 缩略图：普通图片直接显示；gif 只显示第一帧，不动；视频显示第一帧。
 *
 * 解码都交给网页自己，本软件不另算缩略图：gif 的第一帧是把图片画到画布上取的，
 * 画的是动图的默认帧；视频靠地址末尾的时间片段停在开头。
 * 调用方负责先放行路径（platform.media.allow）。
 */
import { useEffect, useRef, useState } from "react";
import { Image20Regular, Video20Regular } from "@fluentui/react-icons";
import { platform } from "../platform";
import "./MediaThumb.css";

interface MediaThumbProps {
  path: string;
  className?: string;
  alt?: string;
  /** 文件读不出来或解不了码。 */
  onBroken?: () => void;
}

const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "m4v", "mkv"]);

/** 画布最长边压到这个尺寸以内，省得大图占内存。 */
const MAX_CANVAS_EDGE = 256;

const extensionOf = (path: string): string => platform.paths.splitExt(path)[1].replace(/^\./, "").toLowerCase();

export function isAnimatedImage(path: string): boolean {
  return extensionOf(path) === "gif";
}

export function isVideoFile(path: string): boolean {
  return VIDEO_EXTENSIONS.has(extensionOf(path));
}

export function MediaThumb({ path, className, alt = "", onBroken }: MediaThumbProps) {
  const [broken, setBroken] = useState(false);
  const url = platform.media.url(path);

  useEffect(() => {
    // 换了文件就把上一张的出错状态清掉
    setBroken(false);
  }, [path]);

  if (broken) {
    return isVideoFile(path) ? (
      <Video20Regular className={className ? `media-thumb-fallback ${className}` : "media-thumb-fallback"} aria-label={alt} />
    ) : (
      <Image20Regular className={className ? `media-thumb-fallback ${className}` : "media-thumb-fallback"} aria-label={alt} />
    );
  }
  if (isAnimatedImage(path)) return <FirstFrame src={url} className={className} alt={alt} onBroken={() => { setBroken(true); onBroken?.(); }} />;
  if (isVideoFile(path)) {
    return (
      <video
        className={className ? `media-thumb ${className}` : "media-thumb"}
        src={`${url}#t=0.001`}
        preload="metadata"
        muted
        playsInline
        aria-label={alt}
        onError={() => {
          setBroken(true);
          onBroken?.();
        }}
      />
    );
  }
  return (
    <img
      className={className ? `media-thumb ${className}` : "media-thumb"}
      src={url}
      alt={alt}
      draggable={false}
      decoding="async"
      onError={() => {
        setBroken(true);
        onBroken?.();
      }}
    />
  );
}

interface FirstFrameProps {
  src: string;
  className?: string;
  alt: string;
  onBroken: () => void;
}

/** 把动图画到画布上。画的是动图的默认帧，也就是第一帧。 */
function FirstFrame({ src, className, alt, onBroken }: FirstFrameProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      const canvas = canvasRef.current;
      if (cancelled || !canvas) return;
      const scale = Math.min(1, MAX_CANVAS_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) {
        onBroken();
        return;
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
    };
    image.onerror = () => {
      if (!cancelled) onBroken();
    };
    image.src = src;
    return () => {
      cancelled = true;
    };
  }, [src]);

  return <canvas ref={canvasRef} className={className ? `media-thumb ${className}` : "media-thumb"} role="img" aria-label={alt} />;
}
