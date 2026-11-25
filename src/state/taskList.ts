/**
 * 任务卡片的状态仓（对应 ui/components/task_widget.py 的 TaskWidget，
 * 以及页面里创建、重试、重新生成任务的那几步）。
 *
 * 调度器的事件在这里变成卡片状态，自动重试的判定也在这里。
 * 纯 TypeScript，不依赖 React；每个页面各建一个列表。
 */
import type { TaskEvent, TaskHandle, TaskScheduler, TaskSpec } from "../core/tasks";
import { VIP_MODELS } from "../core/modelCatalog";
import { VIDEO_MODEL_SET } from "../core/modelCatalog";
import { diag } from "../platform/diagnostics";

export type TaskMediaType = "image" | "video";

/**
 * starting 是材料备好之前；queued 和 submitting 是并发闸里排队的两个阶段；
 * running 从提交成功算起。
 */
export type TaskCardStatus = "starting" | "queued" | "submitting" | "running" | "succeeded" | "failed";

/** 提交没成功时，请求到底发出去没有。 */
export type FailureDelivery = "not_sent" | "unknown";

export interface TaskCard {
  readonly index: number;
  readonly prompt: string;
  /** 生成时的参数快照，重试和重新生成都用它。 */
  readonly spec: TaskSpec;
  readonly mediaType: TaskMediaType;
  /** 建卡片时的「失败自动重试」开关。 */
  readonly autoRetry: boolean;
  /** 建卡片时读到的最大重试次数。 */
  readonly maxRetries: number;
  /** 已经重试了几次，手动和自动都算。 */
  retries: number;
  status: TaskCardStatus;
  /** 服务端报回的状态，第一次轮询之前是 null。 */
  serverStatus: string | null;
  progress: number | null;
  /** 服务端任务 id，提交一成功就有。 */
  taskId: string | null;
  resultPath: string | null;
  /** 失败原因，给用户看的那一句，不带前缀。 */
  error: string | null;
  failureReason: string | null;
  delivery: FailureDelivery | null;
  /** 自动重试被 VIP 违规规则拦下。 */
  autoRetryBlocked: boolean;
}

/** 自动重试前等的时间，与源项目一致。 */
const AUTO_RETRY_DELAY_MS = 1000;

/** 源项目判定 VIP 违规时看的失败原因。 */
export const MODERATION_FAILURE_REASONS: ReadonlySet<string> = new Set([
  "output_moderation",
  "input_moderation",
  "violation",
]);

export interface TaskListDeps {
  scheduler(): TaskScheduler;
  /** 每次用到时才读，设置改了立刻生效。 */
  settings(): { maxRetries: number; vipModerationRetry: boolean };
  log?(message: string): void;
}

/** 单个任务结束时的回调，漫画页靠它更新分页卡片的状态。 */
export interface TaskHooks {
  onSucceeded?(card: TaskCard): void;
  onFailed?(card: TaskCard): void;
}

export interface NewTaskInput {
  prompt: string;
  spec: TaskSpec;
  /** 不给就按模型名判断。 */
  mediaType?: TaskMediaType;
  /** 页面上「失败自动重试」开关此刻的状态，对应源项目建卡片时的 auto_retry。 */
  autoRetry: boolean;
  hooks?: TaskHooks;
}

export interface AttachTaskInput {
  taskId: string;
  prompt: string;
  spec: TaskSpec;
  mediaType?: TaskMediaType;
  progress?: number;
  serverStatus?: string | null;
  hooks?: TaskHooks;
}

type FailedEvent = Extract<TaskEvent, { type: "failed" }>;

const isVipRestricted = (card: TaskCard, failureReason: string | null, vipModerationRetry: boolean): boolean =>
  VIP_MODELS.includes(card.spec.model) &&
  failureReason !== null &&
  MODERATION_FAILURE_REASONS.has(failureReason) &&
  !vipModerationRetry;

/**
 * 卡片上显示的状态文字。
 * 源项目里写死英文的那几句照旧保持英文，重写版新增的状态才走文案表。
 */
