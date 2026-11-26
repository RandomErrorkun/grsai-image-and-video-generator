/**
 * 内存里的文件系统，给浏览器 mock 用：单独跑 npm run dev 调界面时不需要 Tauri。
 *
 * 路径一律按 dataDir 规整成绝对路径，分隔符沿用 Windows 的反斜杠，
 * 这样界面上看到的路径和真环境是一个样子。
 */
import type { PathTools } from "../core/paths";
import type { FileSystemApi } from "./types";

export function createMemoryFs(paths: PathTools, root: string): FileSystemApi {
  const files = new Map<string, Uint8Array>();
  const directories = new Set<string>([paths.absolute(root, root)]);
  const key = (path: string) => paths.absolute(path, root);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });

  async function makeDirs(path: string): Promise<void> {
    let current = key(path);
    const missing: string[] = [];
    while (!directories.has(current)) {
      missing.push(current);
      const parent = paths.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    for (const dir of missing.reverse()) directories.add(dir);
  }

  async function read(path: string): Promise<Uint8Array> {
    const bytes = files.get(key(path));
    if (!bytes) throw new Error(`no such file or directory: '${key(path)}'`);
    return bytes;
  }

  async function write(path: string, bytes: Uint8Array): Promise<void> {
    await makeDirs(paths.dirname(path));
    files.set(key(path), bytes);
  }

  async function readDir(path: string): Promise<string[]> {
    const dir = key(path);
    if (!directories.has(dir)) throw new Error(`not a directory: '${dir}'`);
    const prefix = dir.endsWith("\\") ? dir : `${dir}\\`;
    const names = new Set<string>();
    const directChildren = (candidate: string) =>
      candidate.startsWith(prefix) && candidate.slice(prefix.length).includes("\\") === false;
    for (const file of files.keys()) if (directChildren(file)) names.add(paths.basename(file));
    for (const child of directories) if (child !== dir && directChildren(child)) names.add(paths.basename(child));
    return [...names].sort();
  }

  async function copyFile(source: string, dest: string): Promise<void> {
    await write(dest, await read(source));
  }

  async function rename(from: string, to: string): Promise<void> {
    const bytes = await read(from);
    await write(to, bytes);
    files.delete(key(from));
  }

  async function replaceWithBackup(path: string, backup: string): Promise<void> {
    if (files.has(key(backup))) files.delete(key(backup));
    await rename(path, backup);
  }

  return {
    async exists(path) {
      return files.has(key(path)) || directories.has(key(path));
    },
    async isFile(path) {
      return files.has(key(path));
    },
    async isDir(path) {
      return directories.has(key(path));
    },
    makeDirs,
    readDir,
    async readText(path) {
      return decoder.decode(await read(path));
    },
    async writeText(path, text) {
      await write(path, encoder.encode(text));
    },
    read,
    write,
    copyFile,
    rename,
    async remove(path) {
      const target = key(path);
      files.delete(target);
      for (const file of files.keys()) if (file.startsWith(`${target}\\`)) files.delete(file);
      for (const dir of directories) if (dir.startsWith(`${target}\\`)) directories.delete(dir);
      directories.delete(target);
    },
    replaceWithBackup,
    async fileSize(path) {
      return (await read(path)).byteLength;
    },
    async sha256(path) {
      const bytes = await read(path);
      const copy = new Uint8Array(bytes);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copy));
      return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    },
  };
}
