/**
 * 开发版的诊断日志，给实机测试用：收集脚本把带 [diag] 的行写进日志文件，事后据此核对每一步。
 * 只在开发版输出，正式包里这一段整个被剔除。
 * 这里只打路径、状态码、任务号这类事实；不打配置内容、API key、请求头和请求体。
 */
export function diag(message: string): void {
  if (import.meta.env.DEV) console.info(`[diag] ${message}`);
}

/** 把一次 HTTP 调用的下场写成一行：标签、结果类型和状态码，不带地址里的查询串和响应内容。 */
export function diagOutcome(label: string, outcome: { outcome: string; status?: number | null; message?: string }): string {
  const detail = outcome.outcome === "responded" ? `status ${outcome.status}` : outcome.message ?? "";
  return `${label}: ${outcome.outcome} ${detail}`.trim();
}
