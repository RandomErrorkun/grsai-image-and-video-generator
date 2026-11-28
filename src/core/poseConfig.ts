/**
 * 3D 姿势工坊的持久化配置模型、光照预设与以 1920×1080 为基准的导出裁切规则。
 *
 * 存放在 grsai_config.json 的独立 "pose" 字典块中，与设置/图像/视频/漫画配置完全隔离。
 */

export type PoseLightPreset = "studio" | "soft_front" | "dramatic_side" | "flat" | "custom";

export interface PoseLightingConfig {
  preset: PoseLightPreset;
  ambientIntensity: number;
  keyIntensity: number;
  /** 主光水平方位角（度，-180 ~ 180，0 为正前方，正数偏向右侧）。 */
  keyAzimuth: number;
  /** 主光仰角（度，-45 ~ 85）。 */
  keyElevation: number;
  fillIntensity: number;
  rimIntensity: number;
  /** 轮廓暗边系数（0 ~ 0.6），增强人体转折边缘的立体感。 */
  rimDarken: number;
  /** 3D 导出背景色（#RRGGBB），默认纯白 #FFFFFF。 */
  background: string;
  /** 是否显示 3D 背景球形经纬网格（VNCCS Skydome），默认关闭。 */
  showSkydome: boolean;
}

export type PoseLabelPosition = "above" | "below" | "forehead" | "chest";

export interface PoseLabelStyle {
  position: PoseLabelPosition;
  color: string;
  fontFamily: string;
  fontSize: number;
  /** 旋转角度（度，-180 ~ 180）。 */
  rotation: number;
}

export interface PoseWatermarkStyle {
  fontFamily: string;
  /** 水印像素字号（1 ~ 5000，默认 72px）。 */
  fontSize: number;
}

export interface PoseExportModes {
  mannequin: boolean;
  mannequinSkeleton: boolean;
  openpose: boolean;
  depth: boolean;
}

export type PosePositionStrategy = "rank_depth" | "grid9";

export interface PosePromptAnchorConfig {
  enabled: boolean;
  useColor: boolean;
  useLabel: boolean;
  usePosition: boolean;
  positionStrategy: PosePositionStrategy;
}

export interface PoseStudioConfig {
  exportWidth: number;
  exportHeight: number;
  exportModes: PoseExportModes;
  /** 是否在导出参考图某个不遮挡模型的角落添加红色「姿势参考 / Pose Refs」水印。 */
  cornerWatermark: boolean;
  watermarkStyle: PoseWatermarkStyle;
  lighting: PoseLightingConfig;
  labelDefaults: PoseLabelStyle;
  promptAnchor: PosePromptAnchorConfig;
}

export const POSE_BASE_MAX_WIDTH = 1920;
export const POSE_BASE_MAX_HEIGHT = 1080;

export const POSE_ASPECT_PRESETS: ReadonlyArray<{ label: string; ratio: number }> = [
  { label: "16:9", ratio: 16 / 9 },
  { label: "4:3", ratio: 4 / 3 },
  { label: "1:1", ratio: 1 },
  { label: "3:4", ratio: 3 / 4 },
  { label: "9:16", ratio: 9 / 16 },
  { label: "21:9", ratio: 21 / 9 },
];

export const POSE_LIGHTING_PRESETS: Readonly<Record<Exclude<PoseLightPreset, "custom">, PoseLightingConfig>> = {
  studio: {
    preset: "studio",
    ambientIntensity: 0.36,
    keyIntensity: 0.9,
    keyAzimuth: 36,
    keyElevation: 46,
    fillIntensity: 0.34,
    rimIntensity: 0.48,
    rimDarken: 0.34,
    background: "#FFFFFF",
    showSkydome: false,
  },
  soft_front: {
    preset: "soft_front",
    ambientIntensity: 0.56,
    keyIntensity: 0.58,
    keyAzimuth: 15,
    keyElevation: 30,
    fillIntensity: 0.3,
    rimIntensity: 0.25,
    rimDarken: 0.24,
    background: "#FFFFFF",
    showSkydome: false,
  },
  dramatic_side: {
    preset: "dramatic_side",
    ambientIntensity: 0.2,
    keyIntensity: 1.15,
    keyAzimuth: 68,
    keyElevation: 38,
    fillIntensity: 0.16,
    rimIntensity: 0.65,
    rimDarken: 0.45,
    background: "#FFFFFF",
    showSkydome: false,
  },
  flat: {
    preset: "flat",
    ambientIntensity: 1.0,
    keyIntensity: 0,
    keyAzimuth: 0,
    keyElevation: 30,
    fillIntensity: 0,
    rimIntensity: 0,
    rimDarken: 0.12,
    background: "#FFFFFF",
    showSkydome: false,
  },
};

