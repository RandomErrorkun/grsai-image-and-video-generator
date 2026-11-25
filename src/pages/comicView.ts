/**
 * 漫画页的纯逻辑（对应 ui/comic_page.py）：参考图序号解析、出图参数与最终提示词组装、分页重排。
 * 不依赖 React 和平台层，可直接单测。
 */
import type { ComicPage as ComicPageData } from "../core/comicPlanner";
import { referenceLabel } from "../core/comicPlanner";
import {
  COMIC_IMAGE_MODELS,
  GPT_IMAGE_MODEL_IDS,
  LEGACY_IMAGE_MODEL_ALIASES,
  NANO_IMAGE_SIZE_OPTIONS,
  gptPixelValue,
  gptRatioOptions,
  isGptPixelOnly,
} from "../core/modelCatalog";

export const COMIC_PAGE_COUNTS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
export const COMIC_ASPECT_RATIOS = [
  "auto",
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "5:4",
  "4:5",
  "21:9",
] as const;

const GPT_SET = new Set<string>(GPT_IMAGE_MODEL_IDS);

export function normalizeComicImageModel(model: string): string {
  const mapped =
    Object.prototype.hasOwnProperty.call(LEGACY_IMAGE_MODEL_ALIASES, model)
      ? LEGACY_IMAGE_MODEL_ALIASES[model]
      : model;
  return COMIC_IMAGE_MODELS.includes(mapped) ? mapped : COMIC_IMAGE_MODELS[0];
}

export function isCompletionComicModel(model: string): boolean {
  const normalized = normalizeComicImageModel(model);
  return GPT_SET.has(normalized) || normalized.startsWith("gpt-image");
}

export function comicSizeOptions(model: string): string[] {
  const normalized = normalizeComicImageModel(model);
  if (isCompletionComicModel(normalized)) return gptRatioOptions(normalized);
  return [...(NANO_IMAGE_SIZE_OPTIONS[normalized] ?? [])];
}

/** 对应 _parse_reference_targets：中英文逗号分隔，只留正整数并去重。 */
export function parseReferenceTargets(text: string): number[] {
  const values: number[] = [];
  for (const raw of (text || "").replace(/，/g, ",").split(",")) {
    const cleaned = raw.trim();
    if (!cleaned || !/^-?\d+$/.test(cleaned)) continue;
    const value = Number(cleaned);
    if (value > 0 && !values.includes(value)) values.push(value);
  }
  return values;
}

export function formatReferenceTargets(values: readonly number[] | null | undefined): string {
  return (values ?? []).map((v) => String(v)).join(",");
}

/** 对应 ComicPageCard.get_page_data 里的对白行清理。 */
export function parseDialogueLines(text: string): string[] {
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cleaned = line.trim().replace(/^-+/, "").replace(/^•+/, "").trim();
    if (cleaned) lines.push(cleaned);
  }
  return lines;
}

/** 拖拽或按钮重排分页后，重新按 1..N 编号。 */
export function reorderComicPages(pages: readonly ComicPageData[], fromIndex: number, toIndex: number): ComicPageData[] {
  if (fromIndex < 0 || fromIndex >= pages.length || toIndex < 0 || toIndex >= pages.length || fromIndex === toIndex) {
    return [...pages];
  }
  const next = [...pages];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next.map((page, index) => ({ ...page, page_number: index + 1 }));
}

export interface ComicImageBuildInput {
  imageModel: string;
  aspectRatio: string;
  imageSize: string;
  hasSizeOptions: boolean;
  pageNumber: number;
  refImageUrls: string[];
  outputDir: string;
}

export interface ComicTaskSpecParams {
  model: string;
  aspectRatio: string;
  imageSize: string;
  refImageUrls: string[];
  outputDir: string;
  /** 照搬源项目的双前缀怪癖：传入 grsai_page_NN，由 resultFileStem 拼成 grsai_grsai_page_NN_。 */
  filenamePrefix: string;
}

/** 对应 ComicPage._build_image_params。 */
export function buildComicTaskSpec(input: ComicImageBuildInput): ComicTaskSpecParams {
  const model = normalizeComicImageModel(input.imageModel);
  let aspectRatio: string;
  let imageSize: string;
  if (isCompletionComicModel(model)) {
    const gptRatio = input.hasSizeOptions ? input.imageSize : "auto";
    aspectRatio = isGptPixelOnly(model) ? gptPixelValue(gptRatio, "1K") : gptRatio;
    imageSize = "auto";
  } else {
    aspectRatio = input.aspectRatio;
    imageSize = input.hasSizeOptions ? input.imageSize : "1K";
  }
  const pageNum = Math.max(1, Math.trunc(input.pageNumber) || 1);
  return {
    model,
    aspectRatio,
    imageSize,
    refImageUrls: input.refImageUrls,
    outputDir: input.outputDir,
    filenamePrefix: `grsai_page_${String(pageNum).padStart(2, "0")}`,
  };
}

/** 对应 ComicPage._build_final_prompt，提示词原文与源项目逐字一致。 */
export function buildComicFinalPrompt(
  page: Pick<ComicPageData, "page_number" | "story_beat" | "dialogue" | "reference_targets" | "image_prompt">,
  context: { planTitle: string; planStyleNotes: string; hasReferenceImages: boolean },
): string {
  const parts: string[] = [];
  if (context.planTitle) parts.push(`项目名：${context.planTitle}。`);
  parts.push(`这是漫画的第 ${page.page_number || 1} 页。`);
  const referenceTargets = page.reference_targets ?? [];
  if (context.hasReferenceImages) {
    parts.push("你会同时收到多张按上传顺序排列的人物参考图：第 1 张就是参考图一，第 2 张就是参考图二，后续依次类推。");
    if (referenceTargets.length > 0) {
      const refsText = referenceTargets.map((index) => `参考图${referenceLabel(index)}`).join("、");
      parts.push(`本页主要角色请优先严格参考：${refsText}。未列出的参考图不要误用到当前主角身上。`);
    }
    parts.push("请先逐张识别参考图，再决定当前页面该使用哪位角色的外观，不要混淆不同参考图中的发色、眼镜、服装和配饰。");
  }
  if (page.story_beat) parts.push(`本页剧情：${page.story_beat}。`);
  if (page.dialogue && page.dialogue.length > 0) parts.push(`本页对白要点：${page.dialogue.join(" ")}`);
  if (context.planStyleNotes) parts.push(`全局画风与氛围：${context.planStyleNotes}。`);
  if (page.image_prompt) parts.push(page.image_prompt);
  parts.push("请输出完整漫画页画面，保证阅读顺序清楚、叙事明确、人物表演到位、画面张力强。");
  return parts.filter((part) => part && part.trim()).join(" ");
}
