/**
 * 调用原生能力返回的 Promise：失败只记日志。
 * 界面不等待这些调用，也不能让未处理的 rejection 冒到控制台顶层。
 */
export function runAsync(action: Promise<unknown>): void {
  action.catch((error: unknown) => {
    console.error(error);
  });
}