export const DEFAULT_POSE_CONFIG: PoseStudioConfig = {
  exportWidth: POSE_BASE_MAX_WIDTH,
  exportHeight: POSE_BASE_MAX_HEIGHT,
  exportModes: {
    mannequin: true,
    mannequinSkeleton: false,
    openpose: false,
    depth: false,
  },
  cornerWatermark: false,
  watermarkStyle: {
    fontFamily: "JetBrainsMapleMono",
    fontSize: 72,
  },
  lighting: { ...POSE_LIGHTING_PRESETS.studio },
  labelDefaults: {
    position: "above",
    color: "#E5252A",
    fontFamily: "JetBrainsMapleMono",
    fontSize: 32,
    rotation: 0,
  },
  promptAnchor: {
    enabled: true,
    useColor: true,
    useLabel: true,
    usePosition: true,
    positionStrategy: "rank_depth",
  },
};

export const POSE_AREA_RATIO_MIN = 0.0001;
export const POSE_AREA_RATIO_MAX = 0.9999;

/** 将面积占比钳在 (0, 1) 开区间内（0.0001 ~ 0.9999）并最多保留 4 位小数。 */
export function clampOpenUnitRatio(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    if (Number.isFinite(value)) {
      if (value <= 0) return POSE_AREA_RATIO_MIN;
      if (value >= 1) return POSE_AREA_RATIO_MAX;
    }
    return fallback;
  }
  const rounded = Math.round(value * 10000) / 10000;
  return Math.max(POSE_AREA_RATIO_MIN, Math.min(POSE_AREA_RATIO_MAX, rounded));
}

/** 估算字符串的等效 em 宽度（全角/CJK 按 1.0em，拉丁半角按 0.62em）。 */
export function estimateTextEmWidth(text: string): number {
  let units = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    units += code > 0x2e80 ? 1.0 : 0.62;
  }
  return Math.max(0.62, units);
}

/**
 * 根据画布分辨率与目标文字面积占比 r ∈ (0, 1) 反推像素字号（1 ~ 5000）：
 * 满足 (emWidth * s) * (1.15 * s) ≈ W * H * r。
 */
export function computeFontSizeForAreaRatio(
  width: number,
  height: number,
  areaRatio: number,
  sampleText: string,
): number {
  const safeRatio = clampOpenUnitRatio(areaRatio, 0.01);
  const imageArea = Math.max(64 * 64, width * height);
  const targetArea = imageArea * safeRatio;
  const emWidth = estimateTextEmWidth(sampleText);
  const size = Math.sqrt(targetArea / (emWidth * 1.15));
  return Math.max(1, Math.min(5000, Math.round(size)));
}

export interface ThreeLightDescriptor {
  type: "ambient" | "directional";
  color: string;
  intensity: number;
  x?: number;
  y?: number;
  z?: number;
}

