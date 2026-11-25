/**
 * 漫画分页规划（对应 core/comic_planner.py）。
 * 提示词原文照搬，解析与归一化的规则也照搬。
 */
import {
  buildChatRequest,
  CHAT_TIMEOUT_SECS,
  normalizeChatMessages,
  parseChatResponse,
  type ApiSettings,
  type HttpRequest,
  type HttpOutcome,
  type LocalFiles,
} from "./api";
import { pyInt, pySplitLines, pyStr } from "./py";

export interface ComicPage {
  page_number: number;
  title: string;
  story_beat: string;
  narration: string;
  dialogue: string[];
  scene_description: string;
  camera_direction: string;
  panel_layout: string;
  image_prompt: string;
  reference_targets: number[];
}

export interface ComicPlan {
  title: string;
  style_notes: string;
  pages: ComicPage[];
}

/** 规划结果要求的输出语言。 */
export function outputLanguageName(language: string): string {
  return language === "zh" ? "简体中文" : "English";
}

/** 从剧情模型的回复里抠出 JSON：带围栏的取围栏里的，否则取第一个左花括号到最后一个右花括号。 */
export function extractJsonPayload(content: unknown): string {
  let text = pyStr(content ?? "").trim();
  if (!text) throw new Error("Empty response from story model.");

  const fenced = /```(?:json)?\s*(\{[\s\S]*\})\s*```/.exec(text);
  if (fenced) text = fenced[1].trim();

  if (text.startsWith("{") && text.endsWith("}")) return text;

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);

  throw new Error("Story model did not return valid JSON.");
}

/** 对白：数组就逐行去空白，文本就按行拆并去掉行首的列表符号。 */
export function normalizeDialogue(dialogue: unknown): string[] {
  if (Array.isArray(dialogue)) {
    return dialogue.map((line) => pyStr(line).trim()).filter((line) => line);
  }
  if (typeof dialogue === "string") {
    const lines: string[] = [];
    for (const line of pySplitLines(dialogue)) {
      const cleaned = line.trim().replace(/^-+/, "").replace(/^•+/, "").trim();
      if (cleaned) lines.push(cleaned);
    }
    return lines;
  }
  return [];
}

const REFERENCE_LABELS: Readonly<Record<number, string>> = {
  1: "一", 2: "二", 3: "三", 4: "四", 5: "五", 6: "六", 7: "七",
  8: "八", 9: "九", 10: "十", 11: "十一", 12: "十二", 13: "十三", 14: "十四",
};

export function referenceLabel(index: unknown): string {
  const value = typeof index === "number" ? index : Number(index);
  return Object.prototype.hasOwnProperty.call(REFERENCE_LABELS, value)
    ? REFERENCE_LABELS[value]
    : pyStr(index);
}

/** 参考图序号：只留 1 到 max_refs 之间的整数，重复的去掉。 */
export function normalizeReferenceTargets(referenceTargets: unknown, maxRefs: number): number[] {
  if (maxRefs <= 0) return [];

  let rawValues: unknown[];
  if (Array.isArray(referenceTargets)) rawValues = referenceTargets;
  else if (typeof referenceTargets === "string") {
    rawValues = referenceTargets.trim().split(/[，,\s]+/);
  } else rawValues = [];

  const values: number[] = [];
  for (const raw of rawValues) {
    const value = pyInt(pyStr(raw).trim());
    if (value === null) continue;
    if (1 <= value && value <= maxRefs && !values.includes(value)) values.push(value);
  }
  return values;
}

type FallbackPage = Pick<ComicPage, "page_number" | "dialogue" | "reference_targets"> &
  Partial<
    Pick<ComicPage, "story_beat" | "scene_description" | "panel_layout" | "camera_direction" | "narration">
  >;

/** 剧情模型没给 image_prompt 时，用页面上的其他字段拼一条出图提示词。 */
export function fallbackVisualPrompt(page: FallbackPage, planStyleNotes: string, totalPages: number): string {
  const dialogueText = (page.dialogue ?? []).slice(0, 4).join(" ");
  const referenceTargets = (page.reference_targets ?? []) as number[];
  const refText = referenceTargets.map((index) => `参考图${referenceLabel(index)}`).join("、");
  const pageNumber = page.page_number ?? 1;
  const promptParts = [
    "请生成一张完整的漫画页插画。",
    `这是全篇第 ${pageNumber} / ${totalPages} 页。`,
    "如果提供了人物参考图，请保持人物身份、发型、服装和气质稳定统一。",
    `本页重点参考：${refText}`,
    `本页剧情重点：${pyStr(page.story_beat ?? "")}`,
    `画面场景：${pyStr(page.scene_description ?? "")}`,
    `分镜与排版：${pyStr(page.panel_layout ?? "")}`,
    `镜头与机位：${pyStr(page.camera_direction ?? "")}`,
    `旁白氛围：${pyStr(page.narration ?? "")}`,
    `对白要点：${dialogueText}`,
    `整体画风：${planStyleNotes}`,
    "要求叙事清晰、表演生动、画面有戏剧张力、具备漫画页阅读顺序。",
  ];
  return promptParts.filter((part) => part && part.trim()).join(" ");
}

