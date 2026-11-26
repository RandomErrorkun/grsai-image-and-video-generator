import { describe, expect, it } from "vitest";
import type { HttpOutcome } from "./api";
import {
  GRSAI_MODELS_URL,
  buildAnnouncementsPageRequest,
  buildModelsPageRequest,
  parseAnnouncementsHtml,
  parseModelsAvailabilityHtml,
  resolveGrsaiSiteOrigin,
  resolveModelAvailability,
} from "./modelAvailability";
import { createModelAvailabilityStore } from "../state/modelAvailability";

function makeRscHtml(models: unknown[]): string {
  const payload = `8:["$","$L10",null,{"initialModels":${JSON.stringify(models)}}]`;
  const escaped = JSON.stringify(payload).slice(1, -1);
  return `<!DOCTYPE html><html><body><script>self.__next_f.push([1,"${escaped}"])</script></body></html>`;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("modelAvailability parser", () => {
  it("parses structured model availability from Next.js RSC payload", () => {
    const html = makeRscHtml([
      { name: "wan-3.0", closeModel: false, maintenance: "", type: "video" },
      { name: "nano-banana-2-lite", closeModel: true, maintenance: "该模型维护中", type: "image" },
      { name: "gpt-image-2.6-sunburst", closeModel: false, maintenance: "模型维护中", type: "image" },
      { name: "closed-no-msg", closeModel: true, maintenance: "", type: "image" },
    ]);

    const parsed = parseModelsAvailabilityHtml(html);
    expect(parsed).not.toBeNull();
    expect(parsed!.get("wan-3.0")).toEqual({ status: "available" });
    expect(parsed!.get("nano-banana-2-lite")).toEqual({ status: "unavailable", maintenance: "该模型维护中" });
    expect(parsed!.get("gpt-image-2.6-sunburst")).toEqual({ status: "unavailable", maintenance: "模型维护中" });
    expect(parsed!.get("closed-no-msg")).toEqual({ status: "unavailable" });
  });

  it("falls back to SSR HTML <h4> cards when RSC payload is absent", () => {
    const html = `
      <div class="card"><h4>wan-3.0</h4><span>失败返还</span></div>
      <div class="card"><h4>nano-banana-fast</h4><span>维护中</span></div>
    `;
    const parsed = parseModelsAvailabilityHtml(html);
    expect(parsed).not.toBeNull();
    expect(parsed!.get("wan-3.0")).toEqual({ status: "available" });
    expect(parsed!.get("nano-banana-fast")).toEqual({ status: "unavailable", maintenance: "维护中" });
  });

  it("returns null on unparseable / empty pages", () => {
    expect(parseModelsAvailabilityHtml("")).toBeNull();
    expect(parseModelsAvailabilityHtml("<html><body>error</body></html>")).toBeNull();
  });

  it("resolves unknown before load, available/maintenance after load, and unlisted when absent", () => {
    const emptySnap = { loaded: false, models: new Map() };
    expect(resolveModelAvailability("wan-3.0", emptySnap)).toEqual({ state: "unknown" });

    const models = parseModelsAvailabilityHtml(
      makeRscHtml([
        { name: "wan-3.0", closeModel: false, maintenance: "" },
        { name: "nano-banana-2-lite", closeModel: true, maintenance: "该模型维护中" },
      ]),
    )!;
    const loadedSnap = { loaded: true, models };
    expect(resolveModelAvailability("wan-3.0", loadedSnap)).toEqual({ state: "available", maintenance: undefined });
    expect(resolveModelAvailability("nano-banana-2-lite", loadedSnap)).toEqual({
      state: "unavailable",
      maintenance: "该模型维护中",
    });
    expect(resolveModelAvailability("nano-banana", loadedSnap)).toEqual({
      state: "unavailable",
      unlisted: true,
    });
  });

  it("builds a lightweight RSC GET request to https://grsai.ai/zh/models", () => {
    const req = buildModelsPageRequest();
    expect(req.method).toBe("GET");
    expect(req.url).toBe(GRSAI_MODELS_URL);
    expect(req.headers.RSC).toBe("1");

    expect(resolveGrsaiSiteOrigin("grsai.ai")).toBe("https://grsai.ai");
    expect(resolveGrsaiSiteOrigin("https://grsai.com/zh/models")).toBe("https://grsai.com");
    expect(resolveGrsaiSiteOrigin("   ")).toBe("https://grsai.ai");
    expect(buildModelsPageRequest("grsai.com").url).toBe("https://grsai.com/zh/models");

    const annZh = buildAnnouncementsPageRequest("grsai.ai", "zh");
    expect(annZh.url).toBe("https://grsai.ai/zh/announcements");
    expect(annZh.headers.RSC).toBeUndefined();
    expect(buildAnnouncementsPageRequest("https://grsai.com/", "en").url).toBe("https://grsai.com/en/announcements");
  });

  it("parses official announcements from SSR <article> cards", () => {
    const html = `
      <main>
        <article class="card">
          <div class="bg-emerald-500"></div>
          <span class="bg-rose-50">NEW</span>
          <h3>新模型上线</h3>
          <time>2026-11-26 10:00</time>
          <p>支持 wan-3.0 视频生成。</p>
          <p>查看详情请访问文档。</p>
          <a href="/zh/models">查看模型</a>
          <a href="https://example.com/guide">使用指南</a>
        </article>
        <article class="card">
          <div class="bg-amber-500"></div>
          <h3>维护通知 &amp; 升级</h3>
          <time>2026-11-25 18:00</time>
          <p>预计维护 10 分钟。</p>
        </article>
      </main>
    `;
    const items = parseAnnouncementsHtml(html, "https://grsai.ai");
    expect(items).not.toBeNull();
    expect(items).toHaveLength(2);
    expect(items![0]).toMatchObject({
      kind: "success",
      isNew: true,
      title: "新模型上线",
      date: "2026-11-26 10:00",
      paragraphs: ["支持 wan-3.0 视频生成。", "查看详情请访问文档。"],
      links: [
        { label: "查看模型", url: "https://grsai.ai/zh/models" },
        { label: "使用指南", url: "https://example.com/guide" },
      ],
    });
    expect(items![1]).toMatchObject({
      kind: "warning",
      isNew: false,
      title: "维护通知 & 升级",
      date: "2026-11-25 18:00",
      paragraphs: ["预计维护 10 分钟。"],
      links: [],
    });
  });

  it("parses direct RSC flight stream with pricing metadata", () => {
    const rsc = `5:["$","div",null,{"models":[{"name":"wan-3.0","type":"video","cost":0,"video":{"480p":2700,"720p":5400},"errorReturn":true,"violationReturn":true,"closeModel":false,"maintenance":""},{"name":"nano-banana-pro-cl","type":"image","cost":10000,"errorReturn":true,"violationReturn":false,"closeModel":false,"maintenance":""}]}]`;
    const parsed = parseModelsAvailabilityHtml(rsc);
    expect(parsed?.get("wan-3.0")).toEqual({
      status: "available",
      pricing: {
        type: "video",
        cost: 0,
        videoPerSecond: { "480p": 2700, "720p": 5400 },
        errorReturn: true,
        violationReturn: true,
      },
    });
    expect(parsed?.get("nano-banana-pro-cl")).toEqual({
      status: "available",
      pricing: {
        type: "image",
        cost: 10000,
        errorReturn: true,
        violationReturn: false,
      },
    });
  });
});

describe("modelAvailability store", () => {
  it("coalesces concurrent refreshes, enforces cooldown, and preserves cached state on failure", async () => {
    let currentTime = 100_000;
    let calls = 0;
    const gate = deferred<HttpOutcome>();
    const sampleHtml = makeRscHtml([
      { name: "wan-3.0", closeModel: false, maintenance: "" },
      { name: "nano-banana-2-lite", closeModel: true, maintenance: "该模型维护中" },
    ]);

    let nextOutcome: () => Promise<HttpOutcome> = () => gate.promise;
    const store = createModelAvailabilityStore({
      request: () => {
        calls += 1;
        return nextOutcome();
      },
      now: () => currentTime,
      cooldownMs: 15_000,
    });

    // 并发点击 4 次只发 1 次请求
    const batch = [store.refresh(), store.refresh(), store.refresh(), store.refresh()];
    expect(store.getSnapshot().loading).toBe(true);
    gate.resolve({ outcome: "responded", status: 200, body: sampleHtml });
    const [first, ...rest] = await Promise.all(batch);
    expect(first).toEqual({ kind: "ok", total: 2, available: 1, unavailable: 1 });
    expect(rest).toEqual([{ kind: "in_flight" }, { kind: "in_flight" }, { kind: "in_flight" }]);
    expect(calls).toBe(1);
    expect(store.getSnapshot().loaded).toBe(true);

    // 5 秒后再次点击命中冷却，不发请求
    currentTime += 5_000;
    expect(await store.refresh()).toEqual({ kind: "cooldown", remainingSeconds: 10 });
    expect(calls).toBe(1);

    // 冷却结束后若网络失败，保留之前成功拉取的缓存不被清空
    currentTime += 11_000;
    nextOutcome = async () => ({ outcome: "not_sent", message: "offline" });
    expect(await store.refresh()).toEqual({ kind: "error", message: "offline" });
    expect(calls).toBe(2);
    expect(store.getSnapshot().loaded).toBe(true);
    expect(store.getSnapshot().models.get("wan-3.0")).toEqual({ status: "available" });
  });
});
