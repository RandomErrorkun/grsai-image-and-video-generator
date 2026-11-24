/**
 * 路径工具，语义对齐 Python 的 os.path（Windows 上是 ntpath）。
 * 历史记录和项目文件里存的是本地路径，拼接、相对化、取扩展名的方式要和源项目一致。
 */

export interface PathTools {
  /** 逐段拼接；后面出现绝对路径时丢弃前面的部分。不规整 .. 和 .。 */
  join(...parts: string[]): string;
  /** 补成绝对路径并规整：合并分隔符、消掉 . 和 ..，不解析符号链接。相对路径按 base 解析。 */
  absolute(path: string, base: string): string;
  /** to 相对于 from 的路径，两边都按 absolute 规整。不在同一个盘上时抛错。 */
  relative(from: string, to: string, base?: string): string;
  /** [主体, 扩展名]，扩展名带点；没有扩展名时第二项是空串。 */
  splitExt(path: string): [string, string];
  /** 最后一段。 */
  basename(path: string): string;
  /** 去掉最后一段；已经到根时返回根。 */
  dirname(path: string): string;
  /** 是不是绝对路径：带盘符，或者以分隔符开头。 */
  isAbsolute(path: string): boolean;
}

const WINDOWS_DRIVE = /^[a-zA-Z]:/;

/** 把路径拆成 [盘符, 各段]；分隔符和空段都丢掉。 */
function splitPath(path: string): [string, string[], boolean] {
  const drive = path.match(WINDOWS_DRIVE)?.[0] ?? "";
  const rest = path.slice(drive.length);
  const rooted = rest.startsWith("/") || rest.startsWith("\\");
  const segments = rest.split(/[\\/]+/).filter((segment) => segment !== "");
  return [drive.toUpperCase(), segments, rooted];
}

function lastSeparator(path: string): number {
  return Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
}

/** 消掉 . 和 ..：.. 弹出上一段；弹不了时，有盘符或以根开头就丢掉，否则保留。 */
function normalizeSegments(segments: string[], anchored: boolean): string[] {
  const result: string[] = [];
  for (const segment of segments) {
    if (segment === ".") continue;
    if (segment === "..") {
      const previous = result[result.length - 1];
      if (previous !== undefined && previous !== "..") result.pop();
      else if (!anchored) result.push("..");
      continue;
    }
    result.push(segment);
  }
  return result;
}

export function createPathTools(sep: "\\" | "/"): PathTools {
  const isAbsolute = (path: string) => WINDOWS_DRIVE.test(path) || path.startsWith("/") || path.startsWith("\\");

  function absolute(path: string, base: string): string {
    const combined = isAbsolute(path) ? path : join(base, path);
    const [drive, segments, rooted] = splitPath(combined);
    const normalized = normalizeSegments(segments, drive !== "" || rooted);
    const body = normalized.join(sep);
    return `${drive}${rooted ? sep : ""}${body}`;
  }

  function join(...parts: string[]): string {
    const nonEmpty = parts.filter((part) => part !== "");
    if (nonEmpty.length === 0) return "";
    let result = nonEmpty[0];
    for (const part of nonEmpty.slice(1)) {
      if (isAbsolute(part)) result = part;
      else if (/[\\/]$/.test(result)) result += part;
      else result += `${sep}${part}`;
    }
    return result;
  }

  return {
    join,
    absolute,

    relative(from, to, base = ".") {
      const fromAbs = absolute(from, base);
      const toAbs = absolute(to, base);
      const [fromDrive, fromSegments] = splitPath(fromAbs);
      const [toDrive, toSegments] = splitPath(toAbs);
      if (fromDrive !== toDrive) {
        const mountOf = (drive: string) => drive || sep;
        throw new PathValueError(
          `path is on mount '${mountOf(toDrive)}', start on mount '${mountOf(fromDrive)}'`,
        );
      }
      let common = 0;
      while (
        common < fromSegments.length &&
        common < toSegments.length &&
        fromSegments[common] === toSegments[common]
      ) {
        common += 1;
      }
      const steps = [
        ...fromSegments.slice(common).map(() => ".."),
        ...toSegments.slice(common),
      ];
      return steps.length === 0 ? "." : steps.join(sep);
    },

    splitExt(path) {
      const index = path.lastIndexOf(".");
      // 点前面什么都没有，或者点属于目录名（.hidden、dir.d\file）时，不算扩展名
      if (index <= lastSeparator(path) + 1) return [path, ""];
      return [path.slice(0, index), path.slice(index)];
    },

    basename(path) {
      // 与 ntpath.basename 一致：以分隔符结尾的路径取不到文件名，结果是空串
      const cut = lastSeparator(path);
      return cut >= 0 ? path.slice(cut + 1) : path;
    },

    dirname(path) {
      const trimmed = path.replace(/[\\/]+$/, "");
      const cut = lastSeparator(trimmed);
      if (cut < 0) return WINDOWS_DRIVE.test(trimmed) ? `${trimmed.slice(0, 2)}${sep}` : ".";
      const head = trimmed.slice(0, cut);
      if (head === "") return trimmed.startsWith("\\") ? "\\" : "/";
      if (/^[a-zA-Z]:$/.test(head)) return `${head}${sep}`;
      return head;
    },

    isAbsolute,
  };
}

/** 对应 Python 的 ValueError：路径在另一个盘上。 */
export class PathValueError extends Error {}
