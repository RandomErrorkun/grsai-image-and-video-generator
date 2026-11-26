import { describe, expect, it } from "vitest";
import type { HistoryTask } from "./history";
import { parseModelsAvailabilityHtml } from "./modelAvailability";
import {
  OTHER_MODEL_KEY,
  aggregateByDate,
  buildDailyUsageSeries,
  buildEffectivePricingMap,
  buildModelDistribution,
  buildTypeDistribution,
  buildYearHeatmap,
  calculateTaskUsage,
  collectUsageEntries,
  filterEntriesByRange,
  formatModelCostTag,
  ledgerToUsageEntries,
  resolveAllRecordsRange,
  resolvePresetRange,
} from "./usageStats";

function task(overrides: Partial<HistoryTask> = {}): HistoryTask {
  return {
    id: "t-1",
    prompt: "test",
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
    ref_video_options: null,
    status: "succeeded",
    created_at: "2026-11-26 09:00:00",
    result_path: null,
    preview_url: null,
    thumbnail: null,
    result_sha256: null,
    failure_reason: null,
    error_message: null,
    updated_at: "2026-11-26 09:01:00",
    ...overrides,
  };
}

describe("usageStats credit calculation & refund rules", () => {
  const pricing = buildEffectivePricingMap();

  it("charges image per run and video per second by resolution", () => {
    const img = calculateTaskUsage(task({ model: "nano-banana-pro", status: "succeeded" }), pricing);
    expect(img).toMatchObject({ kind: "image", credits: 1800, charged: true });

    const vid = calculateTaskUsage(
      task({ id: "v-1", model: "wan-3.0", image_size: "1080p", duration: 10, status: "succeeded" }),
      pricing,
    );
    expect(vid).toMatchObject({ kind: "video", credits: 108000, charged: true });

    const agnes = calculateTaskUsage(
      task({ id: "v-2", model: "agnes-video-2.5", image_size: "2K", duration: 6, status: "succeeded" }),
      pricing,
    );
    expect(agnes).toMatchObject({ kind: "video", credits: 4600 * 6, charged: true });
  });

  it("respects errorReturn and violationReturn refund policies", () => {
    // 普通模型违规与失败均返还 -> 0 积分
    expect(calculateTaskUsage(task({ model: "nano-banana-pro", status: "violation" }), pricing)).toMatchObject({
      credits: 0,
      charged: false,
    });
    expect(calculateTaskUsage(task({ model: "nano-banana-pro", status: "failed" }), pricing)).toMatchObject({
      credits: 0,
      charged: false,
    });

    // VIP/CL 模型违规不返还（violationReturn: false）-> 扣全额；普通失败返还 -> 0
    expect(calculateTaskUsage(task({ model: "nano-banana-pro-cl", status: "violation" }), pricing)).toMatchObject({
      credits: 10000,
      charged: true,
    });
    expect(
      calculateTaskUsage(
        task({ model: "nano-banana-pro-vip", status: "failed", failure_reason: "output_moderation" }),
        pricing,
      ),
    ).toMatchObject({ credits: 10000, charged: true });
    expect(
      calculateTaskUsage(
        task({ model: "nano-banana-pro-vip", status: "failed", failure_reason: "Unknown" }),
        pricing,
      ),
    ).toMatchObject({ credits: 0, charged: false });

    // 运行中不计费
    expect(calculateTaskUsage(task({ model: "nano-banana-pro", status: "running" }), pricing)).toMatchObject({
      credits: 0,
      charged: false,
    });
  });

  it("excludes text models and lets live synced pricing override defaults", () => {
    expect(calculateTaskUsage(task({ model: "gemini-3.1-pro" }), pricing)).toBeNull();

    const live = parseModelsAvailabilityHtml(
      `1:["$","div",null,{"models":[{"name":"nano-banana-pro","type":"image","cost":2500,"errorReturn":false,"violationReturn":true,"closeModel":false,"maintenance":""},{"name":"gpt-6.2-sol","type":"text","cost":100,"errorReturn":true,"violationReturn":true,"closeModel":false,"maintenance":""}]}]`,
    );
    const merged = buildEffectivePricingMap(live);
    expect(calculateTaskUsage(task({ model: "gpt-6.2-sol" }), merged)).toBeNull();
    // 覆盖为 2500 且 errorReturn: false
    expect(calculateTaskUsage(task({ model: "nano-banana-pro", status: "failed" }), merged)).toMatchObject({
      credits: 2500,
      charged: true,
    });
  });
});

