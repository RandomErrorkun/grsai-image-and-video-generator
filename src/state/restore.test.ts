import { describe, expect, it, vi } from "vitest";
import type { HistoryTask } from "../core/history";
import { VIDEO_MODEL_IDS } from "../core/modelCatalog";
import { requestRestore, subscribeRestore, type RestoreRequest } from "./restore";

const task = (model: string): HistoryTask => ({
  id: "srv-1",
  prompt: "a cat",
  model,
  aspect_ratio: "1:1",
  image_size: "1K",
  ref_images: null,
  duration: null,
  seed: null,
  ref_audios: null,
  first_frame: null,
  last_frame: null,
  ref_videos: null,
  ref_video_options: null,
  status: "succeeded",
  created_at: "2026-11-25 01:21:29",
  result_path: null,
  preview_url: null,
  thumbnail: null,
  result_sha256: null,
  failure_reason: null,
  error_message: null,
  updated_at: "2026-11-25 01:21:29",
});

describe("history restore route", () => {
  it("sends video models to the video page and everything else to the generator page", () => {
    const seen: RestoreRequest[] = [];
    const unsubscribe = subscribeRestore((request) => seen.push(request));
    try {
      const models = [...VIDEO_MODEL_IDS, "nano-banana-2-lite", "gpt-image-2", "no-such-model"];
      for (const model of models) requestRestore(task(model));
      expect(seen.map((request) => [request.task.model, request.page])).toEqual([
        ["minimax-h3", "video"],
        ["agnes-video-2.5", "video"],
        ["wan-3.0", "video"],
        ["nano-banana-2-lite", "generator"],
        ["gpt-image-2", "generator"],
        ["no-such-model", "generator"],
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("hands every subscriber the same task and stops after unsubscribing", () => {
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = subscribeRestore(first);
    const stopSecond = subscribeRestore(second);
    const row = task("wan-3.0");

    requestRestore(row);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(second.mock.calls[0][0]).toEqual({ page: "video", task: row });
    expect(first.mock.calls[0][0].task).toBe(row);

    stopFirst();
    requestRestore(row);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    stopSecond();
  });

  it("does nothing when nobody is listening", () => {
    expect(() => requestRestore(task("nano-banana"))).not.toThrow();
  });
});