const invalidInt = (value: unknown): Error =>
  new Error(`invalid literal for int() with base 10: '${pyStr(value)}'`);

/** 解析剧情模型的回复，得到归一化后的分页脚本。回复不合格时抛错，错误信息给界面直接显示。 */
export function parseComicPlan(content: unknown, pageCount: number, referenceCount = 0): ComicPlan {
  const payload: unknown = JSON.parse(extractJsonPayload(content));
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new TypeError(`'${pyStr(payload)}' object has no attribute 'get'`);
  }
  const record = payload as Record<string, unknown>;
  const field = (key: string): unknown => (key in record ? record[key] : "");

  const pages = field("pages") ?? [];
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error("Story model returned no comic pages.");
  }

  const planStyleNotes = pyStr(field("style_notes")).trim();
  const normalizedPages: ComicPage[] = [];
  for (const [index, page] of pages.entries()) {
    if (typeof page !== "object" || page === null || Array.isArray(page)) continue;
    const source = page as Record<string, unknown>;
    const read = (key: string) => pyStr(key in source ? source[key] : "").trim();

    const rawPageNumber = source.page_number || index + 1;
    const pageNumber = pyInt(rawPageNumber);
    if (pageNumber === null) throw invalidInt(rawPageNumber);

    const normalizedPage: ComicPage = {
      page_number: pageNumber,
      title: read("title"),
      story_beat: read("story_beat"),
      narration: read("narration"),
      dialogue: normalizeDialogue(source.dialogue),
      scene_description: read("scene_description"),
      camera_direction: read("camera_direction"),
      panel_layout: read("panel_layout"),
      image_prompt: read("image_prompt"),
      reference_targets: normalizeReferenceTargets(source.reference_targets, referenceCount),
    };
    if (!normalizedPage.image_prompt) {
      normalizedPage.image_prompt = fallbackVisualPrompt(
        normalizedPage,
        planStyleNotes,
        Math.max(pageCount, pages.length),
      );
    }
    normalizedPages.push(normalizedPage);
  }

  if (normalizedPages.length === 0) {
    throw new Error("Failed to normalize comic pages from story model output.");
  }

  return {
    title: pyStr(field("title")).trim(),
    style_notes: planStyleNotes,
    pages: normalizedPages,
  };
}

