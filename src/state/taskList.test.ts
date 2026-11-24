import { describe, expect, it, vi } from "vitest";
import type { TaskEvent, TaskScheduler, TaskSpec } from "../core/tasks";
import { MODERATION_FAILURE_REASONS, TaskList, taskStatusText, type TaskCard } from "./taskList";

/** 测试里不碰文案表：把键和参数原样拼出来，方便断言。 */
const plain = (key: string, kwargs?: Record<string, unknown>) =>
  kwargs ? `${key} ${JSON.stringify(kwargs)}` : key;

interface Started {
  spec: TaskSpec;
  emit: (event: TaskEvent) => void;
  cancelled: boolean;
}

/** 假调度器：只记下启动过的任务，事件由测试自己发。 */
function fakeScheduler() {
  const started: Started[] = [];
  const scheduler = {
    start(spec: TaskSpec, onEvent: (event: TaskEvent) => void) {
      const entry: Started = { spec, emit: onEvent, cancelled: false };
      started.push(entry);
      return { id: started.length, cancel: () => void (entry.cancelled = true), done: new Promise<void>(() => {}) };
    },
    cancelAll() {
      for (const entry of started) entry.cancelled = true;
    },
  } as unknown as TaskScheduler;
  return { scheduler, started };
}

const CAT = { prompt: "a cat", model: "nano-banana" };
const VIP_CAT = { prompt: "a cat", model: "gpt-image-2-vip" };

function setup(options: { autoRetry?: boolean; maxRetries?: number; vipModerationRetry?: boolean; spec?: TaskSpec } = {}) {
  const fake = fakeScheduler();
  const flags = { maxRetries: options.maxRetries ?? 5, vipModerationRetry: options.vipModerationRetry ?? false };
  const logs: string[] = [];
  const list = new TaskList({ scheduler: () => fake.scheduler, settings: () => flags, log: (message) => logs.push(message) });
  const create = (spec: TaskSpec = options.spec ?? CAT) =>
    list.create({ prompt: spec.prompt, spec, autoRetry: options.autoRetry ?? false });
  const top = (): TaskCard => list.getCards()[0];
  return { list, fake, flags, logs, create, top, latest: () => fake.started[fake.started.length - 1] };
}

const failed = (reason: string, failureReason: string, delivery?: "not_sent" | "unknown"): TaskEvent => ({
  type: "failed",
  reason,
  failureReason,
  delivery,
});

