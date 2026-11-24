import { describe, expect, it } from "vitest";
import {
  buildChatRequest,
  buildResultRequest,
  buildSubmitRequest,
  parseChatResponse,
  parseSubmitResponse,
  parseTaskResult,
  type GenerateParams,
  type HttpOutcome,
  type LocalFiles,
  type SubmitResult,
} from "../core/api";
import { buildPlanningMessages, parseComicPlan } from "../core/comicPlanner";
import { createPathTools } from "../core/paths";
import { createMemoryFs } from "./memoryFs";
import { createMockHttp, MOCK_RESULT_SCHEME } from "./mockApi";

const DATA_DIR = "C:\\mock-data";
const paths = createPathTools("\\");
const SETTINGS = { apiBaseUrl: "https://example.test", apiKey: "secret" };
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function setup() {
  let clock = 1_000_000;
  const fs = createMemoryFs(paths, DATA_DIR);
  const written: Array<{ path: string; mime: string }> = [];
  const images: Array<{ label: string; width: number; height: number }> = [];
  const api = createMockHttp({
    fs,
    paths,
    makeImage: async (label, width, height) => {
      images.push({ label, width, height });
      return PNG_BYTES;
    },
    onWritten: (path, _bytes, mime) => {
      written.push({ path, mime });
    },
    now: () => clock,
    sleep: async () => {},
    log: () => {},
  });

  /** 提交一个任务，成功时返回服务端任务 id，否则返回原始结果。 */
  const submit = async (
    prompt: string,
    params: Partial<GenerateParams> = {},
  ): Promise<string | HttpOutcome | SubmitResult> => {
    const outcome = await api.request(buildSubmitRequest({ prompt, model: "nano-banana", ...params }, SETTINGS));
    if (outcome.outcome !== "responded") return outcome;
    const parsed = parseSubmitResponse(outcome.status, outcome.body);
    return parsed.code === 0 ? String(parsed.data.id) : parsed;
  };
  const query = async (id: string) => {
    const outcome = await api.request(buildResultRequest(id, SETTINGS));
    if (outcome.outcome !== "responded") throw new Error(`query was not answered: ${outcome.message}`);
    return { outcome, result: parseTaskResult(outcome.status, outcome.body) };
  };
  const advance = (ms: number) => {
    clock += ms;
  };
  /** 提交、等到跑完、取回最终状态里的 results。 */
  const finish = async (prompt: string, params: Partial<GenerateParams> = {}) => {
    const id = await submit(prompt, params);
    if (typeof id !== "string") throw new Error(`submit failed: ${JSON.stringify(id)}`);
    advance(120_000);
    const { result } = await query(id);
    if (result.code !== 0) throw new Error(result.error);
    return result.data;
  };

  return { api, fs, written, images, submit, query, advance, finish };
}

