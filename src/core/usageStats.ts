/**
 * 用量统计核心计算模块（纯 TypeScript，不依赖 React 与平台层）。
 *
 * - 内置从 Grsai 官网核对的默认模型积分价目表，并支持叠加实时同步回来的最新价格；
 * - 按 Grsai 计费规则计算每条历史任务的实际消耗积分（文本模型不参与统计，区分失败/违规返还与否）；
 * - 纯代码按公历推算任意年份的全年热力图日历矩阵（每列 7 格，周日到周六，含闰年）；
 * - 汇总总用量、类型/模型分布扇形图数据，以及最近 7 天 / 30 天 / 指定时间段的折线图与分模型堆积柱状图数据。
 */
import type { HistoryTask, UsageLedgerRecord } from "./history";
import type { ModelAvailabilityEntry, ModelPricingInfo } from "./modelAvailability";
import {
  CHAT_MODELS,
  LEGACY_IMAGE_MODEL_ALIASES,
  VIDEO_MODEL_SET,
  videoDefaultResolution,
} from "./modelCatalog";

/** 文本模型集合：不参与图像/视频用量统计。 */
const TEXT_MODEL_SET: ReadonlySet<string> = new Set<string>(CHAT_MODELS);

/** 与 TaskList 一致的违规类失败原因集合。 */
const MODERATION_REASONS: ReadonlySet<string> = new Set([
  "output_moderation",
  "input_moderation",
  "violation",
]);

/**
 * 内置默认模型积分表（2026-11-26 核自 https://grsai.ai/zh/models）。
 * 离线或尚未点击同步时可直接用于统计；同步官网后会被最新在线定价覆盖。
 */
export const DEFAULT_MODEL_PRICING: Readonly<Record<string, ModelPricingInfo>> = {
  // 视频模型（按秒计费）
  "wan-3.0": {
    type: "video",
    cost: 0,
    videoPerSecond: { "480p": 2700, "720p": 5400, "1080p": 10800 },
    errorReturn: true,
    violationReturn: true,
  },
  "minimax-h3": {
    type: "video",
    cost: 0,
    videoPerSecond: { "480p": 1000, "768p": 1400, "1080p": 3000 },
    errorReturn: true,
    violationReturn: true,
  },
  "agnes-video-2.5": {
    type: "video",
    cost: 0,
    videoPerSecond: { "720p": 2000, "1080p": 3400, "2k": 4600 },
    errorReturn: true,
    violationReturn: true,
  },
  // GPT Image 系列（按次计费）
  "gpt-image-2": { type: "image", cost: 600, errorReturn: true, violationReturn: true },
  "gpt-image-2-vip": { type: "image", cost: 2000, errorReturn: true, violationReturn: true },
  "gpt-image-2.5": { type: "image", cost: 600, errorReturn: true, violationReturn: true },
  "gpt-image-2.5-flare": { type: "image", cost: 2000, errorReturn: true, violationReturn: true },
  "gpt-image-2.5-sunburst": { type: "image", cost: 2400, errorReturn: true, violationReturn: true },
  "gpt-image-2.6": { type: "image", cost: 600, errorReturn: true, violationReturn: true },
  "gpt-image-2.6-flare": { type: "image", cost: 2000, errorReturn: true, violationReturn: true },
  "gpt-image-2.6-sunburst": { type: "image", cost: 2400, errorReturn: true, violationReturn: true },
  // Nano Banana 系列（按次计费；VIP / CL 渠道违规不返还积分）
  "nano-banana": { type: "image", cost: 440, errorReturn: true, violationReturn: true },
  "nano-banana-fast": { type: "image", cost: 440, errorReturn: true, violationReturn: true },
  "nano-banana-2-lite": { type: "image", cost: 440, errorReturn: true, violationReturn: true },
  "nano-banana-2": { type: "image", cost: 1200, errorReturn: true, violationReturn: true },
  "nano-banana-2.1": { type: "image", cost: 1200, errorReturn: true, violationReturn: true },
  "nano-banana-pro": { type: "image", cost: 1800, errorReturn: true, violationReturn: true },
  "nano-banana-pro-vt": { type: "image", cost: 1800, errorReturn: true, violationReturn: true },
  "nano-banana-2-cl": { type: "image", cost: 6000, errorReturn: true, violationReturn: false },
  "nano-banana-2-2k-cl": { type: "image", cost: 9000, errorReturn: true, violationReturn: false },
  "nano-banana-2-4k-cl": { type: "image", cost: 13000, errorReturn: true, violationReturn: false },
  "nano-banana-pro-cl": { type: "image", cost: 10000, errorReturn: true, violationReturn: false },
  "nano-banana-pro-vip": { type: "image", cost: 10000, errorReturn: true, violationReturn: false },
  "nano-banana-pro-4k-vip": { type: "image", cost: 18000, errorReturn: true, violationReturn: false },
};

