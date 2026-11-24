/**
 * 浏览器 mock 用的假接口：把三个接口和结果下载都在内存里演一遍。
 * 只给单独跑 npm run dev 调界面用，碰不到真实接口，也就不产生费用。
 *
 * 提示词里带上这些词可以走到各种下场（不区分大小写，按整词匹配）：
 *   MOCK_FAIL 失败；MOCK_VIOLATION 输出违规；MOCK_INPUT_BLOCK 输入违规；
 *   MOCK_OFFLINE 提交没连上；MOCK_UNKNOWN 提交已发出但结果不明；MOCK_REJECT 提交被服务端拒绝；
 *   MOCK_EMPTY 成功但没有结果；MOCK_NOFILE 结果文件下载失败；MOCK_SLOW 跑得久；MOCK_PAIR 两个结果。
 * 漫画规划的消息里带 MOCK_FAIL 则规划失败。
 */
import { CHAT_COMPLETIONS_PATH, GENERATE_PATH, RESULT_PATH, type HttpOutcome, type HttpRequest } from "../core/api";
import { VIDEO_MODEL_SET } from "../core/modelCatalog";
import type { PathTools } from "../core/paths";
import type { FileSystemApi, HttpApi } from "./types";

/** 假结果文件的地址，下载时按这个格式认出来。 */
export const MOCK_RESULT_SCHEME = "mock-result://";

/** 假任务跑多久：视频比图像慢，MOCK_SLOW 用来调进度环。 */
const IMAGE_DURATION_MS = 6000;
const VIDEO_DURATION_MS = 14000;
const SLOW_DURATION_MS = 90000;

/** 各请求装出来的耗时。 */
const SUBMIT_DELAY_MS = 400;
const QUERY_DELAY_MS = 120;
const DOWNLOAD_DELAY_MS = 300;
const CHAT_DELAY_MS = 1200;

type Trigger =
  | "FAIL"
  | "VIOLATION"
  | "INPUT_BLOCK"
  | "OFFLINE"
  | "UNKNOWN"
  | "REJECT"
  | "EMPTY"
  | "NOFILE"
  | "SLOW"
  | "PAIR";

const TRIGGER_PATTERN = /\bMOCK_([A-Z_]+)\b/gi;

export interface MockHttpDeps {
  fs: Pick<FileSystemApi, "makeDirs" | "write">;
  paths: PathTools;
  /** 画一张假图。浏览器里用 canvas，测试里换成固定字节。 */
  makeImage(label: string, width: number, height: number): Promise<Uint8Array>;
  /** 假结果落盘后回调；浏览器 mock 借它给文件登记页面里能用的地址。 */
  onWritten?(path: string, bytes: Uint8Array, mime: string): void;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  /** 每次提交、规划时的一行说明，默认打到控制台。 */
  log?(message: string): void;
}

interface MockJob {
  id: string;
  model: string;
  prompt: string;
  /** 提交时的比例，假图照它画。 */
  aspectRatio: string;
  createdAt: number;
  durationMs: number;
  triggers: Set<Trigger>;
}

const responded = (status: number, body: unknown): HttpOutcome => ({
  outcome: "responded",
  status,
  body: typeof body === "string" ? body : JSON.stringify(body),
});

function parseBody(body: string | undefined): Record<string, unknown> {
  if (!body) return {};
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function triggersIn(text: string): Set<Trigger> {
  const found = new Set<Trigger>();
  for (const match of text.matchAll(TRIGGER_PATTERN)) found.add(match[1].toUpperCase() as Trigger);
  return found;
}

/** 按比例给出假图的尺寸，最长边 768。 */
function imageSizeFor(aspect: string): [number, number] {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspect);
  const width = match ? Number(match[1]) : 1;
  const height = match ? Number(match[2]) : 1;
  const longest = 768;
  return width >= height
    ? [longest, Math.max(1, Math.round((longest * height) / width))]
    : [Math.max(1, Math.round((longest * width) / height)), longest];
}

