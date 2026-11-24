import { describe, expect, it } from "vitest";
import { createMemoryFs } from "../platform/memoryFs";
import type { HttpRequest, HttpOutcome } from "./api";
import { createPathTools } from "./paths";
import {
  TaskScheduler,
  extensionForUrl,
  resultFileStem,
  type TaskDeps,
  type TaskEvent,
  type TaskSpec,
} from "./tasks";

const paths = createPathTools("\\");
const DATA_DIR = "C:\\data";
const OUTPUT = `${DATA_DIR}\\output`;
const FILE_TIME = "2026-11-24-23-05-07";
const SERVER_ID = "srv-1";

const outFile = (name: string) => `${OUTPUT}\\${name}`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 让已经排队的微任务全部跑完。 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function responded(status: number, body: unknown): HttpOutcome {
  return { outcome: "responded", status, body: typeof body === "string" ? body : JSON.stringify(body) };
}
const notSent = (message = "connect error"): HttpOutcome => ({ outcome: "not_sent", message });
const unknown = (message = "read timed out"): HttpOutcome => ({ outcome: "unknown", message, status: null });
/** 任务查询的成功响应：HTTP 200 且带任务 id，缺 id 就不算成功。 */
const taskState = (fields: Record<string, unknown>): HttpOutcome => responded(200, { id: SERVER_ID, ...fields });
const succeeded = (results: unknown[]): HttpOutcome =>
  taskState({ status: "succeeded", progress: 100, results });
const last = <T,>(items: T[]): T => items[items.length - 1];

interface Row {
  id: string;
  status: string;
  [key: string]: unknown;
}

interface HarnessOptions {
  submitConcurrency?: number;
}

function harness(options: HarnessOptions = {}) {
  const fs = createMemoryFs(paths, DATA_DIR);
  const rows = new Map<string, Row>();
  const localFiles = new Map<string, Uint8Array>();
  const state = {
    slept: 0,
    order: [] as string[],
    submitRequests: [] as HttpRequest[],
    queries: [] as HttpRequest[],
    downloads: [] as Array<{ url: string; destPath: string }>,
    inFlight: 0,
    maxInFlight: 0,
    logs: [] as string[],
  };

  const scripts = {
    submit: (_request: HttpRequest): Promise<HttpOutcome> => Promise.resolve(responded(200, { id: SERVER_ID })),
    query: (_request: HttpRequest, _call: number): Promise<HttpOutcome> =>
      Promise.resolve(responded(200, { id: SERVER_ID, status: "running", progress: 50 })),
    download: (_url: string, _destPath: string): Promise<HttpOutcome> => Promise.resolve(responded(200, "")),
  };

  const http: TaskDeps["http"] = {
    async submit(request) {
      state.submitRequests.push(request);
      state.order.push(JSON.parse(request.body ?? "{}").prompt);
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        return await scripts.submit(request);
      } finally {
        state.inFlight -= 1;
      }
    },
    async query(request) {
      state.queries.push(request);
      return scripts.query(request, state.queries.length);
    },
    async download(url, destPath) {
      state.downloads.push({ url, destPath });
      return scripts.download(url, destPath);
    },
  };

  const deps: TaskDeps = {
    settings: () => ({ apiBaseUrl: "https://example.test/", apiKey: "secret-key", outputFolder: OUTPUT }),
    files: {
      isFile: async (path) => localFiles.has(path),
      read: async (path) => localFiles.get(path) ?? null,
      exists: (path) => fs.exists(path),
      makeDirs: (path) => fs.makeDirs(path),
      join: paths.join,
    },
    history: {
      async addTask(input) {
        const row: Row = { ...input, status: "running" };
        rows.set(input.id, row);
        return row as never;
      },
      async updateTask(taskId, status, update = {}) {
        const row = rows.get(taskId);
        if (!row) return null;
        for (const [key, value] of Object.entries(update)) if (value) row[key] = value;
        row.status = status;
        return { ...row } as never;
      },
    },
    http,
    now: () => new Date(2026, 10, 24, 23, 5, 7),
    sleep: async (ms) => {
      state.slept += ms;
    },
    log: (message) => {
      state.logs.push(message);
    },
  };

  const concurrency = () => options.submitConcurrency ?? 1;
  const scheduler = new TaskScheduler(deps, { submitConcurrency: concurrency });

  /** 跑完一个任务，返回它上报的全部事件。 */
  async function run(spec: Partial<TaskSpec> = {}) {
    const events: TaskEvent[] = [];
    const handle = scheduler.start({ prompt: "a cat", model: "nano-banana-pro", ...spec }, (event) => events.push(event));
    await handle.done;
    return events;
  }

  return { scheduler, deps, concurrency, state, rows, localFiles, fs, scripts, run };
}