/** 合并内置默认定价与从官网同步到的最新定价（官网定价优先）。 */
export function buildEffectivePricingMap(
  liveModels?: ReadonlyMap<string, ModelAvailabilityEntry> | null,
): Map<string, ModelPricingInfo> {
  const merged = new Map<string, ModelPricingInfo>(Object.entries(DEFAULT_MODEL_PRICING));
  if (liveModels) {
    for (const [name, entry] of liveModels.entries()) {
      if (entry.pricing) merged.set(name, entry.pricing);
    }
  }
  return merged;
}

export type UsageMediaKind = "image" | "video";

export interface UsageEntry {
  readonly taskId: string;
  /** 本地日期 YYYY-MM-DD。 */
  readonly date: string;
  readonly model: string;
  readonly kind: UsageMediaKind;
  readonly credits: number;
  readonly status: string;
  readonly charged: boolean;
}

/** 从历史记录的 created_at（YYYY-MM-DD HH:MM:SS）提取本地日期键 YYYY-MM-DD；格式异常返回 null。 */
export function taskDateKey(createdAt: string | null | undefined): string | null {
  if (!createdAt) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(createdAt.trim());
  return match ? match[1] : null;
}

/** 格式化本地 Date 为 YYYY-MM-DD。 */
export function formatDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 把 YYYY-MM-DD 解析为本地零点 Date；非法日期返回 null。 */
export function parseDateKey(key: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key.trim());
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return dt;
}

function normalizeModelName(raw: string): string {
  const trimmed = raw.trim();
  return Object.prototype.hasOwnProperty.call(LEGACY_IMAGE_MODEL_ALIASES, trimmed)
    ? LEGACY_IMAGE_MODEL_ALIASES[trimmed]
    : trimmed;
}

function unitCostForTask(task: HistoryTask, model: string, pricing: ModelPricingInfo): number {
  if (pricing.type === "video") {
    const table = pricing.videoPerSecond;
    if (!table) return 0;
    const resKey = (task.image_size ?? "").trim().toLowerCase();
    const fallbackRes = videoDefaultResolution(model).toLowerCase();
    const perSecond =
      table[resKey] ??
      table[fallbackRes] ??
      Object.values(table)[0] ??
      0;
    const duration =
      typeof task.duration === "number" && Number.isFinite(task.duration) && task.duration > 0
        ? Math.trunc(task.duration)
        : 5;
    return perSecond * duration;
  }
  return pricing.cost;
}

/**
 * 计算单条历史任务的实际计费积分。
 * 文本模型或无有效日期的记录返回 null（不参与统计）。
 */
export function calculateTaskUsage(
  task: HistoryTask,
  pricingMap: ReadonlyMap<string, ModelPricingInfo>,
): UsageEntry | null {
  const date = taskDateKey(task.created_at);
  if (!date) return null;
  const model = normalizeModelName(task.model || "");
  if (!model || TEXT_MODEL_SET.has(model)) return null;

  const pricing = pricingMap.get(model);
  if (pricing?.type === "text") return null;

  const kind: UsageMediaKind =
    pricing?.type === "video" || VIDEO_MODEL_SET.has(model) ? "video" : "image";

  const status = (task.status ?? "").toLowerCase();
  let charged = false;
  if (status === "succeeded") {
    charged = true;
  } else if (status === "violation") {
    charged = pricing ? !pricing.violationReturn : false;
  } else if (status === "failed") {
    const reason = (task.failure_reason ?? "").trim().toLowerCase();
    if (MODERATION_REASONS.has(reason)) {
      charged = pricing ? !pricing.violationReturn : false;
    } else {
      charged = pricing ? !pricing.errorReturn : false;
    }
  }

  const credits = charged && pricing ? unitCostForTask(task, model, pricing) : 0;
  return {
    taskId: task.id,
    date,
    model,
    kind,
    credits,
    status,
    charged: charged && credits > 0,
  };
}