/** 把消息里所有文本拼起来：content 可能是一段文本，也可能是带图文的数组。 */
function collectText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  const parts: string[] = [];
  for (const message of messages) {
    if (typeof message === "string") {
      parts.push(message);
      continue;
    }
    const content = (message as { content?: unknown } | null)?.content;
    if (typeof content === "string") parts.push(content);
    else if (Array.isArray(content)) {
      for (const item of content) {
        const text = (item as { text?: unknown } | null)?.text;
        if (typeof text === "string") parts.push(text);
      }
    }
  }
  return parts.join("\n");
}

/** 规划消息里写着「目标页数：N」。 */
function pageCountIn(text: string): number {
  const match = /目标页数[:：]\s*(\d+)/.exec(text);
  const count = match ? Number(match[1]) : 6;
  return Number.isInteger(count) && count > 0 ? Math.min(count, 40) : 6;
}

function comicPlan(pageCount: number, story: string): Record<string, unknown> {
  const pages = Array.from({ length: pageCount }, (_, index) => {
    const number = index + 1;
    return {
      page_number: number,
      title: `第 ${number} 页`,
      story_beat: `故事推进到第 ${number} 步：${story.slice(0, 20)}`,
      narration: "这是 mock 规划出来的旁白。",
      dialogue: [`角色甲：第 ${number} 页的对白。`, "角色乙：好的。"],
      scene_description: "傍晚的街道，路灯刚亮。",
      camera_direction: "中景，略微俯视。",
      panel_layout: number % 2 === 0 ? "三格上下排" : "两格对角排",
      reference_targets: [1],
      image_prompt: `一整页漫画，第 ${number} 格，傍晚的街道，路灯刚亮，黑白线稿加网点。`,
    };
  });
  return {
    title: "mock 漫画",
    style_notes: "黑白线稿，网点阴影。",
    pages,
  };
}

