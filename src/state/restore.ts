/**
 * 历史页「重新生成」的路由（对应 ui/main_window.py 的 regenerate_task）。
 *
 * 历史页只管发请求，外壳负责切到目标页面，目标页面监听同一个请求把参数填回表单。
 * 只回填，不自动提交，与源项目一致。
 */
import { VIDEO_MODEL_SET } from "../core/modelCatalog";
import type { HistoryTask } from "../core/history";

export interface RestoreRequest {
  page: "generator" | "video";
  task: HistoryTask;
}

type Listener = (request: RestoreRequest) => void;

const listeners = new Set<Listener>();

/** 视频模型回视频页，其余回生成页。判定在旧模型名换算之前，和源项目同一个顺序。 */
export function requestRestore(task: HistoryTask): void {
  const page: RestoreRequest["page"] = VIDEO_MODEL_SET.has(task.model) ? "video" : "generator";
  for (const listener of [...listeners]) listener({ page, task });
}

export function subscribeRestore(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
