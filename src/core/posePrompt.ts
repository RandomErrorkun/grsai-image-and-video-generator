/**
 * 3D 姿势工坊的「位置区分计算」与「预制身份锚定提示词块」生成器（纯逻辑，零 DOM 依赖）。
 *
 * 将 Three.js 相机投影得到的标准化屏幕平面坐标 (screenX, screenY) 与真实景深 depth
 * 翻译为生图/生视频模型能准确理解的中英双语方位词，并按复选框拼装 Markdown 锚定块。
 */
import type { PoseExportModes, PosePositionStrategy, PosePromptAnchorConfig } from "./poseConfig";
import { resolveColorPromptToken, type CharacterColorSpec } from "./posePalettes";

export interface ProjectedPoseCharacter {
  id: string;
  label: string;
  color: CharacterColorSpec;
  /** 标准化屏幕水平坐标：0 = 最左，1 = 最右。 */
  screenX: number;
  /** 标准化屏幕垂直坐标：0 = 最下，1 = 最上。 */
  screenY: number;
  /** 角色重心到拍摄相机的真实欧氏距离（越小越靠前/前景）。 */
  depth: number;
}

export type PosePromptWarning =
  | "all_unchecked"
  | "multi_position_only"
  | "color_ignored_without_mannequin";

export interface PosePromptBuildResult {
  /** 生成的 Markdown 锚定块文本；若关闭总开关或无角色则返回空字符串。 */
  text: string;
  /** 给界面的温和防呆提示列表。 */
  warnings: PosePromptWarning[];
}

export interface PosePromptBuildInput {
  characters: readonly ProjectedPoseCharacter[];
  language: "zh" | "en";
  exportModes: PoseExportModes;
  anchor: PosePromptAnchorConfig;
}

interface PositionPhrase {
  zh: string;
  en: string;
}

const DUO_X_THRESHOLD = 0.12;
const DUO_Y_THRESHOLD = 0.15;
const DUO_DEPTH_RATIO = 1.15;
const MULTI_DEPTH_SPREAD_RATIO = 1.25;

function ordinalEn(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const mod10 = n % 10;
  if (mod10 === 1) return `${n}st`;
  if (mod10 === 2) return `${n}nd`;
  if (mod10 === 3) return `${n}rd`;
  return `${n}th`;
}

