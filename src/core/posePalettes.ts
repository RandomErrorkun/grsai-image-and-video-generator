/**
 * 3D 姿势工坊的调色板与 26 角色自动配色/标号规则。
 *
 * 色板数据直接来源于根目录 color_scheme.json 同步的 posePalettes.json，
 * 包含 Tableau10、Tableau20、Rainbow_type1、Rainbow_type2、CSS_148_colors 五套内置色板。
 */
import paletteData from "./posePalettes.json";

export interface PaletteColor {
  readonly name: string;
  readonly hex: string;
}

export type BuiltinPaletteName =
  | "Tableau10"
  | "Tableau20"
  | "Rainbow_type1"
  | "Rainbow_type2"
  | "CSS_148_colors";

export type CharacterColorPalette = BuiltinPaletteName | "custom";

export interface CharacterColorSpec {
  hex: string;
  palette: CharacterColorPalette;
  /** 若来自内置色板，记录色板中的英文代号（如 blue、lightorange）；自定义色为 null。 */
  name: string | null;
}

export const MAX_POSE_CHARACTERS = 26;

export const PALETTE_NAMES: readonly BuiltinPaletteName[] = [
  "Tableau10",
  "Tableau20",
  "Rainbow_type1",
  "Rainbow_type2",
  "CSS_148_colors",
];

export const POSE_PALETTES: Readonly<Record<BuiltinPaletteName, readonly PaletteColor[]>> = {
  Tableau10: paletteData.Tableau10,
  Tableau20: paletteData.Tableau20,
  Rainbow_type1: paletteData.Rainbow_type1,
  Rainbow_type2: paletteData.Rainbow_type2,
  CSS_148_colors: paletteData.CSS_148_colors,
};

/**
 * 新建角色的 26 色自动分配顺序：
 * 1. Tableau20 深色前 10 色 (0..9)
 * 2. Tableau20 浅色后 10 色 (10..19)
 * 3. Rainbow_type2 前 6 色 (0..5)
 */
export const AUTO_CHARACTER_COLOR_SEQUENCE: readonly CharacterColorSpec[] = [
  ...POSE_PALETTES.Tableau20.slice(0, 10).map((entry) => ({
    hex: normalizeHexColor(entry.hex),
    palette: "Tableau20" as const,
    name: entry.name,
  })),
  ...POSE_PALETTES.Tableau20.slice(10, 20).map((entry) => ({
    hex: normalizeHexColor(entry.hex),
    palette: "Tableau20" as const,
    name: entry.name,
  })),
  ...POSE_PALETTES.Rainbow_type2.slice(0, 6).map((entry) => ({
    hex: normalizeHexColor(entry.hex),
    palette: "Rainbow_type2" as const,
    name: entry.name,
  })),
];

/** 把任意合法的 #RGB / #RRGGBB 规整为大写 #RRGGBB；非法时回退 fallback。 */
export function normalizeHexColor(value: string, fallback = "#4E79A7"): string {
  const trimmed = String(value ?? "").trim();
  const short = /^#?([0-9a-fA-F]{3})$/.exec(trimmed);
  if (short) {
    const [r, g, b] = short[1].toUpperCase().split("");
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  const full = /^#?([0-9a-fA-F]{6})$/.exec(trimmed);
  if (full) {
    return `#${full[1].toUpperCase()}`;
  }
  return fallback.toUpperCase();
}

/** 按既有占用色列表自动挑选下一个未使用的顺序色；全部占满时按槽位取模。 */
export function autoAssignCharacterColor(usedHexes: readonly string[], slotIndex: number): CharacterColorSpec {
  const used = new Set(usedHexes.map((hex) => normalizeHexColor(hex)));
  const unused = AUTO_CHARACTER_COLOR_SEQUENCE.find((item) => !used.has(item.hex));
  if (unused) return { ...unused };
  const safeIndex = Math.abs(Math.trunc(slotIndex)) % AUTO_CHARACTER_COLOR_SEQUENCE.length;
  return { ...AUTO_CHARACTER_COLOR_SEQUENCE[safeIndex] };
}

/** 生成默认角色标号：A..Z（0..25）。 */
export function defaultCharacterLabel(index: number): string {
  const clamped = Math.max(0, Math.min(MAX_POSE_CHARACTERS - 1, Math.trunc(index)));
  return String.fromCharCode(65 + clamped);
}

/** 为新添加的角色选一个不与当前已有标号冲突的 A..Z 大写字母。 */
export function nextAvailableCharacterLabel(existingLabels: readonly string[]): string {
  const used = new Set(existingLabels.map((label) => label.trim().toUpperCase()));
  for (let i = 0; i < MAX_POSE_CHARACTERS; i += 1) {
    const candidate = defaultCharacterLabel(i);
    if (!used.has(candidate)) return candidate;
  }
  return defaultCharacterLabel(existingLabels.length % MAX_POSE_CHARACTERS);
}

/** 从指定内置色板中选中颜色生成 CharacterColorSpec。 */
export function selectPaletteColor(palette: BuiltinPaletteName, entry: PaletteColor): CharacterColorSpec {
  return {
    hex: normalizeHexColor(entry.hex),
    palette,
    name: entry.name,
  };
}

/** 自定义取色器/手输 HEX 时生成 CharacterColorSpec（无色板代号，提示词输出 #RRGGBB）。 */
export function createCustomColor(hex: string): CharacterColorSpec {
  return {
    hex: normalizeHexColor(hex, "#CCCCCC"),
    palette: "custom",
    name: null,
  };
}

/** 提示词锚定块中该角色的颜色标识：内置色板输出代号（如 blue），自定义色输出 #RRGGBB。 */
export function resolveColorPromptToken(color: CharacterColorSpec): string {
  if (color.palette !== "custom" && color.name && color.name.trim()) {
    return color.name.trim();
  }
  return normalizeHexColor(color.hex);
}
