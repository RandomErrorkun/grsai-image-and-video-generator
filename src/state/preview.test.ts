import { describe, expect, it } from "vitest";
import { classifyPreviewMedia, normalizePreviewMode } from "./preview";

describe("preview state helpers", () => {
  it("classifies image, gif, svg, video, and unknown extensions", () => {
    expect(classifyPreviewMedia("C:\\out\\a.png")).toBe("image");
    expect(classifyPreviewMedia("C:\\out\\a.JPEG")).toBe("image");
    expect(classifyPreviewMedia("C:\\out\\a.webp")).toBe("image");
    expect(classifyPreviewMedia("C:\\out\\anim.GIF")).toBe("gif");
    expect(classifyPreviewMedia("C:\\out\\vector.svg")).toBe("svg");
    expect(classifyPreviewMedia("C:\\out\\clip.mp4")).toBe("video");
    expect(classifyPreviewMedia("C:\\out\\clip.MOV")).toBe("video");
    expect(classifyPreviewMedia("C:\\out\\notes.txt")).toBe("other");
    expect(classifyPreviewMedia("")).toBe("other");
  });

  it("defaults preview mode to internal and accepts system", () => {
    expect(normalizePreviewMode("internal")).toBe("internal");
    expect(normalizePreviewMode("system")).toBe("system");
    expect(normalizePreviewMode(undefined)).toBe("internal");
    expect(normalizePreviewMode("other")).toBe("internal");
  });
});