const failureOf = (events: TaskEvent[]) => events.find((event) => event.type === "failed");

describe("task lifecycle", () => {
  it("reports the server task id right after submitting, then follows the task to success", async () => {
    const h = harness();
    h.scripts.query = (_request, call) =>
      Promise.resolve(call === 1 ? taskState({ status: "running", progress: 10 }) : succeeded([{ url: "https://cdn/x.png" }]));
    const events = await h.run({ refImageUrls: ["https://ex/ref.png"] });

    expect(events).toEqual([
      { type: "submitted", taskId: SERVER_ID },
      { type: "progress", progress: 10, status: "running" },
      { type: "progress", progress: 100, status: "succeeded" },
      { type: "succeeded", resultPath: outFile(`grsai_${FILE_TIME}.png`) },
    ]);
    // 两次轮询之间等了一个间隔
    expect(h.state.slept).toBe(2000);
    expect(h.state.queries.map((request) => request.url)).toEqual([
      "https://example.test/v1/api/result?id=srv-1",
      "https://example.test/v1/api/result?id=srv-1",
    ]);
    expect(h.state.queries[0]).toMatchObject({
      method: "GET",
      headers: { Authorization: "Bearer secret-key" },
      connectTimeoutSecs: 30,
      readTimeoutSecs: 30,
    });
    expect(h.state.downloads).toEqual([{ url: "https://cdn/x.png", destPath: outFile(`grsai_${FILE_TIME}.png`) }]);
    expect(h.rows.get(SERVER_ID)).toMatchObject({
      status: "succeeded",
      resultPath: outFile(`grsai_${FILE_TIME}.png`),
      previewUrl: "https://cdn/x.png",
      refImages: ["https://ex/ref.png"],
    });
    expect(h.scheduler.activeCount).toBe(0);
  });

  it("builds the submit request like the source project does", async () => {
    const h = harness();
    h.localFiles.set("C:\\in\\a.png", new Uint8Array([1, 2, 3]));
    h.scripts.query = () => Promise.resolve(succeeded([{ url: "https://cdn/x.png" }]));
    await h.run({
      refImageUrls: ["C:\\in\\a.png", "https://ex/ref.png", "C:\\in\\not-there.png"],
      imageSize: "2K",
      aspectRatio: "1:1",
    });
    const request = h.state.submitRequests[0];
    expect(request).toMatchObject({
      method: "POST",
      url: "https://example.test/v1/api/generate",
      headers: { "Content-Type": "application/json", Authorization: "Bearer secret-key" },
      connectTimeoutSecs: 60,
      readTimeoutSecs: 60,
    });
    expect(JSON.parse(request.body ?? "{}")).toEqual({
      model: "nano-banana-pro",
      prompt: "a cat",
      aspectRatio: "1:1",
      imageSize: "2K",
      // 本地文件转 data URI；地址和不存在的路径原样透传，只有「是文件却读不了」才丢弃
      images: ["data:image/png;base64,AQID", "https://ex/ref.png", "C:\\in\\not-there.png"],
      replyType: "async",
    });
    // 历史里记的是参考图原本的路径，不是 data URI
    expect(h.rows.get(SERVER_ID)?.refImages).toEqual([
      "C:\\in\\a.png",
      "https://ex/ref.png",
      "C:\\in\\not-there.png",
    ]);
  });

  it("stores video parameters in history", async () => {
    const h = harness();
    h.scripts.query = () => Promise.resolve(succeeded([{ url: "https://cdn/v" }]));
    await h.run({
      model: "wan-3.0",
      imageSize: "1080p",
      aspectRatio: "21:9",
      duration: 8,
      seed: 99,
      refAudios: ["https://ex/a.mp3"],
      firstFrame: "https://ex/f.png",
    });
    expect(h.rows.get(SERVER_ID)).toMatchObject({
      model: "wan-3.0",
      imageSize: "1080p",
      aspectRatio: "21:9",
      duration: 8,
      seed: 99,
      refAudios: ["https://ex/a.mp3"],
      firstFrame: "https://ex/f.png",
      lastFrame: null,
    });
  });

  it("rejects a model it does not know before touching the network", async () => {
    const h = harness();
    const events = await h.run({ model: "no-such-model" });
    expect(events).toEqual([
      { type: "failed", reason: "Unknown model: no-such-model", failureReason: "Submission failed" },
    ]);
    expect(h.state.submitRequests).toEqual([]);
    expect(h.rows.size).toBe(0);
  });
});