/** 计算全场景各角色的中英文方位词映射（key 为角色 id）。 */
export function computeCharacterPositions(
  characters: readonly ProjectedPoseCharacter[],
  strategy: PosePositionStrategy = "rank_depth",
): Map<string, PositionPhrase> {
  const result = new Map<string, PositionPhrase>();
  const count = characters.length;
  if (count === 0) return result;

  if (count === 1) {
    result.set(characters[0].id, { zh: "画面中央", en: "in the center" });
    return result;
  }

  if (count === 2) {
    const [a, b] = characters;
    const dx = a.screenX - b.screenX;
    const dy = a.screenY - b.screenY;
    const minDepth = Math.max(1e-4, Math.min(a.depth, b.depth));
    const maxDepth = Math.max(a.depth, b.depth);
    const hasDepthDiff = maxDepth / minDepth >= DUO_DEPTH_RATIO;
    const hasXDiff = Math.abs(dx) >= DUO_X_THRESHOLD;
    const hasYDiff = Math.abs(dy) >= DUO_Y_THRESHOLD;

    const buildDuo = (self: ProjectedPoseCharacter, other: ProjectedPoseCharacter): PositionPhrase => {
      const zhParts: string[] = [];
      const enParts: string[] = [];

      if (hasXDiff) {
        if (self.screenX < other.screenX) {
          zhParts.push("左侧");
          enParts.push("on the left");
        } else {
          zhParts.push("右侧");
          enParts.push("on the right");
        }
      }
      if (hasDepthDiff) {
        if (self.depth < other.depth) {
          zhParts.push("前景");
          enParts.push("in the foreground");
        } else {
          zhParts.push("后景");
          enParts.push("in the background");
        }
      }
      if (hasYDiff) {
        if (self.screenY > other.screenY) {
          zhParts.push("上方");
          enParts.push("at the top");
        } else {
          zhParts.push("下方");
          enParts.push("at the bottom");
        }
      }

      if (zhParts.length === 0) {
        // 两者极其接近时按 screenX 兜底，确保始终能区分
        if (self.screenX <= other.screenX) {
          return { zh: "偏左侧", en: "on the left" };
        }
        return { zh: "偏右侧", en: "on the right" };
      }
      return { zh: zhParts.join(""), en: enParts.join(" ") };
    };

    result.set(a.id, buildDuo(a, b));
    result.set(b.id, buildDuo(b, a));
    return result;
  }

  // 3 人及以上
  const sortedByX = [...characters].sort((u, v) => u.screenX - v.screenX || u.depth - v.depth);
  const rankById = new Map<string, number>();
  sortedByX.forEach((char, idx) => rankById.set(char.id, idx + 1));

  // 判断是否存在显著前后纵深
  const depths = characters.map((c) => c.depth);
  const minDepth = Math.max(1e-4, Math.min(...depths));
  const maxDepth = Math.max(...depths);
  const hasDepthLayers = maxDepth / minDepth >= MULTI_DEPTH_SPREAD_RATIO;
  const depthSpan = Math.max(1e-4, maxDepth - minDepth);

  const depthTier = (depth: number): PositionPhrase | null => {
    if (!hasDepthLayers) return null;
    const norm = (depth - minDepth) / depthSpan;
    if (norm < 1 / 3) return { zh: "前景", en: "in the foreground" };
    if (norm > 2 / 3) return { zh: "后景", en: "in the background" };
    return { zh: "中景", en: "in the midground" };
  };

  if (strategy === "grid9") {
    const cellKeyOf = (c: ProjectedPoseCharacter): [number, number] => {
      const col = c.screenX < 1 / 3 ? 0 : c.screenX > 2 / 3 ? 2 : 1;
      const row = c.screenY > 2 / 3 ? 0 : c.screenY < 1 / 3 ? 2 : 1; // 0=上, 1=中, 2=下
      return [row, col];
    };
    const cellCounts = new Map<string, number>();
    for (const c of characters) {
      const key = cellKeyOf(c).join(",");
      cellCounts.set(key, (cellCounts.get(key) ?? 0) + 1);
    }
    const GRID_ZH = [
      ["左上角", "正上方", "右上角"],
      ["左侧中部", "正中央", "右侧中部"],
      ["左下角", "正下方", "右下角"],
    ];
    const GRID_EN = [
      ["in the top-left", "at the top center", "in the top-right"],
      ["on the middle-left", "in the center", "on the middle-right"],
      ["in the bottom-left", "at the bottom center", "in the bottom-right"],
    ];
    for (const c of characters) {
      const [row, col] = cellKeyOf(c);
      const rank = rankById.get(c.id) ?? 1;
      const tier = depthTier(c.depth);
      const collision = (cellCounts.get(`${row},${col}`) ?? 0) > 1;
      let zh = GRID_ZH[row][col];
      let en = GRID_EN[row][col];
      if (tier) {
        zh = `${tier.zh}${zh}`;
        en = `${en} ${tier.en}`;
      }
      if (collision) {
        zh = `${zh}（从左数第 ${rank} 位）`;
        en = `${en} (${ordinalEn(rank)} from the left)`;
      }
      result.set(c.id, { zh, en });
    }
    return result;
  }

  // 默认多人策略：左起顺位 + 景深
  for (const c of characters) {
    const rank = rankById.get(c.id) ?? 1;
    const tier = depthTier(c.depth);
    const zh = tier ? `${tier.zh}从左数第 ${rank} 位` : `从左数第 ${rank} 位`;
    const en = tier ? `${ordinalEn(rank)} from the left ${tier.en}` : `${ordinalEn(rank)} from the left`;
    result.set(c.id, { zh, en });
  }
  return result;
}

/** 按选中的参考图导出类型决定实体称呼与是否支持体表颜色区分。 */
function resolveSubjectNoun(exportModes: PoseExportModes): {
  zh: string;
  en: string;
  supportsColor: boolean;
} {
  if (exportModes.mannequin || exportModes.mannequinSkeleton) {
    return { zh: "3D人偶", en: "3D mannequin", supportsColor: true };
  }
  if (exportModes.openpose && !exportModes.depth) {
    return { zh: "骨架人物", en: "skeleton figure", supportsColor: false };
  }
  if (exportModes.depth && !exportModes.openpose) {
    return { zh: "深度图人物", en: "depth figure", supportsColor: false };
  }
  return { zh: "参考人物", en: "reference figure", supportsColor: false };
}

/**
 * 生成可发送至图像/视频生成页的预制 Markdown 身份锚定块，同时输出温和防呆提醒。
 * 列表按从左到右（screenX 升序）排列，便于用户与参考图逐一核对填写角色名。
 */