/** 将结构化光照面板参数换算为 Three.js 灯光描述数组。 */
export function buildPoseLights(lighting: PoseLightingConfig): ThreeLightDescriptor[] {
  const lights: ThreeLightDescriptor[] = [
    { type: "ambient", color: "#ffffff", intensity: clampNumber(lighting.ambientIntensity, 0.05, 1.5) },
  ];
  const az = (clampNumber(lighting.keyAzimuth, -180, 180) * Math.PI) / 180;
  const el = (clampNumber(lighting.keyElevation, -45, 85) * Math.PI) / 180;
  const radius = 6;
  const cosEl = Math.cos(el);
  const kx = radius * Math.sin(az) * cosEl;
  const ky = radius * Math.sin(el);
  const kz = radius * Math.cos(az) * cosEl;

  if (lighting.keyIntensity > 0.001) {
    lights.push({
      type: "directional",
      color: "#fffcf5",
      intensity: clampNumber(lighting.keyIntensity, 0, 2.5),
      x: kx,
      y: ky,
      z: kz,
    });
  }
  if (lighting.fillIntensity > 0.001) {
    const fillAz = az - (110 * Math.PI) / 180;
    lights.push({
      type: "directional",
      color: "#dce8ff",
      intensity: clampNumber(lighting.fillIntensity, 0, 2.0),
      x: radius * Math.sin(fillAz) * 0.9,
      y: 2.2,
      z: radius * Math.cos(fillAz) * 0.9,
    });
  }
  if (lighting.rimIntensity > 0.001) {
    const rimAz = az + Math.PI;
    lights.push({
      type: "directional",
      color: "#eef4ff",
      intensity: clampNumber(lighting.rimIntensity, 0, 2.0),
      x: radius * Math.sin(rimAz) * 0.85,
      y: 4.0,
      z: radius * Math.cos(rimAz) * 0.85,
    });
  }
  return lights;
}

/**
 * 以 1920×1080 为标准上界向下内接裁切，算出偶数分辨率：
 * 16:9 -> 1920×1080，4:3 -> 1440×1080，1:1 -> 1080×1080，3:4 -> 810×1080，9:16 -> 608×1080，21:9 -> 1920×822。
 */
export function sizeForAspectInBounds(
  aspect: number,
  maxWidth = POSE_BASE_MAX_WIDTH,
  maxHeight = POSE_BASE_MAX_HEIGHT,
): [number, number] {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const boundAspect = maxWidth / maxHeight;
  let width: number;
  let height: number;
  if (safeAspect >= boundAspect) {
    width = maxWidth;
    height = maxWidth / safeAspect;
  } else {
    height = maxHeight;
    width = maxHeight * safeAspect;
  }
  return [clampExportDimension(width), clampExportDimension(height)];
}

export function clampExportDimension(value: number): number {
  const rounded = Math.round(value / 2) * 2;
  return Math.max(64, Math.min(4096, Number.isFinite(rounded) ? rounded : 1080));
}

function clampNumber(value: unknown, min: number, max: number, fallback = min): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, numeric));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readHex(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toUpperCase() : fallback;
}