describe("usageStats yearly heatmap calendar", () => {
  it("computes exact Sun..Sat grid layout for both normal (365d) and leap (366d) years", () => {
    // 2026-01-01 是星期四 (getDay() === 4)，平年 365 天
    const daily2026 = new Map([
      ["2026-01-01", { date: "2026-01-01", credits: 1800, count: 1, imageCredits: 1800, videoCredits: 0 }],
      ["2026-12-31", { date: "2026-12-31", credits: 5400, count: 1, imageCredits: 0, videoCredits: 5400 }],
    ]);
    const h2026 = buildYearHeatmap(2026, daily2026);
    expect(h2026.monthLabels).toHaveLength(12);
    expect(h2026.weeks[0][0]).toBeNull();
    expect(h2026.weeks[0][3]).toBeNull();
    expect(h2026.weeks[0][4]?.date).toBe("2026-01-01");
    expect(h2026.weeks[0][4]?.dayOfWeek).toBe(4);
    const allCells2026 = h2026.weeks.flat().filter(Boolean);
    expect(allCells2026).toHaveLength(365);
    expect(h2026.totalCredits).toBe(7200);
    expect(h2026.activeDays).toBe(2);

    // 2024 是闰年 366 天，2024-01-01 是星期一 (getDay() === 1)
    const h2024 = buildYearHeatmap(2024, new Map());
    expect(h2024.weeks[0][0]).toBeNull();
    expect(h2024.weeks[0][1]?.date).toBe("2024-01-01");
    expect(h2024.weeks.flat().filter(Boolean)).toHaveLength(366);
  });
});

describe("usageStats distributions and daily series", () => {
  it("builds type distribution, model distribution, and continuous daily stacked series", () => {
    const pricing = buildEffectivePricingMap();
    const tasks: HistoryTask[] = [
      task({ id: "1", model: "nano-banana-pro", created_at: "2026-11-24 10:00:00" }), // 1800
      task({ id: "2", model: "gpt-image-2.6", created_at: "2026-11-24 12:00:00" }), // 600
      task({ id: "3", model: "wan-3.0", image_size: "720p", duration: 5, created_at: "2026-11-26 15:00:00" }), // 27000
      task({ id: "4", model: "gemini-3.1-pro", created_at: "2026-11-25 10:00:00" }), // text -> ignored
    ];
    const entries = collectUsageEntries(tasks, pricing);
    expect(entries).toHaveLength(3);

    const byDate = aggregateByDate(entries);
    expect(byDate.get("2026-11-24")?.credits).toBe(2400);
    expect(byDate.get("2026-11-26")?.credits).toBe(27000);

    const types = buildTypeDistribution(entries);
    expect(types.map((s) => [s.key, s.credits])).toEqual([
      ["video", 27000],
      ["image", 2400],
    ]);

    const models = buildModelDistribution(entries, 1);
    // maxSlices = 1 且总模型数为 3 -> 保留 top 1 + __other__
    expect(models.map((s) => [s.key, s.credits])).toEqual([
      ["wan-3.0", 27000],
      [OTHER_MODEL_KEY, 2400],
    ]);

    const series = buildDailyUsageSeries(entries, "2026-11-24", "2026-11-26", 6);
    expect(series.points.map((p) => [p.date, p.totalCredits])).toEqual([
      ["2026-11-24", 2400],
      ["2026-11-25", 0],
      ["2026-11-26", 27000],
    ]);
    expect(series.points[0].byModel).toEqual({ "nano-banana-pro": 1800, "gpt-image-2.6": 600 });
    expect(series.models).toEqual(["wan-3.0", "nano-banana-pro", "gpt-image-2.6"]);

    expect(resolvePresetRange("7d", new Date(2026, 10, 26))).toEqual({
      start: "2026-11-20",
      end: "2026-11-26",
    });
    expect(resolveAllRecordsRange(entries, new Date(2026, 10, 26))).toEqual({
      start: "2026-11-24",
      end: "2026-11-26",
    });
    expect(filterEntriesByRange(entries, "2026-11-25", "2026-11-26").map((e) => e.taskId)).toEqual(["3"]);
    expect(filterEntriesByRange(entries, "2026-11-26", "2026-11-25").map((e) => e.taskId)).toEqual(["3"]);
  });

  it("formats model cost tags and converts persistent usage ledger records", () => {
    const pricing = buildEffectivePricingMap();
    expect(formatModelCostTag("nano-banana-pro", pricing, "积分", "/秒")).toBe("1,800 积分");
    expect(formatModelCostTag("wan-3.0", pricing, "pts", "/s")).toBe("2,700~10,800/s");
    expect(formatModelCostTag("gemini-3.1-pro", pricing, "pts", "/s")).toBeNull();

    const entries = ledgerToUsageEntries([
      {
        task_id: "u-1",
        date: "2026-11-26",
        model: "nano-banana-pro",
        kind: "image",
        credits: 1800,
        status: "succeeded",
        created_at: "2026-11-26 10:00:00",
        updated_at: "2026-11-26 10:01:00",
      },
      {
        task_id: "u-2",
        date: "2026-11-26",
        model: "nano-banana-pro",
        kind: "image",
        credits: 0,
        status: "failed",
        created_at: "2026-11-26 11:00:00",
        updated_at: "2026-11-26 11:01:00",
      },
    ]);
    expect(entries).toEqual([
      {
        taskId: "u-1",
        date: "2026-11-26",
        model: "nano-banana-pro",
        kind: "image",
        credits: 1800,
        charged: true,
        status: "succeeded",
      },
      {
        taskId: "u-2",
        date: "2026-11-26",
        model: "nano-banana-pro",
        kind: "image",
        credits: 0,
        charged: false,
        status: "failed",
      },
    ]);
  });
});