/** 把全部历史任务汇总为参与统计的 UsageEntry 列表（剔除文本模型）。 */
export function collectUsageEntries(
  tasks: readonly HistoryTask[],
  pricingMap: ReadonlyMap<string, ModelPricingInfo>,
): UsageEntry[] {
  const entries: UsageEntry[] = [];
  for (const task of tasks) {
    const entry = calculateTaskUsage(task, pricingMap);
    if (entry) entries.push(entry);
  }
  return entries;
}

export interface DailyAggregate {
  readonly date: string;
  readonly credits: number;
  readonly count: number;
  readonly imageCredits: number;
  readonly videoCredits: number;
}

/** 按日期聚合计费积分与计费次数。 */
export function aggregateByDate(entries: readonly UsageEntry[]): Map<string, DailyAggregate> {
  const map = new Map<string, { credits: number; count: number; imageCredits: number; videoCredits: number }>();
  for (const entry of entries) {
    if (!entry.charged) continue;
    let bucket = map.get(entry.date);
    if (!bucket) {
      bucket = { credits: 0, count: 0, imageCredits: 0, videoCredits: 0 };
      map.set(entry.date, bucket);
    }
    bucket.credits += entry.credits;
    bucket.count += 1;
    if (entry.kind === "video") bucket.videoCredits += entry.credits;
    else bucket.imageCredits += entry.credits;
  }
  const result = new Map<string, DailyAggregate>();
  for (const [date, b] of map.entries()) {
    result.set(date, { date, ...b });
  }
  return result;
}

export interface HeatmapCell {
  readonly date: string;
  readonly month: number;
  readonly day: number;
  /** 0 = 周日 ... 6 = 周六 */
  readonly dayOfWeek: number;
  readonly credits: number;
  readonly count: number;
  /** 0..4 深浅等级（0 表示无消耗，1..4 对应主题色四档深浅）。 */
  readonly level: 0 | 1 | 2 | 3 | 4;
}

export interface HeatmapMonthLabel {
  /** 0..11（一月到十二月） */
  readonly month: number;
  readonly weekIndex: number;
}

export interface YearHeatmap {
  readonly year: number;
  /** 每列 7 格（下标 0 = 周日 .. 6 = 周六），不在该年范围内的格为 null。 */
  readonly weeks: ReadonlyArray<ReadonlyArray<HeatmapCell | null>>;
  readonly monthLabels: readonly HeatmapMonthLabel[];
  readonly totalCredits: number;
  readonly totalCount: number;
  readonly activeDays: number;
  readonly maxDailyCredits: number;
}

function intensityLevel(credits: number, thresholds: readonly [number, number, number]): 0 | 1 | 2 | 3 | 4 {
  if (credits <= 0) return 0;
  if (credits <= thresholds[0]) return 1;
  if (credits <= thresholds[1]) return 2;
  if (credits <= thresholds[2]) return 3;
  return 4;
}

/**
 * 纯代码生成指定公历年份的 GitHub Contributions 风格热力图矩阵：
 * - 每列 7 行，从上到下固定为 周日(0) -> 周六(6)；
 * - 从左到右完整覆盖 1 月 1 日到 12 月 31 日（自动处理平年 365 天 / 闰年 366 天）。
 */