describe("result file names", () => {
  it("derives the extension from the url, falling back to png or mp4 for video", async () => {
    const h = harness();
    h.scripts.query = () =>
      Promise.resolve(
        succeeded([
          { url: "https://cdn/A.JPG?sig=1" },
          { url: "https://cdn/b.webp" },
          { url: "https://cdn/c.unknownext" },
        ]),
      );
    const events = await h.run();
    expect(last(events)).toEqual({ type: "succeeded", resultPath: outFile(`grsai_${FILE_TIME}_1.jpg`) });
    expect(h.state.downloads.map((entry) => entry.destPath)).toEqual([
      outFile(`grsai_${FILE_TIME}_1.jpg`),
      outFile(`grsai_${FILE_TIME}_2.webp`),
      outFile(`grsai_${FILE_TIME}_3.png`),
    ]);

    const video = harness();
    video.scripts.query = () => Promise.resolve(succeeded([{ url: "https://cdn/v.binary?token=.mp4" }]));
    await video.run({ model: "wan-3.0" });
    expect(video.state.downloads[0].destPath).toBe(outFile(`grsai_${FILE_TIME}.mp4`));
  });

  it("numbers multiple results without checking for clashes", async () => {
    const h = harness();
    await h.fs.write(outFile(`grsai_${FILE_TIME}_1.png`), new Uint8Array([9]));
    h.scripts.query = () => Promise.resolve(succeeded([{ url: "https://cdn/a.png" }, { url: "https://cdn/b.png" }]));
    await h.run();
    expect(h.state.downloads.map((entry) => entry.destPath)).toEqual([
      outFile(`grsai_${FILE_TIME}_1.png`),
      outFile(`grsai_${FILE_TIME}_2.png`),
    ]);
  });

  it("adds a counter to a single result whose name is already taken", async () => {
    const h = harness();
    await h.fs.write(outFile(`grsai_${FILE_TIME}.png`), new Uint8Array([9]));
    await h.fs.write(outFile(`grsai_${FILE_TIME}_1.png`), new Uint8Array([9]));
    h.scripts.query = () => Promise.resolve(succeeded([{ url: "https://cdn/a.png" }]));
    await h.run();
    expect(h.state.downloads[0].destPath).toBe(outFile(`grsai_${FILE_TIME}_2.png`));
  });

  it("uses the prefix and output folder the caller gives it", async () => {
    const h = harness();
    h.scripts.query = () => Promise.resolve(succeeded([{ url: "https://cdn/a.png" }]));
    // 漫画页传入的前缀自带 grsai_，源项目里结果文件是双前缀，这里保持一致
    await h.run({ filenamePrefix: " grsai_page_01 ", outputDir: "C:\\data\\output\\Demo\\pages" });
    expect(h.state.downloads[0].destPath).toBe(`C:\\data\\output\\Demo\\pages\\grsai_grsai_page_01_${FILE_TIME}.png`);
    expect(await h.fs.isDir("C:\\data\\output\\Demo\\pages")).toBe(true);
  });

  it("creates the output folder when it does not exist yet", async () => {
    const h = harness();
    expect(await h.fs.isDir(OUTPUT)).toBe(false);
    h.scripts.query = () => Promise.resolve(succeeded([{ url: "https://cdn/a.png" }]));
    await h.run();
    expect(await h.fs.isDir(OUTPUT)).toBe(true);
  });

  it("exposes the naming helpers", () => {
    expect(resultFileStem("", FILE_TIME)).toBe(`grsai_${FILE_TIME}`);
    expect(resultFileStem(undefined, FILE_TIME)).toBe(`grsai_${FILE_TIME}`);
    expect(resultFileStem("  page_2 ", FILE_TIME)).toBe(`grsai_page_2_${FILE_TIME}`);
    expect(extensionForUrl("https://x/a.png?x=.mp4", "png")).toBe("png");
    expect(extensionForUrl(undefined, "mp4")).toBe("mp4");
  });
});

