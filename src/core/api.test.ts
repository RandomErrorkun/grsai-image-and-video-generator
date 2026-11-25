import { describe, expect, it } from "vitest";
import { buildGeneratePayload, type GenerateParams } from "./api";
import { videoMaxVideos, videoModelSpec } from "./modelCatalog";

const base: GenerateParams = {
  prompt: "a cat",
  model: "wan-3.0",
  aspectRatio: "16:9",
  imageSize: "720p",
  duration: 5,
  seed: 7,
};

describe("reference videos in the request body", () => {
  it("are objects with a url only for wan-3.0, which documents no other field", () => {
    const payload = buildGeneratePayload({ ...base, refVideos: ["https://ex/a.mp4"] });
    expect(payload?.videos).toEqual([{ url: "https://ex/a.mp4" }]);
  });

  it("carry startSeconds and requireAudio for agnes-video-2.5, one entry per video", () => {
    const payload = buildGeneratePayload({
      ...base,
      model: "agnes-video-2.5",
      imageSize: "720p",
      refVideos: ["https://ex/a.mp4", "https://ex/b.mp4"],
      videoOptions: [{ startSeconds: 3, requireAudio: true }, { requireAudio: false }],
    });
    expect(payload?.videos).toEqual([
      { url: "https://ex/a.mp4", startSeconds: 3, requireAudio: true },
      { url: "https://ex/b.mp4", requireAudio: false },
    ]);
  });

  it("leave startSeconds out when it is not given, so the server uses its default", () => {
    const payload = buildGeneratePayload({
      ...base,
      model: "agnes-video-2.5",
      refVideos: ["https://ex/a.mp4"],
      videoOptions: [{ startSeconds: null }],
    });
    expect(payload?.videos).toEqual([{ url: "https://ex/a.mp4", requireAudio: false }]);
  });

  it("never add the two extra fields to a model that does not take them", () => {
    const payload = buildGeneratePayload({
      ...base,
      refVideos: ["https://ex/a.mp4"],
      videoOptions: [{ startSeconds: 9, requireAudio: true }],
    });
    expect(payload?.videos).toEqual([{ url: "https://ex/a.mp4" }]);
  });

  it("are left out when there is no video", () => {
    expect(buildGeneratePayload({ ...base, refVideos: [] })).not.toHaveProperty("videos");
    expect(buildGeneratePayload({ ...base, refVideos: null })).not.toHaveProperty("videos");
  });

  it("match the limits written in the catalog", () => {
    expect(videoMaxVideos("minimax-h3")).toBe(0);
    expect(videoMaxVideos("wan-3.0")).toBe(5);
    expect(videoMaxVideos("agnes-video-2.5")).toBe(5);
    expect(videoModelSpec("wan-3.0").maxVideoSeconds).toBe(15);
    expect(videoModelSpec("wan-3.0").videoFields).toBeUndefined();
    expect(videoModelSpec("agnes-video-2.5").videoFields).toEqual(["startSeconds", "requireAudio"]);
  });
});