export function buildYearHeatmap(
  year: number,
  dailyMap: ReadonlyMap<string, DailyAggregate>,
): YearHeatmap {
  const jan1 = new Date(year, 0, 1);
  const startOffset = jan1.getDay(); // 0=Sun..6=Sat
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const totalDays = isLeap ? 366 : 365;
  const totalWeeks = Math.ceil((startOffset + totalDays) / 7);

  // 先收集全年有消耗的日期，用四分位（>=4 活跃天）或线性四等分算颜色档位，防止单日极值压扁其余日子
  const positiveCredits: number[] = [];
  let totalCredits = 0;
  let totalCount = 0;
  let maxDailyCredits = 0;

  const rawDays: Array<{ date: string; month: number; day: number; dayOfWeek: number; weekIndex: number; credits: number; count: number }> = [];
  const monthLabels: HeatmapMonthLabel[] = [];
  const seenMonth = new Set<number>();

  for (let i = 0; i < totalDays; i += 1) {
    const dt = new Date(year, 0, 1 + i);
    const key = formatDateKey(dt);
    const agg = dailyMap.get(key);
    const credits = agg?.credits ?? 0;
    const count = agg?.count ?? 0;
    const weekIndex = Math.floor((startOffset + i) / 7);
    const dayOfWeek = dt.getDay();
    const month = dt.getMonth();

    if (!seenMonth.has(month)) {
      seenMonth.add(month);
      // 防止首列同时挤进两个月份标签（不会发生，但仍保证 weekIndex 递增）
      monthLabels.push({ month, weekIndex });
    }

    if (credits > 0) {
      positiveCredits.push(credits);
      totalCredits += credits;
      totalCount += count;
      if (credits > maxDailyCredits) maxDailyCredits = credits;
    }

    rawDays.push({ date: key, month, day: dt.getDate(), dayOfWeek, weekIndex, credits, count });
  }

  let thresholds: [number, number, number];
  if (positiveCredits.length >= 4) {
    positiveCredits.sort((a, b) => a - b);
    const at = (p: number) => positiveCredits[Math.min(positiveCredits.length - 1, Math.floor((positiveCredits.length - 1) * p))];
    thresholds = [at(0.25), at(0.5), at(0.75)];
  } else {
    thresholds = [maxDailyCredits * 0.25, maxDailyCredits * 0.5, maxDailyCredits * 0.75];
  }

  const weeks: Array<Array<HeatmapCell | null>> = Array.from({ length: totalWeeks }, () =>
    Array<HeatmapCell | null>(7).fill(null),
  );
  for (const item of rawDays) {
    weeks[item.weekIndex][item.dayOfWeek] = {
      date: item.date,
      month: item.month,
      day: item.day,
      dayOfWeek: item.dayOfWeek,
      credits: item.credits,
      count: item.count,
      level: intensityLevel(item.credits, thresholds),
    };
  }

  return {
    year,
    weeks,
    monthLabels,
    totalCredits,
    totalCount,
    activeDays: positiveCredits.length,
    maxDailyCredits,
  };
}

/** 从历史条目中提取所有出现过的年份（加上当前年），降序排列。 */
export function availableYears(entries: readonly UsageEntry[], currentYear: number): number[] {
  const years = new Set<number>([currentYear]);
  for (const entry of entries) {
    const y = Number(entry.date.slice(0, 4));
    if (Number.isInteger(y) && y >= 2000 && y <= 2100) years.add(y);
  }
  return [...years].sort((a, b) => b - a);
}

export interface DistributionSlice {
  readonly key: string;
  readonly credits: number;
  readonly count: number;
  /** 占总积分的比例（0..1）。 */
  readonly share: number;
}

/** 按生成类型（image / video）汇总分布，用于扇形图。 */
export function buildTypeDistribution(entries: readonly UsageEntry[]): DistributionSlice[] {
  let imageCredits = 0;
  let imageCount = 0;
  let videoCredits = 0;
  let videoCount = 0;
  for (const entry of entries) {
    if (!entry.charged) continue;
    if (entry.kind === "video") {
      videoCredits += entry.credits;
      videoCount += 1;
    } else {
      imageCredits += entry.credits;
      imageCount += 1;
    }
  }
  const total = imageCredits + videoCredits;
  if (total <= 0) return [];
  const slices: DistributionSlice[] = [];
  if (imageCredits > 0) slices.push({ key: "image", credits: imageCredits, count: imageCount, share: imageCredits / total });
  if (videoCredits > 0) slices.push({ key: "video", credits: videoCredits, count: videoCount, share: videoCredits / total });
  return slices.sort((a, b) => b.credits - a.credits);
}

export const OTHER_MODEL_KEY = "__other__";