export function createMockHttp(deps: MockHttpDeps): HttpApi {
  const jobs = new Map<string, MockJob>();
  const now = () => (deps.now ?? (() => Date.now()))();
  const sleep = (ms: number) =>
    (deps.sleep ?? ((duration: number) => new Promise<void>((resolve) => setTimeout(resolve, duration))))(ms);
  const note = (message: string) => (deps.log ?? ((line: string) => console.info(`[mock api] ${line}`)))(message);

  async function submit(request: HttpRequest): Promise<HttpOutcome> {
    await sleep(SUBMIT_DELAY_MS);
    const body = parseBody(request.body);
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    const triggers = triggersIn(prompt);
    const model = typeof body.model === "string" ? body.model : "";

    if (triggers.has("OFFLINE")) {
      note("submit was not sent (MOCK_OFFLINE)");
      return { outcome: "not_sent", message: "mock: connection refused (MOCK_OFFLINE)" };
    }
    if (triggers.has("UNKNOWN")) {
      note("submit was sent but the answer was lost (MOCK_UNKNOWN)");
      return {
        outcome: "unknown",
        status: null,
        message: "mock: no answer came back after the request was sent (MOCK_UNKNOWN)",
      };
    }
    if (triggers.has("REJECT")) {
      note("submit rejected (MOCK_REJECT)");
      return responded(400, { status: "failed", error: "mock: request rejected (MOCK_REJECT)" });
    }

    const id = `mock-${String(jobs.size + 1).padStart(6, "0")}`;
    const durationMs = triggers.has("SLOW")
      ? SLOW_DURATION_MS
      : VIDEO_MODEL_SET.has(model)
        ? VIDEO_DURATION_MS
        : IMAGE_DURATION_MS;
    jobs.set(id, {
      id,
      model,
      prompt,
      aspectRatio: typeof body.aspectRatio === "string" ? body.aspectRatio : "1:1",
      createdAt: now(),
      durationMs,
      triggers,
    });
    note(`submitted ${id} (${model})`);
    return responded(200, { id });
  }

  async function query(request: HttpRequest): Promise<HttpOutcome> {
    await sleep(QUERY_DELAY_MS);
    const id = new URL(request.url).searchParams.get("id");
    const job = id ? jobs.get(id) : undefined;
    // 服务端对查不到的任务就是这样回答的
    if (!job) return responded(404, { error: "result not exist, valid for 2 hours" });

    const elapsed = now() - job.createdAt;
    if (elapsed < job.durationMs) {
      return responded(200, {
        id: job.id,
        status: "running",
        progress: Math.min(99, Math.floor((elapsed / job.durationMs) * 100)),
      });
    }

    if (job.triggers.has("FAIL")) {
      return responded(200, { id: job.id, status: "failed", progress: 100, failure_reason: "Unknown", error: "mock: generation failed (MOCK_FAIL)" });
    }
    if (job.triggers.has("VIOLATION") || job.triggers.has("INPUT_BLOCK")) {
      const reason = job.triggers.has("INPUT_BLOCK") ? "input_moderation" : "output_moderation";
      return responded(200, {
        id: job.id,
        status: "violation",
        progress: 100,
        failure_reason: reason,
        error: `mock: blocked by ${reason} (MOCK_${reason === "input_moderation" ? "INPUT_BLOCK" : "VIOLATION"})`,
      });
    }

    const total = job.triggers.has("EMPTY") ? 0 : job.triggers.has("PAIR") ? 2 : 1;
    const extension = VIDEO_MODEL_SET.has(job.model) ? "mp4" : "png";
    return responded(200, {
      id: job.id,
      status: "succeeded",
      progress: 100,
      results: Array.from({ length: total }, (_, index) => ({ url: `${MOCK_RESULT_SCHEME}${job.id}/${index}.${extension}` })),
    });
  }

  async function chat(request: HttpRequest): Promise<HttpOutcome> {
    await sleep(CHAT_DELAY_MS);
    const body = parseBody(request.body);
    const text = collectText(body.messages);
    if (triggersIn(text).has("FAIL")) {
      note("planning failed (MOCK_FAIL)");
      return responded(500, { error: { message: "mock: story model failed (MOCK_FAIL)" } });
    }
    const story = /故事需求[:：]\s*([\s\S]*?)\n\n/.exec(text)?.[1]?.trim() ?? "";
    const pageCount = pageCountIn(text);
    note(`planned ${pageCount} pages`);
    return responded(200, {
      id: "mock-chat",
      choices: [
        { index: 0, message: { role: "assistant", content: JSON.stringify(comicPlan(pageCount, story)) }, finish_reason: "stop" },
      ],
    });
  }

  async function request(request: HttpRequest): Promise<HttpOutcome> {
    const path = new URL(request.url).pathname;
    if (path === GENERATE_PATH) return submit(request);
    if (path === RESULT_PATH) return query(request);
    if (path === CHAT_COMPLETIONS_PATH) return chat(request);
    return responded(404, { error: `mock: unknown path ${path}` });
  }

  async function download(url: string, destPath: string): Promise<HttpOutcome> {
    await sleep(DOWNLOAD_DELAY_MS);
    const match = /^mock-result:\/\/([^/]+)\/(\d+)\.(\w+)$/.exec(url);
    const job = match ? jobs.get(match[1]) : undefined;
    if (!match || !job) return responded(404, "mock: unknown result url");
    if (job.triggers.has("NOFILE")) return responded(404, "mock: result file is gone (MOCK_NOFILE)");

    const extension = match[3];
    const isVideo = VIDEO_MODEL_SET.has(job.model);
    const [width, height] = imageSizeFor(job.aspectRatio);
    // 视频没有真片子可给，放一个说明文件，够试「打开结果」这条路
    const bytes = isVideo
      ? new TextEncoder().encode(`mock video for ${job.id}\nprompt: ${job.prompt}\n`)
      : await deps.makeImage(job.prompt, width, height);
    const mime = isVideo ? "video/mp4" : extension === "jpg" ? "image/jpeg" : "image/png";
    await deps.fs.makeDirs(deps.paths.dirname(destPath));
    await deps.fs.write(destPath, bytes);
    deps.onWritten?.(destPath, bytes, mime);
    return responded(200, "");
  }

  return { request, download };
}
