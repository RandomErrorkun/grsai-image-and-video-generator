import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HttpOutcome, HttpRequest } from "../core/api";
import { createHistoryStore, type HistoryTask } from "../core/history";
import { createPathTools } from "../core/paths";
import { TaskScheduler, deterministicResultStem } from "../core/tasks";
import { createMemoryFs } from "../platform/memoryFs";
import { nodeSqliteExecutor } from "../testing/nodeSqlite";
import { createHistoryRefetcher } from "./historyRefetch";
import { TaskList } from "./taskList";
import { verifyHistoryResultFile } from "./thumbnail";

const paths = createPathTools("\\");
const DATA_DIR = "C:\\data";
const OUTPUT = `${DATA_DIR}\\output`;

function responded(status: number, body: unknown): HttpOutcome {
  return { outcome: "responded", status, body: typeof body === "string" ? body : JSON.stringify(body) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("history refetch & multi-restart resume", () => {
  let workDir = "";
  const closers: Array<() => void> = [];

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "grsai-refetch-test-"));
  });

  afterAll(async () => {
    for (const close of closers) {
      try {
        close();
      } catch {
        // ignore
      }
    }
    await rm(workDir, { recursive: true, force: true });
  });

  async function setup(dbName: string) {
    const dbPath = join(workDir, dbName);
    const executor = nodeSqliteExecutor(dbPath);
    closers.push(() => executor.close());
    const fs = createMemoryFs(paths, DATA_DIR);
    const history = createHistoryStore({
      db: executor,
      dataDir: DATA_DIR,
      join: paths.join,
      files: {
        exists: (p) => fs.exists(p),
        readText: (p) => fs.readText(p),
        replaceWithBackup: (a, b) => fs.replaceWithBackup(a, b),
      },
      now: () => new Date(2026, 10, 26, 2, 0, 0),
    });
    await history.ensureSchema();

    const queryCalls: string[] = [];
    const downloadCalls: Array<{ url: string; destPath: string }> = [];
    let queryHandler: (taskId: string, request: HttpRequest) => Promise<HttpOutcome> = async (id) =>
      responded(404, { error: `not found: ${id}` });
    let downloadHandler: (url: string, destPath: string) => Promise<HttpOutcome> = async (_url, destPath) => {
      await fs.makeDirs(paths.dirname(destPath));
      await fs.write(destPath, new Uint8Array([1, 2, 3, 4]));
      return responded(200, "");
    };

    const scheduler = new TaskScheduler({
      settings: () => ({ apiBaseUrl: "https://example.test", apiKey: "k-test", outputFolder: OUTPUT }),
      files: {
        isFile: (p) => fs.isFile(p),
        read: (p) => fs.read(p).catch(() => null),
        exists: (p) => fs.exists(p),
        makeDirs: (p) => fs.makeDirs(p),
        join: paths.join,
      },
      history,
      http: {
        submit: async () => responded(200, { id: "unused" }),
        query: async (request) => {
          const id = new URL(request.url).searchParams.get("id") ?? "";
          queryCalls.push(id);
          return queryHandler(id, request);
        },
        download: async (url, destPath) => {
          downloadCalls.push({ url, destPath });
          return downloadHandler(url, destPath);
        },
      },
      sleep: async () => {},
    });

    const makeSession = () => {
      const taskList = new TaskList({
        scheduler: () => scheduler,
        settings: () => ({ maxRetries: 3, vipModerationRetry: false }),
      });
      const refetcher = createHistoryRefetcher({
        getTask: (id) => history.getTask(id),
        updateTask: (id, status, update) => history.updateTask(id, status, update),
        probeOnce: (id) => scheduler.probeOnce(id),
        downloadResults: (spec, id, data) => scheduler.downloadResults(spec, id, data),
        isActive: (id) => taskList.hasActiveTaskId(id),
        resume: (task, spec, progress, serverStatus) => {
          taskList.attach({ taskId: task.id, prompt: task.prompt, spec, progress, serverStatus });
        },
        allowPath: async () => {},
        exists: (p) => fs.exists(p),
        onChanged: () => {},
      });
      return { taskList, refetcher };
    };

    return {
      history,
      fs,
      scheduler,
      queryCalls,
      downloadCalls,
      setQuery: (fn: typeof queryHandler) => {
        queryHandler = fn;
      },
      setDownload: (fn: typeof downloadHandler) => {
        downloadHandler = fn;
      },
      makeSession,
    };
  }

  it("can resume a long-running video task across multiple app restarts until completion", async () => {
    const env = await setup("multi-restart.db");
    const task = await env.history.addTask({
      id: "vid-20min-001",
      prompt: "a cinematic dragon",
      model: "wan-3.0",
      aspectRatio: "16:9",
      imageSize: "720p",
      duration: 10,
    });

    // 第 1 次重启后：远端仍在 35% 运行
    const gate1 = deferred<HttpOutcome>();
    let polls = 0;
    env.setQuery(async (id) => {
      polls += 1;
      if (polls === 1) return responded(200, { id, status: "running", progress: 35 });
      return gate1.promise;
    });

    const session1 = env.makeSession();
    const out1 = await session1.refetcher.refetchTask(task);
    expect(out1).toEqual({ kind: "resumed", progress: 35 });
    expect(session1.taskList.hasActiveTaskId(task.id)).toBe(true);

    // 模拟用户在任务未完时再次关闭软件（停掉所有跟踪）
    session1.taskList.stopAll();
    gate1.resolve(responded(200, { id: task.id, status: "running", progress: 40 }));
    await flush();

    // 数据库里该任务依然完好保持 running，可再次接续
    expect((await env.history.getTask(task.id))?.status).toBe("running");

    // 第 2 次重启后：远端先 70%，下一次轮询完成
    let session2Polls = 0;
    env.setQuery(async (id) => {
      session2Polls += 1;
      if (session2Polls <= 2) return responded(200, { id, status: "running", progress: 70 });
      return responded(200, {
        id,
        status: "succeeded",
        progress: 100,
        results: [{ url: "https://cdn.example/video.mp4" }],
      });
    });

    const session2 = env.makeSession();
    const out2 = await session2.refetcher.refetchTask(task);
    expect(out2).toEqual({ kind: "resumed", progress: 70 });
    await flush();
    await flush();

    const done = await env.history.getTask(task.id);
    const expectedPath = `${OUTPUT}\\${deterministicResultStem(task.created_at, task.id)}.mp4`;
    expect(done?.status).toBe("succeeded");
    expect(done?.result_path).toBe(expectedPath);
    expect(await env.fs.exists(expectedPath)).toBe(true);
    expect(env.downloadCalls).toHaveLength(1);
  });

  it("coalesces 5 rapid concurrent clicks on the same task into 1 request and 1 download", async () => {
    const env = await setup("rapid-5x.db");
    const task = await env.history.addTask({
      id: "task-rapid-1",
      prompt: "apple",
      model: "nano-banana-pro",
      aspectRatio: "1:1",
      imageSize: "1K",
    });

    const gate = deferred<HttpOutcome>();
    env.setQuery(() => gate.promise);

    const { refetcher } = env.makeSession();
    // 同一时刻连续点击 5 次
    const promises = Array.from({ length: 5 }, () => refetcher.refetchTask(task));
    gate.resolve(
      responded(200, {
        id: task.id,
        status: "succeeded",
        progress: 100,
        results: [{ url: "https://cdn.example/apple.png" }],
      }),
    );

    const results = await Promise.all(promises);
    expect(results[0]).toMatchObject({ kind: "updated_succeeded", downloaded: true });
    expect(results.slice(1)).toEqual([
      { kind: "in_flight" },
      { kind: "in_flight" },
      { kind: "in_flight" },
      { kind: "in_flight" },
    ]);
    expect(env.queryCalls).toEqual([task.id]);
    expect(env.downloadCalls).toHaveLength(1);

    // 下载完成后再连点 5 次：直接命中本地文件短路，0 次网络请求、0 次下载
    for (let i = 0; i < 5; i += 1) {
      const again = await refetcher.refetchTask(task);
      expect(again.kind).toBe("already_complete");
    }
    expect(env.queryCalls).toEqual([task.id]);
    expect(env.downloadCalls).toHaveLength(1);
  });

  it("survives 5 alternating rounds across mixed-status tasks without duplicates or DB corruption", async () => {
    const env = await setup("mixed-5rounds.db");

    // 1. 仍在运行的任务
    const tRunning = await env.history.addTask({
      id: "t-running",
      prompt: "p1",
      model: "nano-banana-pro",
      aspectRatio: "1:1",
      imageSize: "1K",
    });
    // 2. 已成功且本地文件存在的任务
    const tDoneLocal = await env.history.addTask({
      id: "t-done-local",
      prompt: "p2",
      model: "nano-banana-pro",
      aspectRatio: "1:1",
      imageSize: "1K",
    });
    const localExisting = `${OUTPUT}\\grsai_existing.png`;
    await env.fs.makeDirs(OUTPUT);
    await env.fs.write(localExisting, new Uint8Array([9, 9]));
    await env.history.updateTask(tDoneLocal.id, "succeeded", { resultPath: localExisting });

    // 3. 本地曾记失败，但远端其实已成功（需要下载并改回 succeeded、清掉旧错误）
    const tRecovered = await env.history.addTask({
      id: "t-recovered",
      prompt: "p3",
      model: "nano-banana-pro",
      aspectRatio: "1:1",
      imageSize: "1K",
    });
    await env.history.updateTask(tRecovered.id, "failed", {
      failureReason: "Network Error",
      errorMessage: "temporary drop",
    });

    // 4. 卡在 running 但远端已超过 2 小时过期（404）
    const tExpiredRunning = await env.history.addTask({
      id: "t-expired-run",
      prompt: "p4",
      model: "nano-banana-pro",
      aspectRatio: "1:1",
      imageSize: "1K",
    });

    // 5. 已失败且有真实违规原因，远端也已过期（不能被覆盖成 Task expired）
    const tOldFailed = await env.history.addTask({
      id: "t-old-failed",
      prompt: "p5",
      model: "nano-banana-pro",
      aspectRatio: "1:1",
      imageSize: "1K",
    });
    await env.history.updateTask(tOldFailed.id, "failed", {
      failureReason: "output_moderation",
      errorMessage: "blocked",
    });

    const holdRunning = deferred<HttpOutcome>();
    let runningProbes = 0;
    env.setQuery(async (id) => {
      if (id === tRunning.id) {
        runningProbes += 1;
        if (runningProbes === 1) return responded(200, { id, status: "running", progress: 20 });
        return holdRunning.promise;
      }
      if (id === tRecovered.id) {
        return responded(200, {
          id,
          status: "succeeded",
          progress: 100,
          results: [{ url: "https://cdn.example/recovered.png" }],
        });
      }
      return responded(404, { error: "result not exist, valid for 2 hours" });
    });

    const { taskList, refetcher } = env.makeSession();
    const initialTasks = (await env.history.getAllTasks()).filter(Boolean);
    const byId = new Map(initialTasks.map((t) => [t.id, t]));
    const batch: HistoryTask[] = [
      byId.get(tRunning.id)!,
      byId.get(tDoneLocal.id)!,
      byId.get(tRecovered.id)!,
      byId.get(tExpiredRunning.id)!,
      byId.get(tOldFailed.id)!,
    ];

    // 轮换点击 5 轮
    for (let round = 0; round < 5; round += 1) {
      for (const item of batch) {
        const out = await refetcher.refetchTask(item);
        if (item.id === tRunning.id) {
          expect(out.kind).toBe(round === 0 ? "resumed" : "already_tracking");
        } else if (item.id === tDoneLocal.id) {
          expect(out.kind).toBe("already_complete");
        } else if (item.id === tRecovered.id) {
          expect(out.kind).toBe(round === 0 ? "updated_succeeded" : "already_complete");
        } else if (item.id === tExpiredRunning.id) {
          expect(out.kind).toBe(round === 0 ? "marked_expired" : "expired_unchanged");
        } else if (item.id === tOldFailed.id) {
          expect(out.kind).toBe("expired_unchanged");
        }
      }
    }

    // tDoneLocal 从未发出任何远端请求；tRecovered 只下载 1 次；tRunning 只建 1 张卡片
    expect(env.queryCalls.filter((id) => id === tDoneLocal.id)).toHaveLength(0);
    expect(env.downloadCalls).toHaveLength(1);
    expect(taskList.getCards().filter((c) => c.taskId === tRunning.id)).toHaveLength(1);

    // 核对 SQLite 最终数据完整性
    const recRow = await env.history.getTask(tRecovered.id);
    expect(recRow?.status).toBe("succeeded");
    expect(recRow?.failure_reason).toBeNull();
    expect(recRow?.error_message).toBeNull();

    const expRow = await env.history.getTask(tExpiredRunning.id);
    expect(expRow?.status).toBe("failed");
    expect(expRow?.failure_reason).toBe("Task expired");

    const oldRow = await env.history.getTask(tOldFailed.id);
    expect(oldRow?.status).toBe("failed");
    expect(oldRow?.failure_reason).toBe("output_moderation");

    taskList.stopAll();
    holdRunning.resolve(responded(200, { id: tRunning.id, status: "running", progress: 25 }));
    await flush();
  });

  it("caps page-wide refetch concurrency and serializes concurrent SQLite updates cleanly", async () => {
    const env = await setup("page-concurrency.db");
    const tasks: HistoryTask[] = [];
    for (let i = 0; i < 8; i += 1) {
      tasks.push(
        await env.history.addTask({
          id: `batch-${i}`,
          prompt: `p-${i}`,
          model: "nano-banana-pro",
          aspectRatio: "1:1",
          imageSize: "1K",
        }),
      );
    }

    let inFlight = 0;
    let peak = 0;
    env.setQuery(async (id) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await flush();
      inFlight -= 1;
      return responded(400, { id, status: "failed", error: "generate failed" });
    });

    const { refetcher } = env.makeSession();
    const summary = await refetcher.refetchPage(tasks, { concurrency: 3 });
    expect(peak).toBeLessThanOrEqual(3);
    expect(summary).toMatchObject({
      total: 8,
      updatedFailed: 8,
      errors: 0,
    });

    // 20 次并发 SQLite 写入全部串行落盘，不丢不锁
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        env.history.updateTask(`batch-${i % 8}`, "failed", { errorMessage: `err-${i}` }),
      ),
    );
    expect(await env.history.getTaskCount()).toBe(8);
  });

  it("marks an actively polled task as expired immediately on HTTP 404 without 10 retries", async () => {
    const env = await setup("poll-404.db");
    const task = await env.history.addTask({
      id: "poll-expired-1",
      prompt: "old",
      model: "nano-banana-pro",
      aspectRatio: "1:1",
      imageSize: "1K",
    });

    env.setQuery(async () => responded(404, { error: "result not exist, valid for 2 hours" }));

    const events: string[] = [];
    const handle = env.scheduler.resume(task.id, { prompt: task.prompt, model: task.model }, (e) => {
      events.push(e.type);
    });
    await handle.done;

    expect(env.queryCalls).toEqual([task.id]);
    expect(events).toEqual(["submitted", "failed"]);
    const row = await env.history.getTask(task.id);
    expect(row?.status).toBe("failed");
    expect(row?.failure_reason).toBe("Task expired");
  });

  it("never alters expired (>2h) succeeded (even if file deleted), failed, or violation records", async () => {
    const env = await setup("expired-preserve.db");

    const tSuccDeleted = await env.history.addTask({
      id: "old-succ-deleted",
      prompt: "old success",
      model: "nano-banana-pro",
      aspectRatio: "1:1",
      imageSize: "1K",
    });
    const fakeThumb = "data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=";
    await env.history.updateTask(tSuccDeleted.id, "succeeded", {
      resultPath: `${OUTPUT}\\deleted_file.png`,
      thumbnail: fakeThumb,
      resultSha256: "abc123",
    });

    const tViolation = await env.history.addTask({
      id: "old-violation",
      prompt: "old violation",
      model: "nano-banana-pro",
      aspectRatio: "1:1",
      imageSize: "1K",
    });
    await env.history.updateTask(tViolation.id, "violation", {
      failureReason: "output_moderation",
      errorMessage: "blocked",
    });

    const tFailed = await env.history.addTask({
      id: "old-failed",
      prompt: "old failed",
      model: "nano-banana-pro",
      aspectRatio: "1:1",
      imageSize: "1K",
    });
    await env.history.updateTask(tFailed.id, "failed", {
      failureReason: "Unknown",
      errorMessage: "boom",
    });

    // 全部已超过 2 小时有效期，服务端返回 404
    env.setQuery(async () => responded(404, { error: "result not exist, valid for 2 hours" }));

    const { refetcher } = env.makeSession();
    const all = await env.history.getAllTasks();
    const summary = await refetcher.refetchPage(all);
    expect(summary).toMatchObject({
      total: 3,
      expiredUnchanged: 3,
      markedExpired: 0,
      updatedFailed: 0,
    });

    const rSucc = await env.history.getTask(tSuccDeleted.id);
    expect(rSucc?.status).toBe("succeeded");
    expect(rSucc?.thumbnail).toBe(fakeThumb);
    expect(rSucc?.result_sha256).toBe("abc123");

    const rVio = await env.history.getTask(tViolation.id);
    expect(rVio?.status).toBe("violation");
    expect(rVio?.failure_reason).toBe("output_moderation");

    const rFail = await env.history.getTask(tFailed.id);
    expect(rFail?.status).toBe("failed");
    expect(rFail?.failure_reason).toBe("Unknown");
  });

  it("verifies local file existence and SHA-256 integrity, rejecting deleted or same-name replaced files", async () => {
    const fs = createMemoryFs(paths, DATA_DIR);
    const filePath = `${OUTPUT}\\grsai_genuine.png`;
    await fs.write(filePath, new Uint8Array([10, 20, 30, 40]));
    const realHash = await fs.sha256(filePath);
    expect(realHash).toMatch(/^[0-9a-f]{64}$/);

    const deps = {
      allowPath: async () => {},
      exists: (p: string) => fs.exists(p),
      sha256: (p: string) => fs.sha256(p),
    };

    // 1. 原文件完好 -> 校验通过
    expect(
      await verifyHistoryResultFile({ result_path: filePath, result_sha256: realHash }, deps),
    ).toEqual({ ok: true, path: filePath, needsBackfill: false });

    // 2. 老记录无 SHA-256 但文件存在 -> 放行并提示需要后台补齐
    expect(
      await verifyHistoryResultFile({ result_path: filePath, result_sha256: null }, deps),
    ).toEqual({ ok: true, path: filePath, needsBackfill: true });

    // 3. 删除原文件并放入同名但内容不同的其他文件 -> SHA-256 校验拦截
    await fs.write(filePath, new Uint8Array([99, 88, 77, 66]));
    expect(
      await verifyHistoryResultFile({ result_path: filePath, result_sha256: realHash }, deps),
    ).toEqual({ ok: false, reason: "mismatch" });

    // 4. 文件被删除/移动 -> 报 missing
    await fs.remove(filePath);
    expect(
      await verifyHistoryResultFile({ result_path: filePath, result_sha256: realHash }, deps),
    ).toEqual({ ok: false, reason: "missing" });
  });
});
