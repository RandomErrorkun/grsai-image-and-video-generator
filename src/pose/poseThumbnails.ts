/**
 * 29 个内置「常用姿势」的 WebP 缩略图映射（由 Vite 打包进单文件产物）。
 */
const modules = import.meta.glob("../assets/pose-thumbs/*.webp", {
  eager: true,
  import: "default",
}) as Record<string, string>;

export const COMMON_POSE_THUMBNAILS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(modules).map(([path, url]) => {
    const match = /([^/\\]+)\.webp$/i.exec(path);
    return [match ? match[1] : path, url];
  }),
);