export function taskStatusText(
  card: TaskCard,
  translate: (key: string, kwargs?: Record<string, unknown>) => string,
): string {
  const attempt = card.retries + 1;
  switch (card.status) {
    case "starting":
      return `Attempt ${attempt}: Starting...`;
    case "queued":
      return translate("task.status_queued", { attempt });
    case "submitting":
      return translate("task.status_submitting", { attempt });
    case "running":
      // 提交成功后先把服务端任务 id 亮出来，等第一次轮询回来再换成服务端状态
      if (card.serverStatus === null) {
        return translate("task.status_submitted", { attempt, taskId: card.taskId ?? "" });
      }
      return `Attempt ${attempt}: ${card.serverStatus}`;
    case "succeeded":
      return card.retries === 0 ? "✓ Success on 1st attempt" : `✓ Success on retry ${card.retries}`;
    case "failed":
      return `✗ Failed: ${card.error ?? ""}${card.autoRetryBlocked ? " (Auto-retry blocked for VIP moderation)" : ""}`;
  }
}

export class TaskList {
  private counter = 0;
  private cards: TaskCard[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly handles = new Map<number, TaskHandle>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly hooks = new Map<number, TaskHooks>();
  private readonly deps: TaskListDeps;

  constructor(deps: TaskListDeps) {
    this.deps = deps;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** 新任务排在最上。返回的数组在状态变化前一直是同一个引用。 */
  getCards = (): TaskCard[] => this.cards;

  /** 对应页面的 create_task：建卡片、放到最上面、立刻启动。 */
  create(input: NewTaskInput): TaskCard {
    this.counter += 1;
    const card: TaskCard = {
      index: this.counter,
      prompt: input.prompt,
      spec: input.spec,
      mediaType: input.mediaType ?? (VIDEO_MODEL_SET.has(input.spec.model) ? "video" : "image"),
      autoRetry: input.autoRetry,
      maxRetries: this.deps.settings().maxRetries,
      retries: 0,
      status: "starting",
      serverStatus: null,
      progress: 0,
      taskId: null,
      resultPath: null,
      error: null,
      failureReason: null,
      delivery: null,
      autoRetryBlocked: false,
    };
    if (input.hooks) this.hooks.set(card.index, input.hooks);
    this.cards = [card, ...this.cards];
    this.start(card);
    return this.cards[0] ?? card;
  }

  /** 接续一个已在服务端运行的历史任务：不重新提交，直接以 running 状态挂载轮询；关闭自动重试以免误触发二次扣费。 */
  attach(input: AttachTaskInput): TaskCard {
    const existing = this.cards.find(
      (card) =>
        card.taskId === input.taskId &&
        (card.status === "starting" ||
          card.status === "queued" ||
          card.status === "submitting" ||
          card.status === "running"),
    );
    if (existing) return existing;

    this.counter += 1;
    const card: TaskCard = {
      index: this.counter,
      prompt: input.prompt,
      spec: input.spec,
      mediaType: input.mediaType ?? (VIDEO_MODEL_SET.has(input.spec.model) ? "video" : "image"),
      autoRetry: false,
      maxRetries: this.deps.settings().maxRetries,
      retries: 0,
      status: "running",
      serverStatus: input.serverStatus ?? "running",
      progress: input.progress ?? 0,
      taskId: input.taskId,
      resultPath: null,
      error: null,
      failureReason: null,
      delivery: null,
      autoRetryBlocked: false,
    };
    if (input.hooks) this.hooks.set(card.index, input.hooks);
    this.cards = [card, ...this.cards];
    this.notify();
    const handle = this.deps.scheduler().resume(input.taskId, card.spec, (event) => this.onEvent(card.index, event));
    this.handles.set(card.index, handle);
    void handle.done.then(() => {
      if (this.handles.get(card.index) === handle) this.handles.delete(card.index);
    });
    return this.cards[0] ?? card;
  }

  /** 指定服务端 taskId 是否正被本列表活跃跟踪中。 */
  hasActiveTaskId(taskId: string): boolean {
    return this.cards.some(
      (card) =>
        card.taskId === taskId &&
        (card.status === "starting" ||
          card.status === "queued" ||
          card.status === "submitting" ||
          card.status === "running"),
    );
  }

  /** 手动重试：换一个新的服务端任务，重试次数加一。次数用完了也照样能手动重试。 */
  retry(index: number): void {
    const card = this.cards.find((item) => item.index === index);
    if (card) this.start({ ...card, retries: card.retries + 1 });
  }

  /** 重新生成：按当时的参数另建一张新卡片，自动重试开关取此刻页面上的。 */
  regenerate(index: number, autoRetry: boolean): TaskCard | null {
    const card = this.cards.find((item) => item.index === index);
    if (!card) return null;
    return this.create({
      prompt: card.prompt,
      spec: { ...card.spec },
      mediaType: card.mediaType,
      autoRetry,
      hooks: this.hooks.get(index),
    });
  }

  /** 停止跟进所有任务。已经提交到服务端的任务不受影响，与源项目一致。 */
  stopAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.deps.scheduler().cancelAll();
    this.handles.clear();
  }

  /** 是否还有没做完的任务：启动中、排队中、提交中、运行中，或者失败后正等着自动重试。 */
  hasUnfinished(): boolean {
    if (this.timers.size > 0) return true;
    return this.cards.some(
      (card) =>
        card.status === "starting" ||
        card.status === "queued" ||
        card.status === "submitting" ||
        card.status === "running",
    );
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private update(index: number, patch: Partial<TaskCard>): TaskCard | null {
    const card = this.cards.find((item) => item.index === index);
    if (!card) return null;
    const next = { ...card, ...patch };
    this.replace(next);
    return next;
  }

  private replace(card: TaskCard): void {
    this.cards = this.cards.map((item) => (item.index === card.index ? card : item));
    this.notify();
  }

  private start(card: TaskCard): void {
    const timer = this.timers.get(card.index);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(card.index);
    }
    this.handles.get(card.index)?.cancel();
    const reset: TaskCard = {
      ...card,
      status: "starting",
      serverStatus: null,
      progress: 0,
      taskId: null,
      error: null,
      failureReason: null,
      delivery: null,
      autoRetryBlocked: false,
    };
    this.replace(reset);
    const handle = this.deps.scheduler().start(reset.spec, (event) => this.onEvent(card.index, event));
    this.handles.set(card.index, handle);
    void handle.done.then(() => {
      if (this.handles.get(card.index) === handle) this.handles.delete(card.index);
    });
  }

  private onEvent(index: number, event: TaskEvent): void {
    switch (event.type) {
      case "queued":
        this.update(index, { status: "queued" });
        break;
      case "submitting":
        this.update(index, { status: "submitting" });
        break;
      case "submitted":
        diag(`task ${index} submitted: server id ${event.taskId}`);
        this.update(index, { status: "running", taskId: event.taskId, serverStatus: null, progress: 0 });
        break;
      case "progress":
        this.update(index, { status: "running", progress: event.progress, serverStatus: event.status });
        break;
      case "succeeded": {
        diag(`task ${index} succeeded: ${event.resultPath ?? "(no file)"}`);
        const card = this.update(index, { status: "succeeded", resultPath: event.resultPath, progress: 100 });
        if (card) this.hooks.get(index)?.onSucceeded?.(card);
        break;
      }
      case "failed":
        diag(`task ${index} failed (${event.failureReason}${event.delivery ? `, ${event.delivery}` : ""}): ${event.reason}`);
        this.fail(index, event);
        break;
    }
  }

  /** 与源项目的 _can_auto_retry 一致，另加一条：已发出但结果不明的提交不自动重试。 */
  private canAutoRetry(card: TaskCard, failureReason: string | null, delivery: FailureDelivery | undefined): boolean {
    if (!card.autoRetry) return false;
    if (card.retries >= card.maxRetries) return false;
    // 服务端可能已经建了任务，再提一个会留下孤儿任务
    if (delivery === "unknown") return false;
    return !isVipRestricted(card, failureReason, this.deps.settings().vipModerationRetry);
  }

  private fail(index: number, event: FailedEvent): void {
    const card = this.cards.find((item) => item.index === index);
    if (!card) return;
    const blocked = card.autoRetry && isVipRestricted(card, event.failureReason, this.deps.settings().vipModerationRetry);
    const failed = this.update(index, {
      status: "failed",
      error: event.reason,
      failureReason: event.failureReason,
      delivery: event.delivery ?? null,
      autoRetryBlocked: blocked,
    });
    if (failed) this.hooks.get(index)?.onFailed?.(failed);
    if (this.canAutoRetry(card, event.failureReason, event.delivery)) {
      this.deps.log?.(`[TaskList] Auto-retrying... (${card.retries + 1}/${card.maxRetries})`);
      this.timers.set(
        index,
        setTimeout(() => this.performAutoRetry(index), AUTO_RETRY_DELAY_MS),
      );
    }
  }

  private performAutoRetry(index: number): void {
    this.timers.delete(index);
    // 这一秒里要是已经被手动重试过，就不再重复提交
    const card = this.cards.find((item) => item.index === index);
    if (!card || card.status !== "failed") return;
    this.start({ ...card, retries: card.retries + 1 });
  }
}
