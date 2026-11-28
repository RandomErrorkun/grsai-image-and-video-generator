/**
 * 3D 姿势工坊向「图像生成」与「视频生成」页面发送参考图与预制提示词块的跨页事件总线。
 */

export type PoseTransferTarget = "generator" | "video";

export interface PoseTransferPayload {
  target: PoseTransferTarget;
  /** 本次导出的本地 PNG 参考图绝对路径列表（1 ~ 4 张）。 */
  imagePaths: string[];
  /** 可选的预制 Markdown 身份锚定提示词块；为空时不修改目标页提示词。 */
  promptBlock?: string;
}

type Listener = (payload: PoseTransferPayload) => void;

const listeners = new Set<Listener>();

export function sendPoseToPage(payload: PoseTransferPayload): void {
  for (const listener of [...listeners]) {
    listener(payload);
  }
}

export function subscribePoseTransfer(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