/** 组装发给剧情模型的消息。所有提示词与源项目逐字一致，请勿改动。 */
export async function buildPlanningMessages(
  storyRequirement: string,
  styleNotes: string,
  pageCount: number,
  referenceImages: readonly string[] | null | undefined,
  files: LocalFiles,
  language: string,
): Promise<unknown[]> {
  const languageName = outputLanguageName(language);
  const validReferenceImages: string[] = [];
  for (const path of referenceImages ?? []) {
    if (await files.isFile(path)) validReferenceImages.push(path);
  }
  const refText = validReferenceImages.length ? "有" : "无";
  const schema = {
    title: "短篇标题",
    style_notes: "全局画风说明",
    pages: [
      {
        page_number: 1,
        title: "可选页面标题，可留空字符串",
        story_beat: "这一页发生了什么",
        narration: "旁白，可为空",
        dialogue: ["角色名：对白"],
        scene_description: "这一页应该看到什么",
        camera_direction: "镜头与构图建议",
        panel_layout: "建议的分镜排版",
        reference_targets: [1],
        image_prompt: "可直接用于出图的一整页漫画提示词",
      },
    ],
  };

  const systemPrompt =
    "你是一位专业漫画编剧和分镜策划师。" +
    "请把用户的故事需求扩写成可直接用于漫画创作的分页脚本。" +
    "要求剧情连贯、角色稳定、对白自然、每一页都具备明确的画面目标和可执行的出图提示词。" +
    "所有文本字段必须使用简体中文输出，尤其是 title、style_notes、story_beat、narration、dialogue、scene_description、camera_direction、panel_layout、image_prompt。" +
    "除用户原文中的专有名词、英文名或必须保留的品牌名外，禁止输出英文句子、英文关键词列表或英文风格描述。" +
    "如果我按顺序提供了多张人物参考图，你必须逐张识别并记住，每张图都是不同的编号，不允许混淆角色。" +
    "你必须根据每一页实际登场角色，给出 reference_targets，表示这一页主要参考哪些图片编号。" +
    "image_prompt 必须是可直接用于出图模型的完整中文提示词，里面要写清人物、场景、动作、情绪、镜头、光影、构图、分镜页感和对白呈现方式。" +
    "页面标题不是必需项，如果没有必要可以输出空字符串。" +
    "你必须只返回严格 JSON，不要输出 markdown，不要解释，不要多余文本。";
  const instructionText =
    `输出语言：${languageName}\n` +
    `目标页数：${pageCount}\n` +
    `绘图阶段是否提供人物参考图：${refText}\n` +
    "请控制主要角色数量，确保角色在全篇视觉上保持一致。\n" +
    "每一页都应被设计为完整的漫画页画面，而不是单独角色立绘。\n" +
    "请优先把关键信息写进 image_prompt，不要依赖页面标题补充信息。\n" +
    "整篇故事必须有起承转合，页与页之间衔接清楚。\n" +
    "如果对白里不希望出现角色名字，也请直接在对白文本里避免写名字，不要在 image_prompt 里重复英文台词。\n" +
    "如果提供了多张参考图，请严格按提供顺序理解：参考图一就是第 1 张，参考图二就是第 2 张，以此类推。\n" +
    "请先看参考图，再写故事规划；不要凭空脑补参考图里不存在的发色、眼镜、服装或角色身份。\n" +
    "再次强调：请不要输出英文提示词，最终 JSON 中每一页的 image_prompt 也必须是自然、完整、可执行的中文描述。\n" +
    `故事需求：\n${storyRequirement.trim()}\n\n` +
    `补充风格说明：\n${styleNotes.trim() || "无额外要求"}\n\n` +
    "请严格按照下面的 JSON 结构返回：\n" +
    JSON.stringify(schema, null, 2);

  const userContent: unknown[] = [
    {
      type: "text",
      text: "下面我会按固定顺序提供人物参考图，请严格记住编号，不要把不同参考图里的角色特征混在一起。",
    },
  ];

  for (const [index, refPath] of validReferenceImages.entries()) {
    const position = index + 1;
    userContent.push({
      type: "text",
      text:
        `参考图${referenceLabel(position)}：这是第 ${position} 张人物参考图。` +
        "请先单独识别这张图里的角色外观特征，包括发色、发型、脸型、眼睛/眼镜、服装、配饰、年龄气质。" +
        `后面如果提到“参考图${referenceLabel(position)}”，就是指这一张。`,
    });
    userContent.push({
      type: "image_url",
      image_url: { url: refPath },
    });
  }

  userContent.push({ type: "text", text: instructionText });

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];
}

export type PlanResult = { ok: true; plan: ComicPlan } | { ok: false; message: string };

/** 漫画页可选的自定义 OpenAI 兼容对话接口配置；baseUrl 为空时走 Grsai 中转。 */
export interface CustomChatConfig {
  baseUrl: string;
  endpoint: string;
  apiKey: string;
  model: string;
  /** 可选的附加 JSON 请求体字段。 */
  extraBody: string;
}

/** 构造自定义对话服务的 /models 请求，用于取可用模型列表和测连通性。 */
export function buildModelsListRequest(baseUrl: string, apiKey: string): HttpRequest {
  const base = baseUrl.trim().replace(/\/+$/, "");
  const headers: Record<string, string> = {};
  if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;
  return {
    method: "GET",
    url: `${base}/models`,
    headers,
    connectTimeoutSecs: 15,
    readTimeoutSecs: 30,
  };
}

