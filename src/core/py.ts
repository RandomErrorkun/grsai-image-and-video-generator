/**
 * 复刻几处 Python 语义的小工具。源项目的行为建立在它们之上：
 * str() 和 int() 对异常输入的取舍、本地时间的格式、按字节算的 base64。
 */

function pyNumber(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (value === Infinity) return "inf";
  if (value === -Infinity) return "-inf";
  // Python 对绝对值不小于 1e16 的整数浮点用科学计数法，指数至少两位
  if (Number.isInteger(value) && Math.abs(value) >= 1e16) {
    return value.toExponential().replace(/e([+-])(\d)$/, "e$10$2");
  }
  return String(value);
}

/** Python 的 repr()，用于容器里的字符串和键。 */
function pyRepr(value: unknown): string {
  if (typeof value === "string") {
    const escaped = value
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
    return `'${escaped}'`;
  }
  return pyStr(value);
}

/** Python 的 str()：None 是 "None"，布尔是 True 和 False，容器是 Python 风格的字面量。 */
export function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "string") return value;
  if (typeof value === "number") return pyNumber(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return `{${entries.map(([key, item]) => `${pyRepr(key)}: ${pyRepr(item)}`).join(", ")}}`;
  }
  return String(value);
}

/**
 * Python 的 int()：小数向零截断，整数字符串也认。
 * 其余情况（None、非数字文本、NaN）返回 null，对应抛 TypeError 或 ValueError。
 */
export function pyInt(value: unknown): number | null {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === "string") {
    // Python 的 int() 认全角数字等 Unicode 十进制数字，折成 ASCII 再判断
    const text = value.trim().normalize("NFKC");
    return /^[+-]?\d+$/.test(text) ? Number(text) : null;
  }
  return null;
}

/** Python 的 str.splitlines()，换行边界比 JS 的 split("\n") 多。 */
export function pySplitLines(text: string): string[] {
  return text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\u0085\u2028\u2029]/);
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/** 本地时间，格式 %Y-%m-%d %H:%M:%S，历史库里的时间都用它。 */
export function formatLocalTime(date: Date): string {
  return (
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** 本地时间，格式 %Y-%m-%d-%H-%M-%S，结果文件名用它。 */
export function formatFileTime(date: Date): string {
  return (
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-` +
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

/** 字节转 base64。按块处理，几十 MB 的音视频也不会爆参数个数上限。 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK_SIZE = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK_SIZE));
  }
  return btoa(binary);
}