describe("failures", () => {
  it("tells a request that never left apart from one with an unknown fate", async () => {
    const notSentHarness = harness();
    notSentHarness.scripts.submit = () => Promise.resolve(notSent("dns error: x"));
    expect(failureOf(await notSentHarness.run())).toEqual({
      type: "failed",
      reason: "dns error: x",
      failureReason: "Submission failed",
      delivery: "not_sent",
    });
    expect(notSentHarness.rows.size).toBe(0);

    const unknownHarness = harness();
    unknownHarness.scripts.submit = () => Promise.resolve(unknown());
    expect(failureOf(await unknownHarness.run())).toEqual({
      type: "failed",
      reason: "read timed out",
      failureReason: "Submission failed",
      delivery: "unknown",
    });
    expect(unknownHarness.rows.size).toBe(0);
  });

  it("passes on the server's reason when it declines the submission", async () => {
    const h = harness();
    h.scripts.submit = () => Promise.resolve(responded(400, { error: { message: "quota exceeded" }, status: 402 }));
    expect(failureOf(await h.run())).toEqual({
      type: "failed",
      reason: "{'message': 'quota exceeded'}",
      failureReason: "Submission failed",
    });

    const plain = harness();
    plain.scripts.submit = () => Promise.resolve(responded(200, { msg: "model is busy" }));
    expect(failureOf(await plain.run())).toMatchObject({ reason: "model is busy" });
    expect(plain.rows.size).toBe(0);
  });

  it("reports a crash before the server answers as a submission exception", async () => {
    const h = harness();
    h.scripts.submit = () => Promise.reject(new Error("socket closed"));
    expect(failureOf(await h.run())).toEqual({
      type: "failed",
      reason: "socket closed",
      failureReason: "Submission Exception",
    });
  });

  it("records failure and violation reasons from the server", async () => {
    const h = harness();
    h.scripts.query = () =>
      Promise.resolve(taskState({ status: "failed", progress: 30, failure_reason: "output_moderation", error: "risky" }));
    const events = await h.run();
    expect(last(events)).toEqual({ type: "failed", reason: "output_moderation: risky", failureReason: "output_moderation" });
    expect(h.rows.get(SERVER_ID)).toMatchObject({ status: "failed", failureReason: "output_moderation", errorMessage: "risky" });

    const v = harness();
    v.scripts.query = () => Promise.resolve(taskState({ status: "violation" }));
    expect(failureOf(await v.run())).toEqual({ type: "failed", reason: "violation", failureReason: "violation" });
    expect(v.rows.get(SERVER_ID)).toMatchObject({ status: "violation", failureReason: "violation" });

    const f = harness();
    f.scripts.query = () => Promise.resolve(taskState({ status: "failed" }));
    expect(failureOf(await f.run())).toEqual({ type: "failed", reason: "Unknown", failureReason: "Unknown" });
  });

  it("fails when the server reports success without results", async () => {
    const h = harness();
    h.scripts.query = () => Promise.resolve(taskState({ status: "succeeded", results: [] }));
    expect(failureOf(await h.run())).toEqual({ type: "failed", reason: "No results found", failureReason: "No Results" });
    expect(h.rows.get(SERVER_ID)).toMatchObject({ status: "failed", failureReason: "No results found" });
  });

  it("fails when no result could be downloaded", async () => {
    const h = harness();
    h.scripts.query = () => Promise.resolve(succeeded([{ url: "https://cdn/a.png" }]));
    h.scripts.download = () => Promise.resolve(unknown("connection reset"));
    expect(failureOf(await h.run())).toEqual({ type: "failed", reason: "Download failed", failureReason: "Download Failed" });
    expect(h.rows.get(SERVER_ID)).toMatchObject({ status: "failed", failureReason: "Download failed" });
    expect(h.state.logs[0]).toContain("Download error for result 0");
  });

  it("does not save an error page as an image", async () => {
    const h = harness();
    h.scripts.query = () => Promise.resolve(succeeded([{ url: "https://cdn/a.png" }]));
    h.scripts.download = () => Promise.resolve(responded(404, "<html>not found</html>"));
    expect(failureOf(await h.run())).toMatchObject({ failureReason: "Download Failed" });
    expect(await h.fs.exists(outFile(`grsai_${FILE_TIME}.png`))).toBe(false);
  });

  it("keeps the source project's behaviour when only the first result fails to download", async () => {
    const h = harness();
    h.scripts.query = () => Promise.resolve(succeeded([{ url: "https://cdn/a.png" }, { url: "https://cdn/b.png" }]));
    h.scripts.download = (url) => Promise.resolve(url.endsWith("a.png") ? notSent("x") : responded(200, ""));
    const events = await h.run();
    // 源项目只认第一个结果的文件：它没下来时任务仍算成功，只是没有可打开的文件
    expect(last(events)).toEqual({ type: "succeeded", resultPath: null });
    expect(h.rows.get(SERVER_ID)).toMatchObject({ status: "succeeded", previewUrl: "https://cdn/a.png" });
    expect(h.rows.get(SERVER_ID)).not.toHaveProperty("resultPath");
  });

  it("reports malformed result data as a processing error", async () => {
    const h = harness();
    h.scripts.query = () => Promise.resolve(taskState({ status: "succeeded", results: ["not an object"] }));
    expect(failureOf(await h.run())).toMatchObject({ failureReason: "Processing Error" });

    const p = harness();
    p.scripts.query = () => Promise.resolve(taskState({ status: "running", progress: null }));
    expect(failureOf(await p.run())).toMatchObject({ failureReason: "Processing Error" });
  });
});

