/**
 * 从 Grsai 公开模型页（https://grsai.ai/zh/models）解析各模型的实时可用性与积分定价。
 *
 * 性能优化：请求携带 Next.js 的 `RSC: 1` 头，跳过完整 SSR HTML 渲染，响应体积由 ~250 KB 降至 ~48 KB、
 * 服务端 TTFB 减半；同时保留对完整 HTML（escaped RSC 与 <h4> 卡片）的兜底解析。
 * 纯函数实现，不碰网络与磁盘。
 */
import type { HttpRequest } from "./api";

export const DEFAULT_GRSAI_SITE_URL = "grsai.ai";
export const GRSAI_MODELS_URL = "https://grsai.ai/zh/models";

/**
 * 把用户填写的官网地址规整为 https://host（去掉尾部斜杠和多余路径）。
 * 支持填 `grsai.ai`、`https://grsai.ai`、`https://grsai.ai/zh/models` 等写法。
 */
export function resolveGrsaiSiteOrigin(raw: unknown): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  const candidate = text || DEFAULT_GRSAI_SITE_URL;
  const withScheme = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return `https://${DEFAULT_GRSAI_SITE_URL}`;
  }
}

export type ModelAvailabilityState = "available" | "unavailable" | "unknown";

export type RemoteModelType = "image" | "video" | "text";

export interface ModelPricingInfo {
  readonly type: RemoteModelType;
  /** 图像模型每次调用所需积分；视频模型按秒计费，见 videoPerSecond。 */
  readonly cost: number;
  /** 视频模型按分辨率区分的每秒积分（键统一转小写，如 "480p" / "720p" / "1080p" / "2k"）。 */
  readonly videoPerSecond?: Readonly<Record<string, number>>;
  /** 普通失败是否返还积分（true 表示失败不扣费）。 */
  readonly errorReturn: boolean;
  /** 违规是否返还积分（false 表示违规仍扣费，如 VIP/CL 系列）。 */
  readonly violationReturn: boolean;
}

export interface ModelAvailabilityEntry {
  readonly status: "available" | "unavailable";
  /** 维护提示文案（如「该模型维护中」），可用或无说明时为 undefined。 */
  readonly maintenance?: string;
  /** 从官网同步到的实时计费信息；HTML 兜底解析时可能缺失。 */
  readonly pricing?: ModelPricingInfo;
}

export interface ModelAvailabilitySnapshot {
  /** 是否已经成功从官网拉取过至少一次。 */
  readonly loaded: boolean;
  /** 正在拉取中。 */
  readonly loading: boolean;
  /** 最近一次成功拉取的时间戳（毫秒），未拉取过为 null。 */
  readonly fetchedAt: number | null;
  /** 官网页面上解析出来的全部模型（按模型名索引）。 */
  readonly models: ReadonlyMap<string, ModelAvailabilityEntry>;
}

export interface ResolvedModelAvailability {
  readonly state: ModelAvailabilityState;
  readonly maintenance?: string;
  /** 官网列表已加载但查不到该模型名（已下架）。 */
  readonly unlisted?: boolean;
}

/**
 * 构造拉取 Grsai 公开模型页的 GET 请求（无需登录与 API Key）。
 * 携带 `RSC: 1` 请求 Next.js 轻量 flight 数据流，避免服务端拼装 250 KB 完整 HTML。
 */
export function buildModelsPageRequest(siteUrl?: unknown): HttpRequest {
  const origin = resolveGrsaiSiteOrigin(siteUrl);
  return {
    method: "GET",
    url: `${origin}/zh/models`,
    headers: {
      Accept: "text/x-component, text/html",
      RSC: "1",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    connectTimeoutSecs: 15,
    readTimeoutSecs: 20,
  };
}

export type AnnouncementKind = "success" | "warning" | "info";

export interface AnnouncementLink {
  readonly label: string;
  readonly url: string;
}

export interface OfficialAnnouncement {
  readonly id: string;
  readonly kind: AnnouncementKind;
  readonly isNew: boolean;
  readonly title: string;
  readonly date: string;
  readonly paragraphs: readonly string[];
  readonly links: readonly AnnouncementLink[];
}

/** 构造拉取 Grsai 官方公告页的 GET 请求（SSR HTML 包含全部公告卡片）。 */
export function buildAnnouncementsPageRequest(siteUrl?: unknown, language: "en" | "zh" = "zh"): HttpRequest {
  const origin = resolveGrsaiSiteOrigin(siteUrl);
  const locale = language === "en" ? "en" : "zh";
  return {
    method: "GET",
    url: `${origin}/${locale}/announcements`,
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    connectTimeoutSecs: 15,
    readTimeoutSecs: 25,
  };
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<svg[\s\S]*?<\/svg>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  ).trim();
}