/** 从配置 JSON 安全恢复 PoseStudioConfig，任何缺键或脏字段都自动补齐回默认值。 */
export function normalizePoseConfig(raw: unknown): PoseStudioConfig {
  const src = isRecord(raw) ? raw : {};
  const rawModes = isRecord(src.exportModes) ? src.exportModes : {};
  const rawLight = isRecord(src.lighting) ? src.lighting : {};
  const rawLabel = isRecord(src.labelDefaults) ? src.labelDefaults : {};
  const rawWatermark = isRecord(src.watermarkStyle) ? src.watermarkStyle : {};
  const rawPrompt = isRecord(src.promptAnchor) ? src.promptAnchor : {};

  const presetCandidate = rawLight.preset;
  const preset: PoseLightPreset =
    presetCandidate === "studio" ||
    presetCandidate === "soft_front" ||
    presetCandidate === "dramatic_side" ||
    presetCandidate === "flat" ||
    presetCandidate === "custom"
      ? presetCandidate
      : DEFAULT_POSE_CONFIG.lighting.preset;

  const posCandidate = rawLabel.position;
  const position: PoseLabelPosition =
    posCandidate === "above" ||
    posCandidate === "below" ||
    posCandidate === "forehead" ||
    posCandidate === "chest"
      ? posCandidate
      : DEFAULT_POSE_CONFIG.labelDefaults.position;

  const strategyCandidate = rawPrompt.positionStrategy;
  const positionStrategy: PosePositionStrategy =
    strategyCandidate === "grid9" ? "grid9" : "rank_depth";

  return {
    exportWidth: clampExportDimension(
      typeof src.exportWidth === "number" ? src.exportWidth : DEFAULT_POSE_CONFIG.exportWidth,
    ),
    exportHeight: clampExportDimension(
      typeof src.exportHeight === "number" ? src.exportHeight : DEFAULT_POSE_CONFIG.exportHeight,
    ),
    exportModes: {
      mannequin:
        typeof rawModes.mannequin === "boolean"
          ? rawModes.mannequin
          : DEFAULT_POSE_CONFIG.exportModes.mannequin,
      mannequinSkeleton:
        typeof rawModes.mannequinSkeleton === "boolean"
          ? rawModes.mannequinSkeleton
          : DEFAULT_POSE_CONFIG.exportModes.mannequinSkeleton,
      openpose:
        typeof rawModes.openpose === "boolean"
          ? rawModes.openpose
          : DEFAULT_POSE_CONFIG.exportModes.openpose,
      depth:
        typeof rawModes.depth === "boolean"
          ? rawModes.depth
          : DEFAULT_POSE_CONFIG.exportModes.depth,
    },
    cornerWatermark:
      typeof src.cornerWatermark === "boolean"
        ? src.cornerWatermark
        : DEFAULT_POSE_CONFIG.cornerWatermark,
    watermarkStyle: {
      fontFamily:
        typeof rawWatermark.fontFamily === "string" && rawWatermark.fontFamily.trim()
          ? rawWatermark.fontFamily.trim()
          : DEFAULT_POSE_CONFIG.watermarkStyle.fontFamily,
      fontSize: Math.round(
        clampNumber(rawWatermark.fontSize, 1, 5000, DEFAULT_POSE_CONFIG.watermarkStyle.fontSize),
      ),
    },
    lighting: {
      preset,
      ambientIntensity: clampNumber(rawLight.ambientIntensity, 0.05, 1.5, DEFAULT_POSE_CONFIG.lighting.ambientIntensity),
      keyIntensity: clampNumber(rawLight.keyIntensity, 0, 2.5, DEFAULT_POSE_CONFIG.lighting.keyIntensity),
      keyAzimuth: clampNumber(rawLight.keyAzimuth, -180, 180, DEFAULT_POSE_CONFIG.lighting.keyAzimuth),
      keyElevation: clampNumber(rawLight.keyElevation, -45, 85, DEFAULT_POSE_CONFIG.lighting.keyElevation),
      fillIntensity: clampNumber(rawLight.fillIntensity, 0, 2.0, DEFAULT_POSE_CONFIG.lighting.fillIntensity),
      rimIntensity: clampNumber(rawLight.rimIntensity, 0, 2.0, DEFAULT_POSE_CONFIG.lighting.rimIntensity),
      rimDarken: clampNumber(rawLight.rimDarken, 0, 0.65, DEFAULT_POSE_CONFIG.lighting.rimDarken),
      background: readHex(rawLight.background, DEFAULT_POSE_CONFIG.lighting.background),
      showSkydome: typeof rawLight.showSkydome === "boolean" ? rawLight.showSkydome : false,
    },
    labelDefaults: {
      position,
      color: readHex(rawLabel.color, DEFAULT_POSE_CONFIG.labelDefaults.color),
      fontFamily:
        typeof rawLabel.fontFamily === "string" && rawLabel.fontFamily.trim()
          ? rawLabel.fontFamily.trim()
          : DEFAULT_POSE_CONFIG.labelDefaults.fontFamily,
      fontSize: Math.round(clampNumber(rawLabel.fontSize, 1, 5000, DEFAULT_POSE_CONFIG.labelDefaults.fontSize)),
      rotation: Math.round(clampNumber(rawLabel.rotation, -180, 180, DEFAULT_POSE_CONFIG.labelDefaults.rotation)),
    },
    promptAnchor: {
      enabled:
        typeof rawPrompt.enabled === "boolean"
          ? rawPrompt.enabled
          : DEFAULT_POSE_CONFIG.promptAnchor.enabled,
      useColor:
        typeof rawPrompt.useColor === "boolean"
          ? rawPrompt.useColor
          : DEFAULT_POSE_CONFIG.promptAnchor.useColor,
      useLabel:
        typeof rawPrompt.useLabel === "boolean"
          ? rawPrompt.useLabel
          : DEFAULT_POSE_CONFIG.promptAnchor.useLabel,
      usePosition:
        typeof rawPrompt.usePosition === "boolean"
          ? rawPrompt.usePosition
          : DEFAULT_POSE_CONFIG.promptAnchor.usePosition,
      positionStrategy,
    },
  };
}
