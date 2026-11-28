/**
 * poses/ 目录结构约定、路径安全校验与多角色 .pose.json 工程文件序列化。
 *
 * 强制约束：
 * 1. 程序自动创建的默认目录恒为纯英文（recent / saved / presets），与软件语言设置无关；
 * 2. 子目录与文件名支持空格、非英文字符及多级分类，仅阻止 Windows 路径非法字符与路径穿越。
 */
import type { PoseLabelStyle, PoseLightingConfig } from "./poseConfig";
import {
  autoAssignCharacterColor,
  defaultCharacterLabel,
  MAX_POSE_CHARACTERS,
  normalizeHexColor,
  type CharacterColorSpec,
} from "./posePalettes";

/** 程序自动创建的 poses 目录与子目录（强制纯英文）。 */
export const BUILTIN_POSE_DIRS = {
  root: "poses",
  recent: "recent",
  saved: "saved",
  presets: "presets",
} as const;

export const MAX_RECENT_POSES = 30;
export const POSE_FILE_EXTENSION = ".pose.json";

const FORBIDDEN_PATH_CHARS = /[\\/:*?"<>|]/;

/**
 * 校验单个文件/目录名片段：
 * - 允许内部空格、中文、日文、字母、数字、常见符号（如括号、下划线、连字符）
 * - 拒绝路径分隔符、Windows 非法字符、控制字符、纯点号（. / ..）与前导点号
 */
export function sanitizePoseSegment(name: string): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 80) return null;
  if (trimmed.startsWith(".") || trimmed.endsWith(".")) return null;
  if (trimmed.replace(/\./g, "") === "") return null;
  if (FORBIDDEN_PATH_CHARS.test(trimmed)) return null;
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed.charCodeAt(i) < 32) return null;
  }
  return trimmed;
}

/**
 * 校验相对子目录路径（允许为空字符串表示根目录，允许多级 '/' 或 '\\' 分隔，允许空格与非英文）。
 * 返回规范化后的 '/' 分隔路径；若任何一级非法则返回 null。
 */
export function sanitizePoseFolderPath(folder: string): string | null {
  if (typeof folder !== "string") return null;
  const normalized = folder.replace(/\\/g, "/").trim().replace(/^\/+|\/+$/g, "");
  if (!normalized) return "";
  const parts = normalized.split("/");
  const clean: string[] = [];
  for (const part of parts) {
    const safe = sanitizePoseSegment(part);
    if (!safe) return null;
    clean.push(safe);
  }
  return clean.join("/");
}

export interface PoseMeshParams {
  age: number;
  gender: number;
  weight: number;
  muscle: number;
  height: number;
  breast_size: number;
  firmness: number;
  show_genitals: boolean;
}

export interface PoseProportions {
  head: number;
  neck: number;
  shoulder: number;
  spine: number;
  upper_arm: number;
  forearm: number;
  thigh: number;
  shin: number;
  /** 四肢粗细补偿（0.6 ~ 2.0，默认 1.0；Q 版 2~4 头身时加粗可避免四肢过细）。 */
  limb_thickness: number;
  /** 手脚大小（0.6 ~ 1.8，默认 1.0）。 */
  hand_foot: number;
}

export interface PoseTransform {
  x: number;
  y: number;
  z: number;
  zoom: number;
}

export interface PoseGrips {
  l: number;
  r: number;
}

export interface PoseCameraState {
  yaw: number;
  pitch: number;
  zoom: number;
  offsetX: number;
  offsetY: number;
}

export interface PoseCharacterRecord {
  id: string;
  label: string;
  labelStyle: PoseLabelStyle;
  color: CharacterColorSpec;
  mesh: PoseMeshParams;
  proportions: PoseProportions;
  transform: PoseTransform;
  grips: PoseGrips;
  pose: Record<string, unknown> | null;
  openpose?: Record<string, unknown> | null;
}

export interface PoseProjectDocument {
  kind: "grsai-pose-project";
  version: 2;
  name: string;
  savedAt: number;
  thumbnail: string;
  includeShape: boolean;
  width: number;
  height: number;
  camera: PoseCameraState;
  lighting?: PoseLightingConfig;
  characters: PoseCharacterRecord[];
  activeIndex: number;
}

export const DEFAULT_POSE_MESH: PoseMeshParams = {
  age: 25,
  gender: 0.5,
  weight: 0.5,
  muscle: 0.5,
  height: 0.5,
  breast_size: 0,
  firmness: 0.5,
  show_genitals: false,
};

export const DEFAULT_POSE_PROPORTIONS: PoseProportions = {
  head: 1,
  neck: 1,
  shoulder: 1,
  spine: 1,
  upper_arm: 1,
  forearm: 1,
  thigh: 1,
  shin: 1,
  limb_thickness: 1,
  hand_foot: 1,
};

export const DEFAULT_POSE_TRANSFORM: PoseTransform = {
  x: 0,
  y: 0,
  z: 0,
  zoom: 1,
};