/** 解析 /models 响应，返回去重排序后的模型 ID 列表。 */
export function parseModelsListResponse(
  status: number,
  body: string,
): { ok: true; models: string[] } | { ok: false; message: string } {
  if (status < 200 || status >= 300) {
    return { ok: false, message: `HTTP ${status}: ${body.slice(0, 200)}` };
  }
  try {
    const parsed: unknown = JSON.parse(body);
    const list =
      typeof parsed === "object" && parsed !== null && Array.isArray((parsed as Record<string, unknown>).data)
        ? ((parsed as Record<string, unknown>).data as unknown[])
        : Array.isArray(parsed)
          ? parsed
          : [];
    const ids = new Set<string>();
    for (const item of list) {
      if (typeof item === "string" && item.trim()) ids.add(item.trim());
      else if (typeof item === "object" && item !== null && typeof (item as Record<string, unknown>).id === "string") {
        const id = ((item as Record<string, unknown>).id as string).trim();
        if (id) ids.add(id);
      }
    }
    return { ok: true, models: [...ids].sort() };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : pyStr(error) };
  }
}

export interface PlanComicDeps {
  settings: ApiSettings;
  files: LocalFiles;
  language: string;
  /** 发出 chat completions 请求。 */
  sendChat(request: HttpRequest): Promise<HttpOutcome>;
  /** 可选的自定义 OpenAI 兼容对话接口；baseUrl 非空时覆盖默认的 Grsai 中转。 */
  customChat?: CustomChatConfig | null;
}

function buildCustomChatRequest(
  custom: CustomChatConfig,
  fallbackModel: string,
  normalizedMessages: unknown[],
): HttpRequest {
  const base = custom.baseUrl.trim().replace(/\/+$/, "");
  const rawEndpoint = custom.endpoint.trim();
  const endpoint = rawEndpoint
    ? rawEndpoint.startsWith("/")
      ? rawEndpoint
      : `/${rawEndpoint}`
    : "/chat/completions";
  let extra: Record<string, unknown> = {};
  if (custom.extraBody.trim()) {
    const parsed: unknown = JSON.parse(custom.extraBody.trim());
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Custom request body must be a JSON object.");
    }
    extra = parsed as Record<string, unknown>;
  }
  const payload: Record<string, unknown> = {
    ...extra,
    model: custom.model.trim() || fallbackModel,
    messages: normalizedMessages,
    stream: false,
    temperature: "temperature" in extra ? extra.temperature : 0.8,
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (custom.apiKey.trim()) headers.Authorization = `Bearer ${custom.apiKey.trim()}`;
  return {
    method: "POST",
    url: `${base}${endpoint}`,
    headers,
    body: JSON.stringify(payload),
    connectTimeoutSecs: CHAT_TIMEOUT_SECS,
    readTimeoutSecs: CHAT_TIMEOUT_SECS,
  };
}

/** 生成漫画分页脚本：组装消息、调用剧情模型、解析回复。失败时带一条可直接显示的说明。 */
export async function planComic(
  deps: PlanComicDeps,
  input: {
    storyModel: string;
    storyRequirement: string;
    styleNotes: string;
    pageCount: number;
    referenceImages: readonly string[];
  },
): Promise<PlanResult> {
  try {
    const messages = await buildPlanningMessages(
      input.storyRequirement,
      input.styleNotes,
      input.pageCount,
      input.referenceImages,
      deps.files,
      deps.language,
    );
    const normalized = await normalizeChatMessages(messages, deps.files);
    // 消息里的本地参考图要先转成 data URI，与 chat_completion 的做法一致
    const request =
      deps.customChat && deps.customChat.baseUrl.trim()
        ? buildCustomChatRequest(deps.customChat, input.storyModel, normalized)
        : buildChatRequest(input.storyModel, normalized, { stream: false, temperature: 0.8 }, deps.settings);
    const outcome = await deps.sendChat(request);
    const response =
      outcome.outcome === "responded"
        ? parseChatResponse(outcome.status, outcome.body, request.url)
        : { ok: false as const, message: outcome.message };
    if (!response.ok) return { ok: false, message: response.message };

    const choices = (response.data.choices ?? []) as unknown;
    if (!Array.isArray(choices) || choices.length === 0) {
      return { ok: false, message: "Story planning returned no choices." };
    }
    const first = choices[0];
    const message =
      typeof first === "object" && first !== null && !Array.isArray(first)
        ? ((first as Record<string, unknown>).message ?? {}) as Record<string, unknown>
        : {};
    let content = message.content;
    if (Array.isArray(content)) {
      content = content
        .map((item) =>
          typeof item === "object" && item !== null && !Array.isArray(item)
            ? pyStr("text" in item ? (item as Record<string, unknown>).text : "")
            : "",
        )
        .join("");
    }

    const plan = parseComicPlan(content, input.pageCount, input.referenceImages.length);
    return { ok: true, plan };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : pyStr(error) };
  }
}