describe("polling", () => {
  it("tolerates ten query errors in a row and keeps going", async () => {
    const h = harness();
    h.scripts.query = (_request, call) =>
      Promise.resolve(call <= 10 ? responded(500, "boom") : succeeded([{ url: "https://cdn/a.png" }]));
    const events = await h.run();
    expect(last(events)?.type).toBe("succeeded");
    expect(h.state.queries).toHaveLength(11);
    expect(h.state.slept).toBe(10 * 2000);
  });

  it("gives up after the eleventh consecutive error", async () => {
    const h = harness();
    h.scripts.query = () => Promise.resolve(responded(500, "oops"));
    const events = await h.run();
    expect(last(events)).toEqual({
      type: "failed",
      reason: "Network error: HTTP 500: invalid JSON response",
      failureReason: "Network Error",
    });
    expect(h.state.queries).toHaveLength(11);
    expect(h.state.slept).toBe(10 * 2000);
    // 查不到结果不算任务失败，历史里仍是 running，与源项目一致
    expect(h.rows.get(SERVER_ID)).toMatchObject({ status: "running" });
  });

  it("counts transport failures like any other query error", async () => {
    const h = harness();
    h.scripts.query = () => Promise.resolve(notSent("offline"));
    const events = await h.run();
    expect(last(events)).toMatchObject({ reason: "Network error: offline", failureReason: "Network Error" });
    expect(h.state.queries).toHaveLength(11);
  });

  it("starts the error count over after a good answer", async () => {
    const h = harness();
    h.scripts.query = (_request, call) =>
      Promise.resolve(call % 6 === 0 ? taskState({ status: "running", progress: 1 }) : responded(500, "boom"));
    const sixGoodAnswers = deferred<void>();
    let goodAnswers = 0;
    const failures: TaskEvent[] = [];
    const handle = h.scheduler.start({ prompt: "a cat", model: "nano-banana" }, (event) => {
      if (event.type === "progress" && ++goodAnswers === 6) sixGoodAnswers.resolve();
      if (event.type === "failed") failures.push(event);
    });
    await sixGoodAnswers.promise;
    handle.cancel();
    await handle.done;
    // 每五次失败后有一次成功，计数清零，所以任务一直活着
    expect(goodAnswers).toBe(6);
    expect(h.state.queries).toHaveLength(36);
    expect(failures).toEqual([]);
  });
});