export const DEFAULT_POSE_CAMERA: PoseCameraState = {
  yaw: 0,
  pitch: 0,
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCharacter(
  raw: unknown,
  index: number,
  fallbackLabelStyle: PoseLabelStyle,
  usedHexes: string[],
): PoseCharacterRecord {
  const src = isRecord(raw) ? raw : {};
  const autoColor = autoAssignCharacterColor(usedHexes, index);
  let color: CharacterColorSpec = autoColor;
  if (isRecord(src.color) && typeof src.color.hex === "string") {
    const palette =
      src.color.palette === "Tableau10" ||
      src.color.palette === "Tableau20" ||
      src.color.palette === "Rainbow_type1" ||
      src.color.palette === "Rainbow_type2" ||
      src.color.palette === "CSS_148_colors" ||
      src.color.palette === "custom"
        ? src.color.palette
        : "custom";
    color = {
      hex: normalizeHexColor(src.color.hex, autoColor.hex),
      palette,
      name: typeof src.color.name === "string" && palette !== "custom" ? src.color.name : null,
    };
  }
  usedHexes.push(color.hex);

  const rawLabelStyle = isRecord(src.labelStyle) ? src.labelStyle : {};
  const pos = rawLabelStyle.position;
  const labelStyle: PoseLabelStyle = {
    position:
      pos === "above" || pos === "below" || pos === "forehead" || pos === "chest"
        ? pos
        : fallbackLabelStyle.position,
    color: typeof rawLabelStyle.color === "string" ? normalizeHexColor(rawLabelStyle.color, fallbackLabelStyle.color) : fallbackLabelStyle.color,
    fontFamily: typeof rawLabelStyle.fontFamily === "string" && rawLabelStyle.fontFamily.trim()
      ? rawLabelStyle.fontFamily.trim()
      : fallbackLabelStyle.fontFamily,
    fontSize: typeof rawLabelStyle.fontSize === "number" && Number.isFinite(rawLabelStyle.fontSize)
      ? Math.max(1, Math.min(5000, Math.round(rawLabelStyle.fontSize)))
      : fallbackLabelStyle.fontSize,
    rotation: typeof rawLabelStyle.rotation === "number" && Number.isFinite(rawLabelStyle.rotation)
      ? Math.max(-180, Math.min(180, Math.round(rawLabelStyle.rotation)))
      : fallbackLabelStyle.rotation,
  };

  const rawMesh = isRecord(src.mesh) ? src.mesh : {};
  const rawProp = isRecord(src.proportions) ? src.proportions : {};
  const rawTf = isRecord(src.transform) ? src.transform : {};
  const rawGrips = isRecord(src.grips) ? src.grips : {};

  return {
    id: typeof src.id === "string" && src.id.trim() ? src.id : `char-${index + 1}`,
    label: typeof src.label === "string" ? src.label : defaultCharacterLabel(index),
    labelStyle,
    color,
    mesh: {
      age: typeof rawMesh.age === "number" ? rawMesh.age : DEFAULT_POSE_MESH.age,
      gender: typeof rawMesh.gender === "number" ? rawMesh.gender : DEFAULT_POSE_MESH.gender,
      weight: typeof rawMesh.weight === "number" ? rawMesh.weight : DEFAULT_POSE_MESH.weight,
      muscle: typeof rawMesh.muscle === "number" ? rawMesh.muscle : DEFAULT_POSE_MESH.muscle,
      height: typeof rawMesh.height === "number" ? rawMesh.height : DEFAULT_POSE_MESH.height,
      breast_size: typeof rawMesh.breast_size === "number" ? rawMesh.breast_size : DEFAULT_POSE_MESH.breast_size,
      firmness: typeof rawMesh.firmness === "number" ? rawMesh.firmness : DEFAULT_POSE_MESH.firmness,
      show_genitals: Boolean(rawMesh.show_genitals),
    },
    proportions: {
      head: typeof rawProp.head === "number" ? rawProp.head : DEFAULT_POSE_PROPORTIONS.head,
      neck: typeof rawProp.neck === "number" ? rawProp.neck : DEFAULT_POSE_PROPORTIONS.neck,
      shoulder: typeof rawProp.shoulder === "number" ? rawProp.shoulder : DEFAULT_POSE_PROPORTIONS.shoulder,
      spine: typeof rawProp.spine === "number" ? rawProp.spine : DEFAULT_POSE_PROPORTIONS.spine,
      upper_arm: typeof rawProp.upper_arm === "number" ? rawProp.upper_arm : DEFAULT_POSE_PROPORTIONS.upper_arm,
      forearm: typeof rawProp.forearm === "number" ? rawProp.forearm : DEFAULT_POSE_PROPORTIONS.forearm,
      thigh: typeof rawProp.thigh === "number" ? rawProp.thigh : DEFAULT_POSE_PROPORTIONS.thigh,
      shin: typeof rawProp.shin === "number" ? rawProp.shin : DEFAULT_POSE_PROPORTIONS.shin,
      limb_thickness: typeof rawProp.limb_thickness === "number" ? rawProp.limb_thickness : DEFAULT_POSE_PROPORTIONS.limb_thickness,
      hand_foot: typeof rawProp.hand_foot === "number" ? rawProp.hand_foot : DEFAULT_POSE_PROPORTIONS.hand_foot,
    },
    transform: {
      x: typeof rawTf.x === "number" ? rawTf.x : DEFAULT_POSE_TRANSFORM.x,
      y: typeof rawTf.y === "number" ? rawTf.y : DEFAULT_POSE_TRANSFORM.y,
      z: typeof rawTf.z === "number" ? rawTf.z : DEFAULT_POSE_TRANSFORM.z,
      zoom: typeof rawTf.zoom === "number" ? rawTf.zoom : DEFAULT_POSE_TRANSFORM.zoom,
    },
    grips: {
      l: typeof rawGrips.l === "number" ? rawGrips.l : 0,
      r: typeof rawGrips.r === "number" ? rawGrips.r : 0,
    },
    pose: isRecord(src.pose) ? src.pose : null,
    openpose: isRecord(src.openpose) ? src.openpose : null,
  };
}

/**
 * 解析 .pose.json 或旧版 ComfyUI-Fisher-Pose 保存的 .json 文件，统一规整为 PoseProjectDocument。
 */
export function parsePoseProjectJson(
  text: string,
  fallbackName: string,
  fallbackLabelStyle: PoseLabelStyle,
): PoseProjectDocument {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error("Invalid pose file format");
  }

  const usedHexes: string[] = [];

  // 新版 grsai-pose-project v2
  if (parsed.kind === "grsai-pose-project" && Array.isArray(parsed.characters) && parsed.characters.length > 0) {
    const characters = parsed.characters
      .slice(0, MAX_POSE_CHARACTERS)
      .map((item, idx) => normalizeCharacter(item, idx, fallbackLabelStyle, usedHexes));
    const rawCam = isRecord(parsed.camera) ? parsed.camera : {};
    return {
      kind: "grsai-pose-project",
      version: 2,
      name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name : fallbackName,
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : Date.now(),
      thumbnail: typeof parsed.thumbnail === "string" ? parsed.thumbnail : "",
      includeShape: parsed.includeShape !== false,
      width: typeof parsed.width === "number" ? parsed.width : 1920,
      height: typeof parsed.height === "number" ? parsed.height : 1080,
      camera: {
        yaw: typeof rawCam.yaw === "number" ? rawCam.yaw : 0,
        pitch: typeof rawCam.pitch === "number" ? rawCam.pitch : 0,
        zoom: typeof rawCam.zoom === "number" ? rawCam.zoom : 1,
        offsetX: typeof rawCam.offsetX === "number" ? rawCam.offsetX : 0,
        offsetY: typeof rawCam.offsetY === "number" ? rawCam.offsetY : 0,
      },
      characters,
      activeIndex:
        typeof parsed.activeIndex === "number" && parsed.activeIndex >= 0 && parsed.activeIndex < characters.length
          ? Math.trunc(parsed.activeIndex)
          : 0,
    };
  }

  // 兼容旧版 ComfyUI-Fisher-Pose (kind === "fisher-saved-pose" 或含 doc 字段)
  const doc = isRecord(parsed.doc) ? parsed.doc : parsed;
  const legacyList = Array.isArray(doc.people) && doc.people.length > 0 ? doc.people : [doc];
  const characters = legacyList
    .slice(0, MAX_POSE_CHARACTERS)
    .map((person, idx) => {
      const p = isRecord(person) ? person : {};
      return normalizeCharacter(
        {
          mesh: p.mesh,
          proportions: p.proportions,
          transform: p.transform,
          pose: p.pose,
          openpose: p.openpose,
          grips: p.grips ?? parsed.grips,
        },
        idx,
        fallbackLabelStyle,
        usedHexes,
      );
    });

  const rawAngle = isRecord(doc.anyAngle) ? doc.anyAngle : {};
  return {
    kind: "grsai-pose-project",
    version: 2,
    name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name : fallbackName,
    savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : Date.now(),
    thumbnail: typeof parsed.thumbnail === "string" ? parsed.thumbnail : "",
    includeShape: parsed.includeShape !== false,
    width: typeof doc.width === "number" ? doc.width : 1920,
    height: typeof doc.height === "number" ? doc.height : 1080,
    camera: {
      yaw: typeof rawAngle.yaw === "number" ? rawAngle.yaw : 0,
      pitch: typeof rawAngle.pitch === "number" ? rawAngle.pitch : 0,
      zoom: typeof rawAngle.zoom === "number" ? rawAngle.zoom : 1,
      offsetX: typeof rawAngle.offsetX === "number" ? rawAngle.offsetX : 0,
      offsetY: typeof rawAngle.offsetY === "number" ? rawAngle.offsetY : 0,
    },
    characters,
    activeIndex: 0,
  };
}