/** 按模型汇总分布，最多保留 maxSlices 个主力模型，其余归入 OTHER_MODEL_KEY。 */
export function buildModelDistribution(entries: readonly UsageEntry[], maxSlices = 7): DistributionSlice[] {
  const map = new Map<string, { credits: number; count: number }>();
  let total = 0;
  for (const entry of entries) {
    if (!entry.charged) continue;
    total += entry.credits;
    const prev = map.get(entry.model);
    if (prev) {
      prev.credits += entry.credits;
      prev.count += 1;
    } else {
      map.set(entry.model, { credits: entry.credits, count: 1 });
    }
  }
  if (total <= 0) return [];
  const sorted = [...map.entries()].sort((a, b) => b[1].credits - a[1].credits);
  const slices: DistributionSlice[] = [];
  let otherCredits = 0;
  let otherCount = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    const [key, stat] = sorted[i];
    if (i < maxSlices || sorted.length === maxSlices + 1) {
      slices.push({ key, credits: stat.credits, count: stat.count, share: stat.credits / total });
    } else {
      otherCredits += stat.credits;
      otherCount += stat.count;
    }
  }
  if (otherCredits > 0) {
    slices.push({ key: OTHER_MODEL_KEY, credits: otherCredits, count: otherCount, share: otherCredits / total });
  }
  return slices;
}

export type RangePreset = "7d" | "30d" | "all" | "custom";

/** 计算预设时间段对应的起止日期键（含首尾两天）。 */
export function resolvePresetRange(preset: "7d" | "30d", today: Date = new Date()): { start: string; end: string } {
  const days = preset === "7d" ? 7 : 30;
  const endDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - (days - 1));
  return { start: formatDateKey(startDate), end: formatDateKey(endDate) };
}

/** 计算「全部记录」对应的起止日期键（最早记录日 ~ 最新记录日与今天较晚者；无记录时回退最近 30 天）。 */
export function resolveAllRecordsRange(
  entries: readonly UsageEntry[],
  today: Date = new Date(),
): { start: string; end: string } {
  let minDate: string | null = null;
  let maxDate: string | null = null;
  for (const entry of entries) {
    if (!entry.charged) continue;
    if (minDate === null || entry.date < minDate) minDate = entry.date;
    if (maxDate === null || entry.date > maxDate) maxDate = entry.date;
  }
  if (!minDate || !maxDate) return resolvePresetRange("30d", today);
  const todayKey = formatDateKey(new Date(today.getFullYear(), today.getMonth(), today.getDate()));
  return { start: minDate, end: maxDate >= todayKey ? maxDate : todayKey };
}

/** 按起止日期（含首尾）过滤用量记录，自动兼容起止颠倒的情况。 */
export function filterEntriesByRange(
  entries: readonly UsageEntry[],
  startKey: string,
  endKey: string,
): UsageEntry[] {
  const start = startKey <= endKey ? startKey : endKey;
  const end = startKey <= endKey ? endKey : startKey;
  return entries.filter((entry) => entry.date >= start && entry.date <= end);
}

export interface DailySeriesPoint {
  readonly date: string;
  readonly totalCredits: number;
  readonly totalCount: number;
  readonly byModel: Readonly<Record<string, number>>;
}

export interface DailyUsageSeries {
  readonly start: string;
  readonly end: string;
  /** 参与堆积图图例的模型列表（按区间内总消耗降序，可能包含 OTHER_MODEL_KEY）。 */
  readonly models: readonly string[];
  readonly points: readonly DailySeriesPoint[];
  readonly totalCredits: number;
  readonly totalCount: number;
  readonly maxDailyCredits: number;
}

const MAX_RANGE_DAYS = 366;

/**
 * 构建指定日期区间（含首尾，最长 366 天）的逐日用量序列，同时服务于折线图与分模型堆积柱状图。
 * 区间内无消耗的日期也会补 0，保证横轴连续均匀。
 */
