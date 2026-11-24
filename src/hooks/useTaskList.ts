import { useSyncExternalStore } from "react";
import type { TaskCard, TaskList } from "../state/taskList";

/** 订阅一个任务列表；卡片状态一变组件就重渲染。 */
export function useTaskCards(list: TaskList): TaskCard[] {
  return useSyncExternalStore(list.subscribe, list.getCards, list.getCards);
}