describe("cancelling", () => {
  it("stops following a task without touching its history row", async () => {
    const h = harness();
    const firstAnswer = deferred<HttpOutcome>();
    h.scripts.query = () => firstAnswer.promise;
    const events: TaskEvent[] = [];
    const handle = h.scheduler.start({ prompt: "a cat", model: "nano-banana" }, (event) => events.push(event));
    await flush();
    expect(h.state.queries).toHaveLength(1);
    expect(h.scheduler.activeCount).toBe(1);

    handle.cancel();
    firstAnswer.resolve(responded(200, { status: "running", progress: 20 }));
    await handle.done;
    expect(events).toEqual([{ type: "submitted", taskId: SERVER_ID }]);
    expect(h.state.queries).toHaveLength(1);
    expect(h.rows.get(SERVER_ID)).toMatchObject({ status: "running" });
    expect(h.scheduler.activeCount).toBe(0);
  });

  it("stops following every task at once", async () => {
    const h = harness({ submitConcurrency: 3 });
    const gate = deferred<HttpOutcome>();
    h.scripts.submit = () => gate.promise;
    const events: TaskEvent[][] = [[], [], []];
    const handles = [0, 1, 2].map((index) =>
      h.scheduler.start({ prompt: `p${index}`, model: "nano-banana" }, (event) => events[index].push(event)),
    );
    await flush();
    h.scheduler.cancelAll();
    gate.resolve(responded(200, { id: SERVER_ID }));
    await Promise.all(handles.map((handle) => handle.done));
    expect(events).toEqual([[], [], []]);
    expect(h.rows.size).toBe(0);
    expect(h.scheduler.activeCount).toBe(0);
  });
});

describe("submission gate", () => {
  it("keeps at most N submissions in flight and lets the rest through in order", async () => {
    const h = harness({ submitConcurrency: 2 });
    const gates: Array<ReturnType<typeof deferred<HttpOutcome>>> = [];
    h.scripts.submit = () => {
      const gate = deferred<HttpOutcome>();
      gates.push(gate);
      return gate.promise;
    };
    const handles = Array.from({ length: 6 }, (_, index) =>
      h.scheduler.start({ prompt: `p${index}`, model: "nano-banana" }, () => undefined),
    );
    await flush();
    expect(h.state.order).toEqual(["p0", "p1"]);
    expect(h.scheduler.activeCount).toBe(6);

    for (let index = 0; index < 6; index += 1) {
      expect(h.state.inFlight).toBe(Math.min(2, 6 - index));
      gates[index].resolve(notSent("stop here"));
      await flush();
    }
    expect(h.state.order).toEqual(["p0", "p1", "p2", "p3", "p4", "p5"]);
    expect(h.state.maxInFlight).toBe(2);
    await Promise.all(handles.map((handle) => handle.done));
    expect(h.scheduler.activeCount).toBe(0);
  });

  it("reads the limit every time, so a settings change applies immediately", async () => {
    let limit = 1;
    const h = harness();
    const gates: Array<ReturnType<typeof deferred<HttpOutcome>>> = [];
    h.scripts.submit = () => {
      const gate = deferred<HttpOutcome>();
      gates.push(gate);
      return gate.promise;
    };
    const scheduler = new TaskScheduler(h.deps, { submitConcurrency: () => limit });
    const handles = Array.from({ length: 4 }, (_, index) =>
      scheduler.start({ prompt: `p${index}`, model: "nano-banana" }, () => undefined),
    );
    await flush();
    expect(h.state.order).toEqual(["p0"]);

    limit = 3;
    gates[0].resolve(notSent("x"));
    await flush();
    expect(h.state.order).toEqual(["p0", "p1", "p2", "p3"]);
    for (const gate of gates) gate.resolve(notSent("stop here"));
    await Promise.all(handles.map((handle) => handle.done));
    expect(h.state.maxInFlight).toBe(3);
  });
});