/** 解析 Grsai 公告页 SSR HTML 中的全部 <article> 公告卡片；解析不到返回 null。 */
export function parseAnnouncementsHtml(html: string, siteUrl?: unknown): OfficialAnnouncement[] | null {
  if (!html || typeof html !== "string") return null;
  const origin = resolveGrsaiSiteOrigin(siteUrl);
  const articles = [...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)];
  if (articles.length === 0) return null;

  const items: OfficialAnnouncement[] = [];
  for (let idx = 0; idx < articles.length; idx += 1) {
    const block = articles[idx][1];
    const titleMatch = /<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(block);
    const title = titleMatch ? stripTags(titleMatch[1]) : "";
    if (!title) continue;

    const timeMatch = /<time\b[^>]*>([\s\S]*?)<\/time>/i.exec(block);
    const date = timeMatch ? stripTags(timeMatch[1]) : "";

    const kind: AnnouncementKind = block.includes("bg-amber-")
      ? "warning"
      : block.includes("bg-sky-")
        ? "info"
        : "success";
    const isNew = block.includes("bg-rose-50");

    const paragraphs: string[] = [];
    for (const pMatch of block.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
      const text = stripTags(pMatch[1]);
      if (text) paragraphs.push(text);
    }

    const links: AnnouncementLink[] = [];
    const seenUrls = new Set<string>();
    for (const aMatch of block.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const rawHref = decodeHtmlEntities(aMatch[1]).trim();
      const url = rawHref.startsWith("/") ? `${origin}${rawHref}` : rawHref;
      const label = stripTags(aMatch[2]);
      if (url && label && !seenUrls.has(url)) {
        seenUrls.add(url);
        links.push({ label, url });
      }
    }

    items.push({
      id: `${date || idx}-${title.slice(0, 32)}`,
      kind,
      isNew,
      title,
      date,
      paragraphs,
      links,
    });
  }

  return items.length > 0 ? items : null;
}

/** 从文本的 start 位置起提取一对完整平衡的 JSON 方括号 [...]，忽略字符串内的括号。 */
function extractBalancedJsonArray(text: string, start: number): string | null {
  if (text[start] !== "[") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "[") {
      depth += 1;
    } else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parsePricing(record: Record<string, unknown>): ModelPricingInfo | undefined {
  const rawType = record.type;
  const type: RemoteModelType =
    rawType === "video" ? "video" : rawType === "text" ? "text" : "image";
  const cost = typeof record.cost === "number" && Number.isFinite(record.cost) ? record.cost : 0;
  let videoPerSecond: Record<string, number> | undefined;
  if (typeof record.video === "object" && record.video !== null && !Array.isArray(record.video)) {
    const entries: Record<string, number> = {};
    for (const [res, price] of Object.entries(record.video as Record<string, unknown>)) {
      if (typeof price === "number" && Number.isFinite(price) && price > 0) {
        entries[res.toLowerCase()] = price;
      }
    }
    if (Object.keys(entries).length > 0) videoPerSecond = entries;
  }
  if (cost === 0 && !videoPerSecond && type !== "text") return undefined;
  return {
    type,
    cost,
    ...(videoPerSecond ? { videoPerSecond } : {}),
    errorReturn: record.errorReturn !== false,
    violationReturn: record.violationReturn !== false,
  };
}