export function buildDailyUsageSeries(
  entries: readonly UsageEntry[],
  startKey: string,
  endKey: string,
  maxModels = 6,
): DailyUsageSeries {
  const parsedStart = parseDateKey(startKey);
  const parsedEnd = parseDateKey(endKey);
  if (!parsedStart || !parsedEnd) {
    return { start: startKey, end: endKey, models: [], points: [], totalCredits: 0, totalCount: 0, maxDailyCredits: 0 };
  }
  let s = parsedStart <= parsedEnd ? parsedStart : parsedEnd;
  const e = parsedStart <= parsedEnd ? parsedEnd : parsedStart;

  // 防止用户输入跨十年的异常范围导致渲染几千根柱子
  const diffDays = Math.round((e.getTime() - s.getTime()) / 86_400_000) + 1;
  if (diffDays > MAX_RANGE_DAYS) {
    const clamped = new Date(e);
    clamped.setDate(clamped.getDate() - (MAX_RANGE_DAYS - 1));
    s = clamped;
  }

  const startStr = formatDateKey(s);
  const endStr = formatDateKey(e);

  // 统计区间内各模型总消耗，决定堆积柱状图的图例顺序
  const modelTotals = new Map<string, number>();
  const filtered: UsageEntry[] = [];
  for (const entry of entries) {
    if (!entry.charged) continue;
    if (entry.date < startStr || entry.date > endStr) continue;
    filtered.push(entry);
    modelTotals.set(entry.model, (modelTotals.get(entry.model) ?? 0) + entry.credits);
  }

  const sortedModels = [...modelTotals.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
  const keepDirect = sortedModels.length <= maxModels + 1 ? sortedModels : sortedModels.slice(0, maxModels);
  const directSet = new Set(keepDirect);
  const hasOther = sortedModels.length > keepDirect.length;
  const models = hasOther ? [...keepDirect, OTHER_MODEL_KEY] : keepDirect;

  const dayBuckets = new Map<string, { totalCredits: number; totalCount: number; byModel: Record<string, number> }>();
  for (const entry of filtered) {
    let bucket = dayBuckets.get(entry.date);
    if (!bucket) {
      bucket = { totalCredits: 0, totalCount: 0, byModel: {} };
      dayBuckets.set(entry.date, bucket);
    }
    bucket.totalCredits += entry.credits;
    bucket.totalCount += 1;
    const key = directSet.has(entry.model) ? entry.model : OTHER_MODEL_KEY;
    bucket.byModel[key] = (bucket.byModel[key] ?? 0) + entry.credits;
  }

  const points: DailySeriesPoint[] = [];
  let totalCredits = 0;
  let totalCount = 0;
  let maxDailyCredits = 0;

  const cursor = new Date(s);
  while (cursor <= e) {
    const key = formatDateKey(cursor);
    const bucket = dayBuckets.get(key);
    const dayCredits = bucket?.totalCredits ?? 0;
    const dayCount = bucket?.totalCount ?? 0;
    totalCredits += dayCredits;
    totalCount += dayCount;
    if (dayCredits > maxDailyCredits) maxDailyCredits = dayCredits;
    points.push({
      date: key,
      totalCredits: dayCredits,
      totalCount: dayCount,
      byModel: bucket?.byModel ?? {},
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  return {
    start: startStr,
    end: endStr,
    models,
    points,
    totalCredits,
    totalCount,
    maxDailyCredits,
  };
}

/** 把独立用量台账 usage_events 中的行转为 UsageEntry 列表，供各统计图表直接消费。 */
export function ledgerToUsageEntries(records: readonly UsageLedgerRecord[]): UsageEntry[] {
  return records.map((row) => ({
    taskId: row.task_id,
    date: row.date,
    model: row.model,
    kind: row.kind === "video" ? "video" : "image",
    credits: row.credits,
    status: row.status,
    charged: row.credits > 0,
  }));
}

/**
 * 为模型下拉选项格式化最右侧展示的积分标签：
 * - 图像模型：如 "1,800 积分" / "1,800 pts"
 * - 视频模型：如 "2,700~10,800/秒" / "2,700~10,800/s"
 * 查不到定价时返回 null。
 */
export function formatModelCostTag(
  modelId: string,
  pricingMap: ReadonlyMap<string, ModelPricingInfo>,
  unitPerRun: string,
  unitPerSec: string,
): string | null {
  const normalized = normalizeModelName(modelId);
  const info = pricingMap.get(normalized);
  if (!info || info.type === "text") return null;
  if (info.type === "video" && info.videoPerSecond) {
    const values = Object.values(info.videoPerSecond).filter((v) => v > 0);
    if (values.length === 0) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    return min === max
      ? `${formatCredits(min)}${unitPerSec}`
      : `${formatCredits(min)}~${formatCredits(max)}${unitPerSec}`;
  }
  if (info.cost > 0) return `${formatCredits(info.cost)} ${unitPerRun}`;
  return null;
}

/** 格式化完整积分数字（千分位）。 */
export function formatCredits(credits: number): string {
  return Math.round(credits).toLocaleString("en-US");
}

/** 格式化坐标轴用的紧凑积分数字（12.4k / 1.2M）。 */
export function formatCompactCredits(credits: number): string {
  if (credits >= 1_000_000) return `${(credits / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (credits >= 1_000) return `${(credits / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.round(credits));
}
