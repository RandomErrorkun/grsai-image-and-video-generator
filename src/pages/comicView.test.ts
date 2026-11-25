import { describe, expect, it } from "vitest";
import { buildModelsListRequest, parseModelsListResponse, type ComicPage } from "../core/comicPlanner";
import {
  buildComicFinalPrompt,
  buildComicTaskSpec,
  formatReferenceTargets,
  parseDialogueLines,
  parseReferenceTargets,
  reorderComicPages,
} from "./comicView";

function samplePage(pageNumber: number): ComicPage {
  return {
    page_number: pageNumber,
    title: `Page ${pageNumber}`,
    story_beat: `Beat ${pageNumber}`,
    narration: "",
    dialogue: ["角色：台词"],
    scene_description: "",
    camera_direction: "",
    panel_layout: "",
    image_prompt: `Prompt ${pageNumber}`,
    reference_targets: [1],
  };
}

describe("comicView", () => {
  it("parses and formats reference targets with Chinese and English commas", () => {
    expect(parseReferenceTargets("1， 2, 1, 0, -3, abc, 3")).toEqual([1, 2, 3]);
    expect(formatReferenceTargets([1, 2, 3])).toBe("1,2,3");
    expect(parseDialogueLines("- 第一句\n• 第二句\n\n  第三句  ")).toEqual(["第一句", "第二句", "第三句"]);
  });

  it("reorders pages and renumbers them from 1", () => {
    const pages = [samplePage(1), samplePage(2), samplePage(3)];
    const moved = reorderComicPages(pages, 2, 0);
    expect(moved.map((p) => [p.page_number, p.title])).toEqual([
      [1, "Page 3"],
      [2, "Page 1"],
      [3, "Page 2"],
    ]);
  });

  it("builds task specs with the source double-prefix quirk and GPT pixel conversion", () => {
    const nano = buildComicTaskSpec({
      imageModel: "nano-banana-pro",
      aspectRatio: "3:4",
      imageSize: "2K",
      hasSizeOptions: true,
      pageNumber: 3,
      refImageUrls: ["C:\\ref.png"],
      outputDir: "C:\\out\\proj\\pages",
    });
    expect(nano).toEqual({
      model: "nano-banana-pro",
      aspectRatio: "3:4",
      imageSize: "2K",
      refImageUrls: ["C:\\ref.png"],
      outputDir: "C:\\out\\proj\\pages",
      filenamePrefix: "grsai_page_03",
    });

    const gptVip = buildComicTaskSpec({
      imageModel: "gpt-image-2-vip",
      aspectRatio: "3:4",
      imageSize: "1:1",
      hasSizeOptions: true,
      pageNumber: 1,
      refImageUrls: [],
      outputDir: "C:\\out\\proj\\pages",
    });
    expect(gptVip.aspectRatio).toBe("1024x1024");
    expect(gptVip.imageSize).toBe("auto");
    expect(gptVip.filenamePrefix).toBe("grsai_page_01");
  });

  it("assembles the final comic prompt matching the source wording", () => {
    const prompt = buildComicFinalPrompt(samplePage(2), {
      planTitle: "星际猫",
      planStyleNotes: "赛博朋克",
      hasReferenceImages: true,
    });
    expect(prompt).toContain("项目名：星际猫。");
    expect(prompt).toContain("这是漫画的第 2 页。");
    expect(prompt).toContain("参考图一");
    expect(prompt).toContain("全局画风与氛围：赛博朋克。");
    expect(prompt).toContain("Prompt 2");
  });

  it("builds and parses OpenAI-compatible /models requests for custom comic chat API", () => {
    const req = buildModelsListRequest("https://example.invalid/v1/", "sk-test");
    expect(req.method).toBe("GET");
    expect(req.url).toBe("https://example.invalid/v1/models");
    expect(req.headers.Authorization).toBe("Bearer sk-test");

    expect(
      parseModelsListResponse(200, JSON.stringify({ data: [{ id: "gpt-4o" }, { id: "claude-3" }, { id: "gpt-4o" }] })),
    ).toEqual({ ok: true, models: ["claude-3", "gpt-4o"] });
    expect(parseModelsListResponse(401, "unauthorized").ok).toBe(false);
  });
});