/** 从一段已解码的文本（RSC flight 流或反转义后的 RSC 块）里提取模型 JSON 数组。 */
function collectModelsFromJsonText(text: string, result: Map<string, ModelAvailabilityEntry>): void {
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const idx = text.indexOf("[{", searchFrom);
    if (idx === -1) break;
    searchFrom = idx + 2;
    const slice = extractBalancedJsonArray(text, idx);
    if (!slice || (!slice.includes('"maintenance"') && !slice.includes('"closeModel"'))) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(slice);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const item of parsed) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      if (typeof record.name !== "string") continue;
      const name = record.name.trim();
      if (!name) continue;
      if (!("closeModel" in record) && !("maintenance" in record)) continue;
      const maintenance = typeof record.maintenance === "string" ? record.maintenance.trim() : "";
      const closed = record.closeModel === true;
      const pricing = parsePricing(record);
      if (closed || maintenance) {
        result.set(name, {
          status: "unavailable",
          ...(maintenance ? { maintenance } : {}),
          ...(pricing ? { pricing } : {}),
        });
      } else {
        result.set(name, {
          status: "available",
          ...(pricing ? { pricing } : {}),
        });
      }
    }
  }
}

/** 主解析 1：直接解析 `RSC: 1` 返回的轻量 Next.js flight 流（未转义 JSON）。 */
function parseFromDirectRscStream(body: string): Map<string, ModelAvailabilityEntry> | null {
  if (!body.includes('"closeModel"') && !body.includes('"maintenance"')) return null;
  const result = new Map<string, ModelAvailabilityEntry>();
  collectModelsFromJsonText(body, result);
  return result.size > 0 ? result : null;
}

/** 主解析 2：从完整 HTML 的 self.__next_f.push([1,"..."]) 载荷中提取结构化模型列表。 */
function parseFromEmbeddedRscPayload(html: string): Map<string, ModelAvailabilityEntry> | null {
  const chunkPattern = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g;
  const result = new Map<string, ModelAvailabilityEntry>();

  for (const match of html.matchAll(chunkPattern)) {
    const raw = match[1];
    if (!raw.includes("maintenance") && !raw.includes("closeModel")) continue;
    let decoded: string;
    try {
      decoded = JSON.parse(`"${raw}"`) as string;
    } catch {
      continue;
    }
    collectModelsFromJsonText(decoded, result);
  }

  return result.size > 0 ? result : null;
}

/** 兜底解析：按 SSR HTML 中每个模型卡片的 <h4>名称</h4> 切段，检查卡片内是否出现「维护中」。 */
function parseFromHtmlCards(html: string): Map<string, ModelAvailabilityEntry> | null {
  const headingPattern = /<h4[^>]*>([^<]+)<\/h4>/g;
  const matches = [...html.matchAll(headingPattern)];
  if (matches.length === 0) return null;

  const result = new Map<string, ModelAvailabilityEntry>();
  for (let i = 0; i < matches.length; i += 1) {
    const current = matches[i];
    const name = current[1].trim();
    if (!name || /\s/.test(name)) continue;
    const start = current.index ?? 0;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? html.length) : Math.min(html.length, start + 3000);
    const cardHtml = html.slice(start, Math.min(end, start + 3000));
    if (cardHtml.includes("维护中") || cardHtml.toLowerCase().includes("under maintenance")) {
      result.set(name, { status: "unavailable", maintenance: "维护中" });
    } else {
      result.set(name, { status: "available" });
    }
  }

  return result.size > 0 ? result : null;
}

/** 解析 https://grsai.ai/zh/models 返回的 RSC 流或 HTML；解析不出任何模型时返回 null。 */
export function parseModelsAvailabilityHtml(body: string): Map<string, ModelAvailabilityEntry> | null {
  if (!body || typeof body !== "string") return null;
  return parseFromDirectRscStream(body) ?? parseFromEmbeddedRscPayload(body) ?? parseFromHtmlCards(body);
}

/** 根据已拉取的官网状态快照，判定指定模型当前的可用性状态。 */
export function resolveModelAvailability(
  modelId: string,
  snapshot: Pick<ModelAvailabilitySnapshot, "loaded" | "models">,
): ResolvedModelAvailability {
  if (!snapshot.loaded) return { state: "unknown" };
  const entry = snapshot.models.get(modelId);
  if (!entry) return { state: "unavailable", unlisted: true };
  return { state: entry.status, maintenance: entry.maintenance };
}