export function buildPosePromptAnchor(input: PosePromptBuildInput): PosePromptBuildResult {
  const { characters, language, exportModes, anchor } = input;
  const warnings: PosePromptWarning[] = [];

  const subject = resolveSubjectNoun(exportModes);
  const effectiveColor = anchor.useColor && subject.supportsColor;
  const effectiveLabel = anchor.useLabel;
  const effectivePosition = anchor.usePosition;

  if (anchor.enabled && characters.length > 0) {
    if (anchor.useColor && !subject.supportsColor) {
      warnings.push("color_ignored_without_mannequin");
    }
    if (!effectiveColor && !effectiveLabel && !effectivePosition) {
      warnings.push("all_unchecked");
    } else if (characters.length >= 3 && effectivePosition && !effectiveColor && !effectiveLabel) {
      warnings.push("multi_position_only");
    }
  }

  if (!anchor.enabled || characters.length === 0) {
    return { text: "", warnings };
  }

  // 按 screenX 从左到右展示，更符合人眼对照参考图填写【角色名】的习惯
  const ordered = [...characters].sort((a, b) => a.screenX - b.screenX || a.depth - b.depth);
  const positions = effectivePosition ? computeCharacterPositions(ordered, anchor.positionStrategy) : null;

  if (language === "zh") {
    const lines = ["# 动作参考", "姿势参考图中："];
    for (const char of ordered) {
      const modifiers: string[] = [];
      if (effectivePosition) {
        const pos = positions?.get(char.id);
        if (pos) modifiers.push(`在 ${pos.zh} 的`);
      }
      if (effectiveColor) {
        modifiers.push(`${resolveColorPromptToken(char.color)} 的`);
      }
      if (effectiveLabel && char.label.trim()) {
        modifiers.push(`编号为 ${char.label.trim()} 的`);
      }
      lines.push(`- ${modifiers.join("")}${subject.zh}为角色【】`);
    }
    return { text: lines.join("\n"), warnings };
  }

  const lines = ["# Pose Reference", "In the pose reference image:"];
  for (const char of ordered) {
    const colorPrefix = effectiveColor ? `${resolveColorPromptToken(char.color)} ` : "";
    const suffixes: string[] = [];
    if (effectivePosition) {
      const pos = positions?.get(char.id);
      if (pos) suffixes.push(` ${pos.en}`);
    }
    if (effectiveLabel && char.label.trim()) {
      suffixes.push(` labeled "${char.label.trim()}"`);
    }
    lines.push(`- The ${colorPrefix}${subject.en}${suffixes.join("")} is character []`);
  }
  return { text: lines.join("\n"), warnings };
}

/**
 * 将新的姿势锚定块智能写入目标页提示词文本：
 * - 若原文本为空，直接返回新块；
 * - 若原文本中已存在 `# 动作参考` 或 `# Pose Reference` 段落块，则原地替换该段落块，保留用户其余提示词；
 * - 否则在原文本末尾空两行追加。
 */
export function upsertPoseAnchorInPrompt(existingPrompt: string, anchorBlock: string): string {
  const trimmedBlock = anchorBlock.trim();
  if (!trimmedBlock) return existingPrompt;
  const trimmedExisting = existingPrompt.trim();
  if (!trimmedExisting) return trimmedBlock;

  // 匹配从 `# 动作参考` 或 `# Pose Reference` 开始，直到下一个空白行或文末
  const anchorRegex = /(?:^|\r?\n)(?:# 动作参考|# Pose Reference)\r?\n(?:[^\r\n]+\r?\n?)+/m;
  const match = anchorRegex.exec(existingPrompt);
  if (match && match.index !== undefined) {
    const hasLeadingNewline = match[0].startsWith("\n") || match[0].startsWith("\r\n");
    const replaceStart = match.index + (hasLeadingNewline ? (match[0].startsWith("\r\n") ? 2 : 1) : 0);
    const replaceEnd = match.index + match[0].length;
    const before = existingPrompt.slice(0, replaceStart);
    const after = existingPrompt.slice(replaceEnd);
    const suffix = after.length > 0 && !after.startsWith("\n") && !after.startsWith("\r") ? `\n${after}` : after;
    return `${before}${trimmedBlock}${suffix}`;
  }

  return `${existingPrompt.replace(/\s+$/, "")}\n\n${trimmedBlock}`;
}
