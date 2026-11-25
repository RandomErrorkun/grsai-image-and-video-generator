/**
 * 历史页的取值、钳制和文案拼接（对应 ui/history_page.py）。
 * 不依赖 React 和平台层，可以直接单测。
 */
import { DEFAULT_CONFIG } from "../core/config";
import type { HistoryTask } from "../core/history";
import { pyStr } from "../core/py";

/** 结果文件的扩展名是这些之一就是视频任务。 */
const VIDEO_EXTENSIONS = [".mp4", ".webm", ".mov", ".avi", ".mkv"];

export function isVideoResult(path: string | null): boolean {
  if (path === null) return false;
  const lower = path.toLowerCase();
  return VIDEO_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export type StatusTone = "success" | "failed" | "other";

/** 状态配色：成功绿，失败和违规红，其余（运行中等）橙。 */
export function statusTone(status: string): StatusTone {
  if (status === "succeeded") return "success";
  return status === "failed" || status === "violation" ? "failed" : "other";
}

/** 对应 str.capitalize()：首字母大写，其余小写。 */
export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

/**
 * 每页数量。设置页限定 1 到 100，这里兜的是手改配置文件的情况：
 * 数字与 getTasksPage 的钳制一致（向零取整、最少 1），不是数字就用默认值。
 */
export function pageSizeOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_CONFIG.history_items_per_page;
  return Math.max(1, Math.trunc(value));
}

/** 总页数，至少 1。 */
export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** 页码夹在 1 到 pages 之间。 */
export function clampPage(page: number, pages: number): number {
  return Math.min(Math.max(page, 1), pages);
}

/** 结果还在才有缩略图和「打开文件夹」：只看状态和有没有路径，文件在不在另外再查。 */
export function hasResult(task: HistoryTask): boolean {
  return task.status === "succeeded" && Boolean(task.result_path);
}

/** 卡片第二行。与源项目一样写死英文；视频任务再带时长。 */
export function modelLine(task: HistoryTask): string {
  const line = `Model: ${pyStr(task.model)} | Size: ${pyStr(task.image_size)}`;
  const duration = task.duration;
  if (typeof duration === "number" && duration > 0) return `${line} | ${Math.trunc(duration)}s`;
  return line;
}

/** 详情里的时长和种子：有值才列出来，对应源项目的 `not in (None, "")`。 */
export function hasDetailValue(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "";
}

const ERROR_PREVIEW_LENGTH = 500;

export interface ErrorPreview {
  text: string;
  truncated: boolean;
}

/** 详情里的错误信息。没有内容返回 null（对应源项目的 `if error_msg`），超过 500 字符只留前 500 个。 */
export function errorPreview(message: string | null): ErrorPreview | null {
  if (!message) return null;
  return message.length > ERROR_PREVIEW_LENGTH
    ? { text: message.slice(0, ERROR_PREVIEW_LENGTH), truncated: true }
    : { text: message, truncated: false };
}

export type ClearKind = "running" | "failed" | "violation" | "all";

export interface ClearAction {
  /** 按钮和确认框共用这个标题。 */
  titleKey: string;
  confirmKey: string;
  /** 清空全部要再确认一次。 */
  secondConfirmKey?: string;
}

export const CLEAR_ACTIONS: Readonly<Record<ClearKind, ClearAction>> = {
  running: { titleKey: "history.clear_running", confirmKey: "history.clear_running_confirm" },
  failed: { titleKey: "history.clear_failed", confirmKey: "history.clear_failed_confirm" },
  violation: { titleKey: "history.clear_violation", confirmKey: "history.clear_violation_confirm" },
  all: {
    titleKey: "history.clear_all",
    confirmKey: "history.clear_all_confirm",
    secondConfirmKey: "history.clear_all_second_confirm",
  },
};

/** 工具栏上四个清理按钮的顺序。 */
export const CLEAR_ORDER: readonly ClearKind[] = ["running", "failed", "violation", "all"];

/** 第 round 轮（从 1 起）确认要显示的文案键。 */
export function confirmTextKey(action: ClearAction, round: number): string {
  return round >= 2 && action.secondConfirmKey ? action.secondConfirmKey : action.confirmKey;
}
