/**
 * 三个页面各自的列表。页面常驻不卸载，所以放在模块级，
 * 和源项目里挂在页面实例上是一回事。
 */
import { DEFAULT_CONFIG } from "../core/config";
import { cfg } from "./config";
import { taskScheduler } from "./services";
import { diag } from "../platform/diagnostics";
import { TaskList } from "./taskList";

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

/** 关闭窗口时停掉所有任务，没有确认，与源项目一致。 */
export function stopAllTasks(): void {
  generatorTasks.stopAll();
  videoTasks.stopAll();
  comicTasks.stopAll();
}