describe("task cards", () => {
  it("puts a new card on top, counts from 1 and starts it right away", () => {
    const h = setup();
    h.create({ ...CAT, prompt: "first" });
    h.create({ ...CAT, prompt: "second" });
    expect(h.top().index).toBe(2);
    expect(h.top().prompt).toBe("second");
    expect(h.list.getCards().map((card) => card.index)).toEqual([2, 1]);
    expect(h.fake.started.map((entry) => entry.spec.prompt)).toEqual(["first", "second"]);
    expect(h.top()).toMatchObject({ status: "starting", progress: 0, taskId: null, retries: 0, mediaType: "image" });
  });

  it("tells image and video cards apart from the model name", () => {
    const h = setup();
    h.create();
    h.create({ prompt: "a clip", model: "wan-3.0", duration: 5 });
    expect(h.list.getCards().map((card) => card.mediaType)).toEqual(["video", "image"]);
  });

  it("keeps the snapshot stable until something changes and tells subscribers", () => {
    const h = setup();
    const listener = vi.fn();
    h.list.subscribe(listener);
    const before = h.list.getCards();
    h.create();
    const after = h.list.getCards();
    expect(after).not.toBe(before);
    listener.mockClear();
    expect(h.list.getCards()).toBe(after);
    expect(listener).not.toHaveBeenCalled();
    h.latest().emit({ type: "queued" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(h.list.getCards()).not.toBe(after);
  });

  it("follows the scheduler events through the queued, submitting, submitted and running states", () => {
    const h = setup();
    h.create();
    const run = h.latest();

    expect(taskStatusText(h.top(), plain)).toBe("Attempt 1: Starting...");
    run.emit({ type: "queued" });
    expect(h.top().status).toBe("queued");
    expect(taskStatusText(h.top(), plain)).toBe('task.status_queued {"attempt":1}');
    run.emit({ type: "submitting" });
    expect(taskStatusText(h.top(), plain)).toBe('task.status_submitting {"attempt":1}');

    // 提交一回来就亮出服务端任务 id，不等第一次轮询
    run.emit({ type: "submitted", taskId: "srv-7" });
    expect(h.top()).toMatchObject({ status: "running", taskId: "srv-7", serverStatus: null, progress: 0 });
    expect(taskStatusText(h.top(), plain)).toBe('task.status_submitted {"attempt":1,"taskId":"srv-7"}');

    run.emit({ type: "progress", progress: 40, status: "running" });
    expect(h.top()).toMatchObject({ progress: 40, serverStatus: "running", taskId: "srv-7" });
    expect(taskStatusText(h.top(), plain)).toBe("Attempt 1: running");

    run.emit({ type: "succeeded", resultPath: "C:\\out\\grsai_x.png" });
    expect(h.top()).toMatchObject({ status: "succeeded", resultPath: "C:\\out\\grsai_x.png", progress: 100 });
    expect(taskStatusText(h.top(), plain)).toBe("✓ Success on 1st attempt");
  });

  it("shows a failure and does nothing else when auto retry is off", () => {
    vi.useFakeTimers();
    try {
      const h = setup();
      h.create();
      h.latest().emit(failed("Unknown: something broke", "Unknown"));
      expect(h.top()).toMatchObject({ status: "failed", error: "Unknown: something broke", failureReason: "Unknown" });
      expect(taskStatusText(h.top(), plain)).toBe("✗ Failed: Unknown: something broke");
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(5000);
      expect(h.fake.started).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries automatically one second after a failure and counts the attempt", () => {
    vi.useFakeTimers();
    try {
      const h = setup({ autoRetry: true });
      h.create();
      h.latest().emit(failed("Submission failed", "Submission failed", "not_sent"));
      expect(h.logs).toEqual(["[TaskList] Auto-retrying... (1/5)"]);
      expect(h.top().status).toBe("failed");
      vi.advanceTimersByTime(999);
      expect(h.fake.started).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(h.fake.started).toHaveLength(2);
      // 上一次尝试的句柄随之作废，免得它再吐出迟到的事件
      expect(h.fake.started[0].cancelled).toBe(true);
      expect(h.top()).toMatchObject({ status: "starting", retries: 1, taskId: null, error: null });
      expect(taskStatusText(h.top(), plain)).toBe("Attempt 2: Starting...");

      h.latest().emit({ type: "submitted", taskId: "srv-8" });
      h.latest().emit({ type: "succeeded", resultPath: null });
      expect(taskStatusText(h.top(), plain)).toBe("✓ Success on retry 1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops retrying automatically once max_retries is used up", () => {
    vi.useFakeTimers();
    try {
      const h = setup({ autoRetry: true, maxRetries: 2 });
      h.create();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        h.latest().emit(failed("boom", "Unknown"));
        vi.advanceTimersByTime(1000);
      }
      expect(h.fake.started).toHaveLength(3);
      expect(h.top().retries).toBe(2);
      h.latest().emit(failed("boom", "Unknown"));
      expect(h.top().status).toBe("failed");
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(5000);
      expect(h.fake.started).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks automatic retries for VIP models that failed moderation, unless the setting allows it", () => {
    vi.useFakeTimers();
    try {
      const h = setup({ autoRetry: true });
      h.create(VIP_CAT);
      h.latest().emit(failed("output_moderation: unsafe", "output_moderation"));
      expect(h.top()).toMatchObject({ status: "failed", autoRetryBlocked: true });
      expect(taskStatusText(h.top(), plain)).toBe(
        "✗ Failed: output_moderation: unsafe (Auto-retry blocked for VIP moderation)",
      );
      vi.advanceTimersByTime(5000);
      expect(h.fake.started).toHaveLength(1);

      // 打开 VIP 违规自动重试后照常重试
      h.flags.vipModerationRetry = true;
      h.list.retry(1);
      h.latest().emit(failed("output_moderation: unsafe", "input_moderation"));
      expect(h.top().autoRetryBlocked).toBe(false);
      expect(h.top().error).toBe("output_moderation: unsafe");
      vi.advanceTimersByTime(1000);
      expect(h.fake.started).toHaveLength(3);

      // 自动重试关着的时候不提「被拦下」，因为本来就不会重试
      const off = setup({ spec: VIP_CAT });
      off.create();
      off.latest().emit(failed("violation", "violation"));
      expect(off.top().error).toBe("violation");
      expect(off.top().autoRetryBlocked).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still retries non-VIP models automatically after a moderation failure, as the source does", () => {
    vi.useFakeTimers();
    try {
      const h = setup({ autoRetry: true });
      h.create();
      for (const reason of MODERATION_FAILURE_REASONS) {
        h.latest().emit(failed(reason, reason));
        vi.advanceTimersByTime(1000);
      }
      expect(h.fake.started).toHaveLength(4);
      expect(h.top()).toMatchObject({ retries: 3, autoRetryBlocked: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("never retries a submission whose outcome is unknown", () => {
    vi.useFakeTimers();
    try {
      const h = setup({ autoRetry: true });
      h.create();
      h.latest().emit(failed("operation timed out", "Submission failed", "unknown"));
      expect(h.top()).toMatchObject({ status: "failed", delivery: "unknown", autoRetryBlocked: false });
      expect(h.logs).toEqual([]);
      vi.advanceTimersByTime(5000);
      expect(h.fake.started).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets the user retry by hand, even past max_retries", () => {
    const h = setup({ maxRetries: 1 });
    h.create();
    h.latest().emit(failed("boom", "Unknown"));
    h.list.retry(1);
    h.list.retry(1);
    h.latest().emit({ type: "submitted", taskId: "srv-9" });
    expect(h.fake.started).toHaveLength(3);
    expect(h.top()).toMatchObject({ status: "running", retries: 2, taskId: "srv-9", error: null });
    expect(taskStatusText(h.top(), plain)).toBe('task.status_submitted {"attempt":3,"taskId":"srv-9"}');
    expect(taskStatusText({ ...h.top(), retries: 2, status: "succeeded" }, plain)).toBe("✓ Success on retry 2");
  });

  it("ignores the automatic retry when the card was already retried by hand during the wait", () => {
    vi.useFakeTimers();
    try {
      const h = setup({ autoRetry: true });
      h.create();
      h.latest().emit(failed("boom", "Unknown"));
      h.list.retry(1);
      vi.advanceTimersByTime(1000);
      expect(h.fake.started).toHaveLength(2);
      expect(h.top().retries).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("regenerates into a new card with the same parameters and the current auto retry switch", () => {
    const h = setup();
    const hooks = { onSucceeded: vi.fn(), onFailed: vi.fn() };
    const spec: TaskSpec = { ...CAT, aspectRatio: "1:1", refImageUrls: ["C:\\in\\a.png"] };
    h.list.create({ prompt: spec.prompt, spec, autoRetry: false, hooks });
    h.latest().emit({ type: "succeeded", resultPath: "C:\\out\\a.png" });
    expect(hooks.onSucceeded).toHaveBeenCalledTimes(1);

    const fresh = h.list.regenerate(1, true);
    expect(fresh).toMatchObject({ index: 2, prompt: "a cat", autoRetry: true, status: "starting", retries: 0 });
    expect(fresh?.spec).not.toBe(spec);
    expect(fresh?.spec).toEqual(spec);
    expect(h.list.getCards().map((card) => card.index)).toEqual([2, 1]);
    h.latest().emit(failed("boom", "Unknown"));
    expect(hooks.onFailed).toHaveBeenCalledTimes(1);
    expect(h.list.regenerate(99, true)).toBeNull();
  });

  it("stops following every task and drops pending automatic retries", () => {
    vi.useFakeTimers();
    try {
      const h = setup({ autoRetry: true });
      h.create({ ...CAT, prompt: "one" });
      h.create({ ...CAT, prompt: "two" });
      h.fake.started[1].emit(failed("boom", "Unknown"));
      h.list.stopAll();
      expect(h.fake.started.every((entry) => entry.cancelled)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(5000);
      expect(h.fake.started).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
