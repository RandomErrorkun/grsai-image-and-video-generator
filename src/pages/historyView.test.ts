import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../core/config";
import type { HistoryTask } from "../core/history";
import {
  CLEAR_ACTIONS,
  CLEAR_ORDER,
  capitalize,
  clampPage,
  confirmTextKey,
  errorPreview,
  hasDetailValue,
  hasResult,
  isVideoResult,
  modelLine,
  pageCount,
  pageSizeOf,
  statusTone,
} from "./historyView";

function task(overrides: Partial<HistoryTask> = {}): HistoryTask {
  return {
    id: "t-1",
    prompt: "a red apple",
    model: "nano-banana-pro",
    aspect_ratio: "1:1",
    image_size: "1K",
    ref_images: null,
    duration: null,
    seed: null,
    ref_audios: null,
    first_frame: null,
    last_frame: null,
    ref_videos: null,
    status: "succeeded",
    created_at: "2026-11-25 01:21:29",
    result_path: null,
    preview_url: null,
    failure_reason: null,
    error_message: null,
    updated_at: "2026-11-25 01:22:08",
    ...overrides,
  };
}

describe("isVideoResult", () => {
  it("按扩展名认视频，大小写不分", () => {
    expect(isVideoResult("C:\\out\\grsai_2026-11-25-01-24-11.mp4")).toBe(true);
    expect(isVideoResult("C:\\out\\clip.WEBM")).toBe(true);
    expect(isVideoResult("/tmp/a.mov")).toBe(true);
  });

  it("图片、没有扩展名的路径和空路径都不算", () => {
    expect(isVideoResult("C:\\out\\grsai_2026-11-25-01-21-29.png")).toBe(false);
    expect(isVideoResult("C:\\out\\a.mp4.txt")).toBe(false);
    expect(isVideoResult("C:\\out\\noext")).toBe(false);
    expect(isVideoResult(null)).toBe(false);
  });
});

describe("statusTone", () => {
  it("成功绿、失败和违规红、其余橙", () => {
    expect(statusTone("succeeded")).toBe("success");
    expect(statusTone("failed")).toBe("failed");
    expect(statusTone("violation")).toBe("failed");
    expect(statusTone("running")).toBe("other");
    expect(statusTone("")).toBe("other");
  });
});

describe("capitalize", () => {
  it("与 str.capitalize() 一致", () => {
    expect(capitalize("succeeded")).toBe("Succeeded");
    expect(capitalize("FAILED")).toBe("Failed");
    expect(capitalize("")).toBe("");
  });
});

describe("pageSizeOf", () => {
  it("正整数原样", () => {
    expect(pageSizeOf(5)).toBe(5);
    expect(pageSizeOf(100)).toBe(100);
  });

  it("与 getTasksPage 的钳制一致：向零取整、最少 1", () => {
    expect(pageSizeOf(0)).toBe(1);
    expect(pageSizeOf(-3)).toBe(1);
    expect(pageSizeOf(2.7)).toBe(2);
  });

  it("不是数字就用默认值", () => {
    for (const value of ["10", null, undefined, Number.NaN, true]) {
      expect(pageSizeOf(value)).toBe(DEFAULT_CONFIG.history_items_per_page);
    }
  });
});

describe("pageCount", () => {
  it("向上取整，没有记录时也是 1 页", () => {
    expect(pageCount(0, 5)).toBe(1);
    expect(pageCount(5, 5)).toBe(1);
    expect(pageCount(6, 5)).toBe(2);
    expect(pageCount(12, 5)).toBe(3);
    expect(pageCount(100, 100)).toBe(1);
  });
});

describe("clampPage", () => {
  it("页码夹在 1 到总页数之间", () => {
    expect(clampPage(0, 3)).toBe(1);
    expect(clampPage(2, 3)).toBe(2);
    expect(clampPage(4, 3)).toBe(3);
    expect(clampPage(7, 1)).toBe(1);
  });
});

describe("hasResult", () => {
  it("成功且有结果路径才有缩略图和打开文件夹", () => {
    const path = "C:\\out\\a.png";
    expect(hasResult(task({ status: "succeeded", result_path: path }))).toBe(true);
    expect(hasResult(task({ status: "succeeded", result_path: null }))).toBe(false);
    expect(hasResult(task({ status: "succeeded", result_path: "" }))).toBe(false);
    expect(hasResult(task({ status: "failed", result_path: path }))).toBe(false);
  });
});

describe("modelLine", () => {
  it("文字写死英文", () => {
    expect(modelLine(task({ model: "gpt-image-2", image_size: "16:9" }))).toBe("Model: gpt-image-2 | Size: 16:9");
  });

  it("视频任务带时长，向零取整", () => {
    expect(modelLine(task({ model: "wan-3.0", duration: 3 }))).toBe("Model: wan-3.0 | Size: 1K | 3s");
    expect(modelLine(task({ duration: 4.9 }))).toBe("Model: nano-banana-pro | Size: 1K | 4s");
  });

  it("没有时长、时长为 0 或不是数字时不带", () => {
    expect(modelLine(task({ duration: null }))).toBe("Model: nano-banana-pro | Size: 1K");
    expect(modelLine(task({ duration: 0 }))).toBe("Model: nano-banana-pro | Size: 1K");
  });

  it("空值照 Python 的 f-string 显示成 None", () => {
    expect(modelLine(task({ image_size: null as unknown as string }))).toBe("Model: nano-banana-pro | Size: None");
  });
});

describe("hasDetailValue", () => {
  it("None 和空串不列，0 要列", () => {
    expect(hasDetailValue(null)).toBe(false);
    expect(hasDetailValue(undefined)).toBe(false);
    expect(hasDetailValue("")).toBe(false);
    expect(hasDetailValue(0)).toBe(true);
    expect(hasDetailValue(42)).toBe(true);
    expect(hasDetailValue("12")).toBe(true);
  });
});

describe("errorPreview", () => {
  it("没有内容时是 null", () => {
    expect(errorPreview(null)).toBeNull();
    expect(errorPreview("")).toBeNull();
  });

  it("不超过 500 字符原样给出", () => {
    expect(errorPreview("x".repeat(500))).toEqual({ text: "x".repeat(500), truncated: false });
  });

  it("超过 500 字符只留前 500 个并标记截断", () => {
    expect(errorPreview("y".repeat(650))).toEqual({ text: "y".repeat(500), truncated: true });
  });
});

describe("clear actions", () => {
  it("工具栏顺序与源项目一致", () => {
    expect(CLEAR_ORDER).toEqual(["running", "failed", "violation", "all"]);
  });

  it("只有清空全部有第二次确认", () => {
    expect(CLEAR_ACTIONS.all.secondConfirmKey).toBe("history.clear_all_second_confirm");
    for (const kind of ["running", "failed", "violation"] as const) {
      expect(CLEAR_ACTIONS[kind].secondConfirmKey).toBeUndefined();
    }
  });

  it("第一轮用自己的确认文案；清空全部第二轮换成最终确认", () => {
    expect(confirmTextKey(CLEAR_ACTIONS.all, 1)).toBe("history.clear_all_confirm");
    expect(confirmTextKey(CLEAR_ACTIONS.all, 2)).toBe("history.clear_all_second_confirm");
    expect(confirmTextKey(CLEAR_ACTIONS.failed, 1)).toBe("history.clear_failed_confirm");
    expect(confirmTextKey(CLEAR_ACTIONS.failed, 2)).toBe("history.clear_failed_confirm");
  });
});
