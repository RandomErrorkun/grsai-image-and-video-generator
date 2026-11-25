/**
 * 三个页面各自的列表。页面常驻不卸载，所以放在模块级，
 * 和源项目里挂在页面实例上是一回事。
 */
import { DEFAULT_CONFIG } from "../core/config";
import type { HistoryTask } from "../core/history";
import { VIDEO_MODEL_SET } from "../core/modelCatalog";
import type { TaskSpec } from "../core/tasks";
import { cfg } from "./config";
import { taskScheduler } from "./services";
import { diag } from "../platform/diagnostics";
import { TaskList, type TaskCard, type TaskHooks } from "./taskList";

const settings = () => ({
  maxRetries: Number(cfg.get("max_retries", DEFAULT_CONFIG.max_retries)),
  vipModerationRetry: Boolean(cfg.get("vip_moderation_auto_retry", DEFAULT_CONFIG.vip_moderation_auto_retry)),
});

const create = () =>
  new TaskList({
    scheduler: taskScheduler,
    settings,
    log: diag,
  });

export const generatorTasks = create();
export const videoTasks = create();
export const comicTasks = create();

/** 任何一个任务列表里是否还有没做完的任务。 */
export function hasUnfinishedTasks(): boolean {
  return generatorTasks.hasUnfinished() || videoTasks.hasUnfinished() || comicTasks.hasUnfinished();
}

/** 指定的服务端 taskId 是否正被任意任务列表跟踪轮询中。 */
export function isTaskIdActive(taskId: string): boolean {
  return (
    generatorTasks.hasActiveTaskId(taskId) ||
    videoTasks.hasActiveTaskId(taskId) ||
    comicTasks.hasActiveTaskId(taskId)
  );
}

/** 把仍在服务端运行的历史任务接续到对应的任务列表（视频模型进视频页，其余进图像页）。已在跟踪中时返回 null。 */
export function resumeHistoryTask(
  task: HistoryTask,
  spec: TaskSpec,
  progress: number,
  serverStatus: string,
  hooks?: TaskHooks,
): TaskCard | null {
  if (isTaskIdActive(task.id)) return null;
  const target = VIDEO_MODEL_SET.has(task.model) ? videoTasks : generatorTasks;
  return target.attach({
    taskId: task.id,
    prompt: task.prompt,
    spec,
    mediaType: VIDEO_MODEL_SET.has(task.model) ? "video" : "image",
    progress,
    serverStatus,
    hooks,
  });
}

/** 停掉所有任务。 */
export function stopAllTasks(): void {
  generatorTasks.stopAll();
  videoTasks.stopAll();
  comicTasks.stopAll();
}