describe("mock api", () => {
  it("takes a submission from running to succeeded and serves the result file", async () => {
    const h = setup();
    const id = await h.submit("a cat", { aspectRatio: "16:9" });
    expect(id).toBe("mock-000001");
    const taskId = String(id);

    expect((await h.query(taskId)).result).toMatchObject({ code: 0, data: { id, status: "running", progress: 0 } });
    h.advance(3000);
    expect((await h.query(taskId)).result).toMatchObject({ code: 0, data: { status: "running", progress: 50 } });
    h.advance(3001);
    const final = await h.query(taskId);
    expect(final.outcome).toMatchObject({ outcome: "responded", status: 200 });
    expect(final.result).toEqual({
      code: 0,
      data: { id, status: "succeeded", progress: 100, results: [{ url: `${MOCK_RESULT_SCHEME}${id}/0.png` }] },
    });

    const target = "C:\\mock-data\\output\\grsai_x.png";
    const download = await h.api.download(`${MOCK_RESULT_SCHEME}${id}/0.png`, target);
    expect(download).toMatchObject({ outcome: "responded", status: 200 });
    expect([...(await h.fs.read(target))]).toEqual([...PNG_BYTES]);
    expect(h.written).toEqual([{ path: target, mime: "image/png" }]);
    // 假图照提交时的比例画，最长边 768
    expect(h.images).toEqual([{ label: "a cat", width: 768, height: 432 }]);
  });

  it("answers an unknown task id the way the real server does", async () => {
    const h = setup();
    const { outcome, result } = await h.query("no-such-task");
    expect(outcome).toMatchObject({ outcome: "responded", status: 404 });
    expect(result.code).toBe(-1);
    expect(result.code === -1 ? result.error : "").toContain("result not exist, valid for 2 hours");
  });

  it("walks through every outcome a prompt can ask for", async () => {
    const h = setup();
    const failed = await h.finish("a cat MOCK_FAIL");
    expect(failed).toMatchObject({ status: "failed", failure_reason: "Unknown" });
    expect(String(failed.error)).toContain("MOCK_FAIL");

    const violation = await h.finish("a cat MOCK_VIOLATION");
    expect(violation).toMatchObject({ status: "violation", failure_reason: "output_moderation" });

    const input = await h.finish("a cat MOCK_INPUT_BLOCK");
    expect(input).toMatchObject({ status: "violation", failure_reason: "input_moderation" });

    const empty = await h.finish("a cat MOCK_EMPTY");
    expect(empty).toMatchObject({ status: "succeeded", results: [] });

    const pair = await h.finish("a cat MOCK_PAIR");
    expect(pair.results).toEqual([
      { url: `${MOCK_RESULT_SCHEME}${pair.id}/0.png` },
      { url: `${MOCK_RESULT_SCHEME}${pair.id}/1.png` },
    ]);
  });

  it("serves videos as mp4 and loses the file when asked", async () => {
    const h = setup();
    const video = await h.finish("a clip", { model: "wan-3.0", aspectRatio: "16:9", duration: 5 });
    expect(video.results).toEqual([{ url: `${MOCK_RESULT_SCHEME}${video.id}/0.mp4` }]);
    const target = "C:\\mock-data\\output\\grsai_v.mp4";
    expect(await h.api.download(`${MOCK_RESULT_SCHEME}${video.id}/0.mp4`, target)).toMatchObject({ status: 200 });
    expect(h.written).toEqual([{ path: target, mime: "video/mp4" }]);
    expect(h.images).toEqual([]);

    const gone = await h.finish("a cat MOCK_NOFILE");
    const url = (gone.results as Array<{ url: string }>)[0].url;
    expect(await h.api.download(url, target)).toMatchObject({ outcome: "responded", status: 404 });

    expect(await h.api.download("mock-result://nope/0.png", target)).toMatchObject({ status: 404 });
    expect(await h.api.download("https://elsewhere/x.png", target)).toMatchObject({ status: 404 });
  });

  it("reports submission problems without creating a task", async () => {
    const h = setup();
    expect(await h.submit("a cat MOCK_OFFLINE")).toEqual({ outcome: "not_sent", message: expect.stringContaining("MOCK_OFFLINE") });
    expect(await h.submit("a cat MOCK_UNKNOWN")).toEqual({
      outcome: "unknown",
      status: null,
      message: expect.stringContaining("MOCK_UNKNOWN"),
    });
    const rejected = await h.submit("a cat MOCK_REJECT");
    expect(rejected).toEqual({ code: -1, msg: "mock: request rejected (MOCK_REJECT)", status: "failed" });
    // 三次都没建任务，所以下一个任务的序号还是 1
    expect(await h.submit("a cat")).toBe("mock-000001");
  });

  it("keeps a slow task running for a long while", async () => {
    const h = setup();
    const id = await h.submit("a cat MOCK_SLOW");
    h.advance(60_000);
    expect((await h.query(id as string)).result).toMatchObject({ code: 0, data: { status: "running", progress: 66 } });
    h.advance(30_001);
    expect((await h.query(id as string)).result).toMatchObject({ code: 0, data: { status: "succeeded" } });
  });

  it("only reacts to whole trigger words, in any letter case", async () => {
    const h = setup();
    const ordinary = await h.finish("a pair of shoes, an empty street, slow motion, unknown lands");
    expect(ordinary).toMatchObject({ status: "succeeded" });
    expect(ordinary.results).toHaveLength(1);

    const lowercase = await h.finish("a cat mock_fail");
    expect(lowercase).toMatchObject({ status: "failed" });
  });

  it("plans a comic with the requested page count, or fails on request", async () => {
    const h = setup();
    const noFiles: LocalFiles = { isFile: async () => false, read: async () => null };
    const messages = await buildPlanningMessages("一只猫走丢了", "", 4, null, noFiles, "zh");
    const outcome = await h.api.request(
      buildChatRequest("gemini-3.1-pro", messages, { stream: false, temperature: 0.8 }, SETTINGS),
    );
    const chat = parseChatResponse(outcome.outcome === "responded" ? outcome.status : 0, outcome.outcome === "responded" ? outcome.body : "", "https://example.test");
    expect(chat.ok).toBe(true);
    const content = chat.ok ? (chat.data.choices as Array<{ message: { content: string } }>)[0].message.content : "";
    // 有两张参考图时，规划里的「参考图 1」才是有效目标
    const plan = parseComicPlan(content, 4, 2);
    expect(plan.pages.map((page) => page.page_number)).toEqual([1, 2, 3, 4]);
    expect(plan.pages[0]).toMatchObject({ dialogue: expect.any(Array), reference_targets: [1] });
    expect(plan.pages[0].image_prompt).toContain("一整页漫画");
    expect(parseComicPlan(content, 4).pages[0].reference_targets).toEqual([]);

    const failing = await h.api.request(
      buildChatRequest("gemini-3.1-pro", await buildPlanningMessages("一只猫 MOCK_FAIL", "", 2, null, noFiles, "zh"), { stream: false }, SETTINGS),
    );
    expect(fulfilling(failing)).toBe(false);
  });

  it("answers unknown paths with 404", async () => {
    const h = setup();
    const outcome = await h.api.request({ method: "GET", url: "https://example.test/v1/other", headers: {}, connectTimeoutSecs: 1, readTimeoutSecs: 1 });
    expect(outcome).toMatchObject({ outcome: "responded", status: 404 });
  });
});

function fulfilling(outcome: HttpOutcome): boolean {
  return outcome.outcome === "responded" && outcome.status >= 200 && outcome.status < 300;
}
