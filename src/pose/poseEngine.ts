/**
 * 3D 多角色姿势引擎控制器（封装 PoseViewerCore、26 人增量切换、MakeHuman 缓存、OpenPose 导入与 4 模态渲染）。
 */
import type * as THREE_NS from "three";
import {
  buildPoseLights,
  computeFontSizeForAreaRatio,
  type PoseLabelStyle,
  type PoseLightingConfig,
  type PoseWatermarkStyle,
} from "../core/poseConfig";
import {
  autoAssignCharacterColor,
  MAX_POSE_CHARACTERS,
  nextAvailableCharacterLabel,
  type CharacterColorSpec,
} from "../core/posePalettes";
import type { ProjectedPoseCharacter } from "../core/posePrompt";
import {
  DEFAULT_POSE_CAMERA,
  DEFAULT_POSE_MESH,
  DEFAULT_POSE_PROPORTIONS,
  DEFAULT_POSE_TRANSFORM,
  type PoseCameraState,
  type PoseCharacterRecord,
  type PoseMeshParams,
  type PoseProjectDocument,
  type PoseProportions,
  type PoseTransform,
} from "../core/poseStorage";
import {
  projectPoseCharacters,
  renderPoseMode,
  type PoseExportModeKey,
  type PoseSceneCharacterMeta,
} from "./poseRenderer";
import { COMMON_POSES, directionKeypoints, type CommonPoseSpec } from "./vendor/common-poses.mjs";
import { createMovementGizmo, type MovementGizmo } from "./vendor/movement-gizmo.mjs";
import { liftOpenPose, WORLD_KEYPOINT_NAMES } from "./vendor/openpose-lift.mjs";
import { readSkeletonImage } from "./vendor/pose-import.mjs";
import { createReferenceOverlay, type ReferenceOverlay } from "./vendor/reference-overlay.mjs";
import { HAND_PRESETS } from "./vendor/vnccs_hand_presets.mjs";
import {
  buildStaticModelData,
  parseMorphPack,
  solveMorph,
  type MorphPack,
  type SolvedMorph,
} from "./vendor/vnccs_pose_morph_runtime.mjs";
import { PoseViewerCore } from "./vendor/vnccs_pose_studio_core.mjs";

const PROPORTION_GROUPS: Record<string, string[]> = {
  shoulder: ["shoulder_l", "shoulder_r"],
  spine: ["spine"],
  upper_arm: ["upper_arm_l", "upper_arm_r"],
  forearm: ["forearm_l", "forearm_r"],
  thigh: ["thigh_l", "thigh_r"],
  shin: ["shin_l", "shin_r"],
};

const JOINT_BONES: Record<string, string> = {
  ls: "upperarm_l",
  le: "lowerarm_l",
  lw: "hand_l",
  rs: "upperarm_r",
  re: "lowerarm_r",
  rw: "hand_r",
  lh: "thigh_l",
  lk: "calf_l",
  la: "foot_l",
  rh: "thigh_r",
  rk: "calf_r",
  ra: "foot_r",
};

export interface PoseEngineCallbacks {
  onStateChange(): void;
  onBoneSelected(boneName: string | null): void;
  onPreviewInvalidated(): void;
}

function cloneRecord<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function rotationsOnly(pose: Record<string, unknown> | null): Record<string, unknown> {
  if (!pose) return {};
  const copy = { ...pose };
  delete copy.bonePositions;
  delete copy.ikEffectorPositions;
  delete copy.poleTargetPositions;
  delete copy.hipBonePosition;
  delete copy.camera;
  delete copy.cameraParams;
  return copy;
}

/** 根据新增角色的顺序生成不重叠的默认 X/Z 站位。 */
function defaultSpawnTransform(index: number): PoseTransform {
  if (index === 0) return { ...DEFAULT_POSE_TRANSFORM };
  const ring = Math.floor((index - 1) / 4);
  const slot = (index - 1) % 4;
  const side = slot % 2 === 0 ? 1 : -1;
  const rank = Math.floor(slot / 2) + 1;
  const x = side * (0.72 * rank + ring * 0.28);
  const z = -ring * 0.65;
  return { x, y: 0, z, zoom: 1 };
}

export class PoseEngine {
  readonly viewer: PoseViewerCore;
  private pack: MorphPack | null = null;
  private morphCache = new Map<string, SolvedMorph>();
  private movementGizmo: MovementGizmo | null = null;
  private referenceOverlay: ReferenceOverlay | null = null;
  private callbacks: PoseEngineCallbacks;
  private disposed = false;
  private nextCharSeq = 2;

  characters: PoseCharacterRecord[] = [];
  activeIndex = 0;
  camera: PoseCameraState = { ...DEFAULT_POSE_CAMERA };
  lighting: PoseLightingConfig;
  exportWidth: number;
  exportHeight: number;
  autoFit = true;
  editMode: "pose" | "camera" = "pose";
  poseTool: "joints" | "move" = "joints";
  selectedBoneName: string | null = null;
  ready = false;

  private cleanupInteraction: (() => void) | null = null;
  private morphTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    initial: {
      width: number;
      height: number;
      lighting: PoseLightingConfig;
      labelDefaults: PoseLabelStyle;
    },
    callbacks: PoseEngineCallbacks,
  ) {
    this.callbacks = callbacks;
    this.exportWidth = initial.width;
    this.exportHeight = initial.height;
    this.lighting = { ...initial.lighting };

    const firstColor = autoAssignCharacterColor([], 0);
    this.characters = [
      {
        id: "char-1",
        label: "A",
        labelStyle: { ...initial.labelDefaults },
        color: firstColor,
        mesh: { ...DEFAULT_POSE_MESH },
        proportions: { ...DEFAULT_POSE_PROPORTIONS },
        transform: { ...DEFAULT_POSE_TRANSFORM },
        grips: { l: 0, r: 0 },
        pose: null,
        openpose: null,
      },
    ];

    this.viewer = new PoseViewerCore(canvas, {
      skinMode: "flat_color",
      enableTextureSkinning: false,
      showSkeletonHelper: true,
      showCaptureFrame: true,
      syncMode: "end",
      useHandControlPopover: false,
      captureHistoryContext: () => {
        const active = this.activeCharacter();
        return {
          transform: { ...active.transform },
          mesh: { ...active.mesh },
          proportions: { ...active.proportions },
        };
      },
      onHistoryRestore: (pose: Record<string, unknown>) => {
        const editorState = pose.editorState as
          | { transform?: PoseTransform; mesh?: PoseMeshParams; proportions?: PoseProportions }
          | undefined;
        const active = this.activeCharacter();
        if (editorState?.transform) {
          active.transform = { ...editorState.transform };
        }
        if (
          editorState?.mesh &&
          (JSON.stringify(active.mesh) !== JSON.stringify(editorState.mesh) ||
            JSON.stringify(active.proportions) !== JSON.stringify(editorState.proportions))
        ) {
          active.mesh = { ...editorState.mesh };
          if (editorState.proportions) active.proportions = { ...editorState.proportions };
          this.loadActiveModel(pose);
        }
        this.viewer.setActiveCharacterAppearance({
          color: active.color.hex,
          transform: active.transform,
        });
        this.updateCaptureCamera(false);
        this.callbacks.onStateChange();
        this.callbacks.onPreviewInvalidated();
      },
      onBoneSelectionChange: ({ boneName }: { boneName: string | null }) => {
        this.selectedBoneName = boneName;
        this.callbacks.onBoneSelected(boneName);
      },
      onPoseChange: () => {
        this.callbacks.onStateChange();
        this.callbacks.onPreviewInvalidated();
      },
    });
    this.viewer.maxHistory = 60;
  }

  activeCharacter(): PoseCharacterRecord {
    return this.characters[this.activeIndex] ?? this.characters[0];
  }

  async init(bodyPackBuffer: ArrayBuffer): Promise<void> {
    if (!this.viewer.initialized) {
      await this.viewer.init();
    }
    if (this.disposed) return;
    if (!this.viewer.initialized || !this.viewer.THREE || !this.viewer.scene) {
      throw new Error("Failed to initialize Three.js WebGL viewport.");
    }

    this.pack = parseMorphPack(bodyPackBuffer);
    this.movementGizmo = createMovementGizmo(this.viewer, {
      getTransform: () => ({ ...this.activeCharacter().transform }),
      onStart: () => {
        this.autoFit = false;
        this.viewer.recordState();
      },
      onChange: (nextTransform) => {
        const active = this.activeCharacter();
        active.transform = { ...nextTransform };
        this.viewer.setActiveCharacterAppearance({
          color: active.color.hex,
          transform: active.transform,
        });
        this.callbacks.onStateChange();
        this.callbacks.onPreviewInvalidated();
      },
    });
    this.referenceOverlay = createReferenceOverlay(this.viewer);
    this.setupViewportInteraction();

    this.loadActiveModel(null);
    this.applyLighting(this.lighting);
    this.fitAllCharacters(true);
    this.ready = true;
    this.callbacks.onStateChange();
    this.callbacks.onPreviewInvalidated();
  }

  private getSolvedMorph(mesh: PoseMeshParams): SolvedMorph {
    if (!this.pack) throw new Error("Body pack not loaded");
    const key = JSON.stringify(mesh);
    const cached = this.morphCache.get(key);
    if (cached) return cached;
    const solved = solveMorph(this.pack, mesh as unknown as Record<string, unknown>);
    if (this.morphCache.size >= 32) {
      const oldest = this.morphCache.keys().next().value;
      if (oldest) this.morphCache.delete(oldest);
    }
    this.morphCache.set(key, solved);
    return solved;
  }

  private buildModelData(morph: SolvedMorph): Record<string, unknown> {
    if (!this.pack) throw new Error("Body pack not loaded");
    const staticData = buildStaticModelData(this.pack, morph.includeGenitals);
    const bones = staticData.bones.map((bone, index) => {
      const headPos = Array.from(morph.bonePositions.subarray(index * 6, index * 6 + 3));
      const tailPos = Array.from(morph.bonePositions.subarray(index * 6 + 3, index * 6 + 6));
      return {
        name: bone.name,
        parent: bone.parent || null,
        headPos,
        tailPos,
        length: Math.hypot(
          tailPos[0] - headPos[0],
          tailPos[1] - headPos[1],
          tailPos[2] - headPos[2],
        ),
      };
    });
    return {
      vertices: morph.vertices,
      uvs: staticData.uvs,
      indices: staticData.indices,
      bones,
      skinIndices: staticData.skinIndices,
      skinWeights: staticData.skinWeights,
      landmarks: morph.landmarks || {},
      landmark_indices: morph.landmarkIndices || {},
    };
  }

  private applyNeck(neckScale: number): void {
    this.viewer._setBoneOffsetScale("head", neckScale);
    for (const bone of this.viewer.boneList) bone.updateMatrixWorld(true);
    this.viewer.skeleton?.update();
    this.viewer._cacheShapedRestBonePositions(["head"]);
    this.viewer.updateIKEffectorPositions?.();
    this.viewer.requestRender();
  }

  private snapshotActivePose(): Record<string, unknown> {
    const raw = this.viewer.getPose();
    const copy = { ...raw };
    delete copy.camera;
    delete copy.cameraParams;
    return copy;
  }

  private loadActiveModel(pose: Record<string, unknown> | null): void {
    if (!this.pack) return;
    const active = this.activeCharacter();
    const morph = this.getSolvedMorph(active.mesh);
    this.viewer.setSkinMode("flat_color");
    this.viewer.headScale = active.proportions.head;
    this.viewer.limbThickness = active.proportions.limb_thickness;
    this.viewer.handScale = active.proportions.hand_foot;
    this.viewer.footScale = active.proportions.hand_foot;
    this.viewer.boneLengthParams = {
      ...this.viewer.boneLengthParams,
      ...Object.fromEntries(
        Object.entries(PROPORTION_GROUPS).flatMap(([key, groups]) =>
          groups.map((group) => [
            group,
            active.proportions[key as keyof PoseProportions] - 0.5,
          ]),
        ),
      ),
    };
    this.viewer.loadData(this.buildModelData(morph), true);
    this.applyNeck(active.proportions.neck);
    this.viewer.updateLimbThickness(active.proportions.limb_thickness);
    this.viewer.updateHandScale(active.proportions.hand_foot);
    this.viewer.updateFootScale(active.proportions.hand_foot);
    this.viewer.updateLights(buildPoseLights(this.lighting) as unknown as Array<Record<string, unknown>>);
    this.viewer.setRimDarken(this.lighting.rimDarken);
    this.viewer.setShowSkydome(this.lighting.showSkydome);
    if (pose) {
      this.viewer.setPose(pose, true);
    }
    this.viewer.setActiveCharacterAppearance({
      color: active.color.hex,
      transform: active.transform,
    });
    this.movementGizmo?.sync(this.poseTool === "move");
  }

  /** 将当前 active 角色状态保存回数组。 */
  syncActiveSnapshot(): void {
    if (!this.ready) return;
    const active = this.activeCharacter();
    active.pose = this.snapshotActivePose();
  }

  /** 增量切换当前编辑的角色（最多 26 人无需全量重建其余被动角色）。 */
  switchCharacter(targetIndex: number): void {
    if (!this.ready || targetIndex === this.activeIndex) return;
    if (targetIndex < 0 || targetIndex >= this.characters.length) return;

    this.syncActiveSnapshot();
    const prev = this.activeCharacter();
    this.viewer.upsertPassiveCharacterFromActive(prev.id, {
      pose: prev.pose ?? {},
      color: prev.color.hex,
      transform: prev.transform,
    });

    this.activeIndex = targetIndex;
    const next = this.activeCharacter();
    this.viewer.removePassiveCharacter(next.id);
    this.loadActiveModel(next.pose);
    this.selectedBoneName = null;
    this.callbacks.onBoneSelected(null);
    this.callbacks.onStateChange();
    this.callbacks.onPreviewInvalidated();
  }

  /** 添加新角色（上限 26，自动按 Tableau20深10 → 浅10 → Rainbow_type2前6 配色与 A-Z 标号）。 */
  addCharacter(labelDefaults: PoseLabelStyle, duplicateFromActive = false): boolean {
    if (!this.ready || this.characters.length >= MAX_POSE_CHARACTERS) return false;
    this.syncActiveSnapshot();
    const prev = this.activeCharacter();
    this.viewer.upsertPassiveCharacterFromActive(prev.id, {
      pose: prev.pose ?? {},
      color: prev.color.hex,
      transform: prev.transform,
    });

    const usedHexes = this.characters.map((c) => c.color.hex);
    const existingLabels = this.characters.map((c) => c.label);
    const newIndex = this.characters.length;
    const color = autoAssignCharacterColor(usedHexes, newIndex);
    const label = nextAvailableCharacterLabel(existingLabels);
    const id = `char-${this.nextCharSeq++}`;

    const spawn = defaultSpawnTransform(newIndex);
    const created: PoseCharacterRecord = duplicateFromActive
      ? {
          ...cloneRecord(prev),
          id,
          label,
          color,
          transform: { ...prev.transform, x: prev.transform.x + 0.72 },
        }
      : {
          id,
          label,
          labelStyle: { ...labelDefaults },
          color,
          mesh: { ...DEFAULT_POSE_MESH },
          proportions: { ...DEFAULT_POSE_PROPORTIONS },
          transform: spawn,
          grips: { l: 0, r: 0 },
          pose: null,
          openpose: null,
        };

    this.characters.push(created);
    this.activeIndex = this.characters.length - 1;
    this.loadActiveModel(created.pose);
    if (this.autoFit) {
      this.fitAllCharacters(false);
    }
    this.callbacks.onStateChange();
    this.callbacks.onPreviewInvalidated();
    return true;
  }

  /** 删除指定角色（至少保留 1 个角色）。 */
  removeCharacter(index: number): boolean {
    if (!this.ready || this.characters.length <= 1) return false;
    if (index < 0 || index >= this.characters.length) return false;

    const target = this.characters[index];
    if (index === this.activeIndex) {
      this.characters.splice(index, 1);
      this.activeIndex = Math.max(0, Math.min(index, this.characters.length - 1));
      const next = this.activeCharacter();
      this.viewer.removePassiveCharacter(next.id);
      this.loadActiveModel(next.pose);
    } else {
      this.viewer.removePassiveCharacter(target.id);
      this.characters.splice(index, 1);
      if (index < this.activeIndex) {
        this.activeIndex -= 1;
      }
    }
    this.selectedBoneName = null;
    this.callbacks.onBoneSelected(null);
    if (this.autoFit) {
      this.fitAllCharacters(false);
    }
    this.callbacks.onStateChange();
    this.callbacks.onPreviewInvalidated();
    return true;
  }

  setActiveColor(color: CharacterColorSpec): void {
    const active = this.activeCharacter();
    active.color = { ...color };
    this.viewer.setActiveCharacterAppearance({ color: color.hex, transform: active.transform });
    this.callbacks.onStateChange();
    this.callbacks.onPreviewInvalidated();
  }

  setActiveLabel(label: string): void {
    this.activeCharacter().label = label;
    this.callbacks.onStateChange();
    this.callbacks.onPreviewInvalidated();
  }

  setActiveLabelStyle(patch: Partial<PoseLabelStyle>, applyToAll = false): void {
    if (applyToAll) {
      for (const char of this.characters) {
        char.labelStyle = { ...char.labelStyle, ...patch };
      }
    } else {
      const active = this.activeCharacter();
      active.labelStyle = { ...active.labelStyle, ...patch };
    }
    this.callbacks.onStateChange();
    this.callbacks.onPreviewInvalidated();
  }

  /** 分辨率或面积占比变化时，按每个角色各自的标号文字长度分别重算字号，使整体标号面积贴合目标占比。 */
  recomputeAllCharactersLabelFontSize(width: number, height: number, areaRatio: number): number {
    for (const char of this.characters) {
      const sampleText = char.label.trim() || "A";
      const nextSize = computeFontSizeForAreaRatio(width, height, areaRatio, sampleText);
      char.labelStyle = { ...char.labelStyle, fontSize: nextSize };
    }
    this.callbacks.onStateChange();
    this.callbacks.onPreviewInvalidated();
    return this.activeCharacter().labelStyle.fontSize;
  }

  setActiveTransform(patch: Partial<PoseTransform>): void {
    const active = this.activeCharacter();
    active.transform = { ...active.transform, ...patch };
    this.autoFit = false;
    this.viewer.setActiveCharacterAppearance({
      color: active.color.hex,
      transform: active.transform,
    });
    this.movementGizmo?.sync(this.poseTool === "move");
    this.callbacks.onStateChange();
    this.callbacks.onPreviewInvalidated();
  }

  setActiveTurn(degrees: number): void {
    this.viewer.setModelRotation(0, degrees, 0);
    this.callbacks.onStateChange();
    this.callbacks.onPreviewInvalidated();
  }

  getActiveTurn(): number {
    return Math.round(this.viewer.modelRotation?.y || 0);
  }

  setBoneRotation(axis: "x" | "y" | "z", degrees: number): void {
    if (!this.selectedBoneName) return;
    const bone = this.viewer.bones?.[this.selectedBoneName];
    if (!bone) return;
    bone.rotation[axis] = (degrees * Math.PI) / 180;
    bone.updateMatrixWorld(true);
    this.viewer.updateIKEffectorPositions?.();
    this.viewer.updateMarkers?.();
    this.viewer.requestRender();
    this.callbacks.onStateChange();
    this.callbacks.onPreviewInvalidated();
  }

  getSelectedBoneRotation(): { x: number; y: number; z: number } | null {
    if (!this.selectedBoneName) return null;
    const bone = this.viewer.bones?.[this.selectedBoneName];
    if (!bone) return null;
    return {
      x: Math.round((bone.rotation.x * 180) / Math.PI),
      y: Math.round((bone.rotation.y * 180) / Math.PI),
      z: Math.round((bone.rotation.z * 180) / Math.PI),
    };
  }

  resetSelectedBone(): void {
    this.viewer.recordState();
    this.viewer.resetSelectedBone();
    this.callbacks.onStateChange();
    this.callbacks.onPreviewInvalidated();
  }

  resetActivePose(): void {
    this.viewer.recordState();
    this.viewer.resetPose();
    this.applyNeck(this.activeCharacter().proportions.neck);
    this.activeCharacter().openpose = null;
    this.callbacks.onStateChange();
    this.callbacks.onPreviewInvalidated();
  }

  applyHandPreset(side: "l" | "r", presetName: "OPEN" | "CHOP" | "FIST"): void {
    const preset = HAND_PRESETS[presetName];
    if (!preset) return;
    this.viewer.applyHandPreset(side, preset);
    this.activeCharacter().grips[side] = presetName === "FIST" ? 1 : 0;
    this.callbacks.onStateChange();
    this.callbacks.onPreviewInvalidated();
  }

  setHandGrip(side: "l" | "r", value: number): void {
    this.activeCharacter().grips[side] = value;
    this.viewer.interpolateHandPose(HAND_PRESETS.OPEN, HAND_PRESETS.FIST, value, side);
    this.callbacks.onStateChange();
    this.callbacks.onPreviewInvalidated();
  }

  setActiveMesh(patch: Partial<PoseMeshParams>): void {
    const active = this.activeCharacter();
    active.mesh = { ...active.mesh, ...patch };
    this.callbacks.onStateChange();
    if (this.morphTimer) clearTimeout(this.morphTimer);
    this.morphTimer = setTimeout(() => {
      this.morphTimer = null;
      if (this.disposed || !this.ready) return;
      this.loadActiveModel(rotationsOnly(this.snapshotActivePose()));
      this.updateCaptureCamera(false);
      this.callbacks.onPreviewInvalidated();
    }, 100);
  }

  resetActiveMesh(): void {
    this.setActiveMesh({ ...DEFAULT_POSE_MESH });
  }

  setActiveProportion(key: keyof PoseProportions, value: number): void {
    const active = this.activeCharacter();
    active.proportions = { ...active.proportions, [key]: value };
    if (key === "head") {
      this.viewer.updateHeadScale(value);
    } else if (key === "neck") {
      this.applyNeck(value);
    } else if (key === "limb_thickness") {
      this.viewer.updateLimbThickness(value);
    } else if (key === "hand_foot") {
      this.viewer.updateHandScale(value);
      this.viewer.updateFootScale(value);
    } else {
      for (const group of PROPORTION_GROUPS[key] ?? []) {
        this.viewer.updateBoneLengthScale(group, value - 0.5);
      }
    }
    this.callbacks.onStateChange();
    this.callbacks.onPreviewInvalidated();
  }

  resetActiveProportions(): void {
    this.applyProportionsPreset(DEFAULT_POSE_PROPORTIONS);
  }

  /** 批量套用头身比例预设（可选同步调整年龄/圆润体型 morph，保持当前姿势不变，避免 Q 版变成细火柴人）。 */
  applyProportionsPreset(
    preset: PoseProportions,
    meshPatch?: Partial<PoseMeshParams>,
  ): void {
    const active = this.activeCharacter();
    active.proportions = { ...preset };
    if (meshPatch) {
      active.mesh = { ...active.mesh, ...meshPatch };
      if (this.morphTimer) {
        clearTimeout(this.morphTimer);
        this.morphTimer = null;
      }
      this.loadActiveModel(rotationsOnly(this.snapshotActivePose()));
    } else {
      for (const key of Object.keys(DEFAULT_POSE_PROPORTIONS) as Array<keyof PoseProportions>) {
        this.setActiveProportion(key, preset[key]);
      }
    }
    if (this.autoFit) {
      this.fitAllCharacters(false);
    }
    this.callbacks.onStateChange();
    this.callbacks.onPreviewInvalidated();
  }

  /** 应用 29 个内置「常用姿势」算法预设到当前选中角色。 */
  applyCommonPose(spec: CommonPoseSpec): void {
    if (!this.ready) return;
    this.importKeypointsToActive((rest, head) => ({
      kps: directionKeypoints(spec, rest, head),
    }));
    if (spec.turn) {
      this.viewer.setModelRotation(0, spec.turn, 0);
    }
    this.activeCharacter().openpose = null;
    if (this.autoFit) this.fitAllCharacters(false);
    this.callbacks.onStateChange();
    this.callbacks.onPreviewInvalidated();
  }

  /** 读取一张 OpenPose 黑底彩色骨架图并应用到当前选中角色。 */
  applyOpenPoseImage(image: HTMLImageElement, label: string): string {
    const people = readSkeletonImage(image);
    const heightOf = (p: Record<string, [number, number]>) => {
      const ys = Object.values(p).map((pt) => pt[1]);
      return Math.max(...ys) - Math.min(...ys);
    };
    const best = people.slice().sort((a, b) => heightOf(b) - heightOf(a))[0];
    this.activeCharacter().openpose = {
      name: label,
      points: best,
      flips: {},
      depthMode: "estimate",
    };
    const facingAway = this.reapplyActiveOpenPose();
    const notes = [facingAway ? "Back view detected" : "Front view detected"];
    if (people.length > 1) notes.push(`${people.length} skeletons found (largest applied)`);
    return notes.join(" · ");
  }

  toggleOpenPoseFlip(group: string): void {
    const op = this.activeCharacter().openpose as
      | { points?: Record<string, [number, number]>; flips?: Record<string, boolean>; depthMode?: "planar" | "estimate" }
      | null
      | undefined;
    if (!op?.points) return;
    op.flips = { ...(op.flips ?? {}), [group]: !op.flips?.[group] };
    this.reapplyActiveOpenPose();
  }

  setOpenPoseDepthMode(mode: "planar" | "estimate"): void {
    const op = this.activeCharacter().openpose as
      | { points?: Record<string, [number, number]>; flips?: Record<string, boolean>; depthMode?: "planar" | "estimate" }
      | null
      | undefined;
    if (!op?.points) return;
    op.depthMode = mode;
    this.reapplyActiveOpenPose();
  }

  private reapplyActiveOpenPose(): boolean {
    const op = this.activeCharacter().openpose as
      | { points?: Record<string, [number, number]>; flips?: Record<string, boolean>; depthMode?: "planar" | "estimate" }
      | null
      | undefined;
    if (!op?.points) return false;
    const extra = this.importKeypointsToActive((rest, head) => {
      const lifted = liftOpenPose(op.points!, rest, op.flips ?? {}, op.depthMode ?? "estimate");
      const headDistance = Math.hypot(
        head[0] - rest.neck[0],
        head[1] - rest.neck[1],
        head[2] - rest.neck[2],
      );
      const dir = [
        lifted.kps.head[0] - lifted.kps.neck[0],
        lifted.kps.head[1] - lifted.kps.neck[1],
        lifted.kps.head[2] - lifted.kps.neck[2],
      ];
      const norm = Math.hypot(dir[0], dir[1], dir[2]) || 1;
      lifted.kps.head = [
        lifted.kps.neck[0] + (dir[0] / norm) * headDistance,
        lifted.kps.neck[1] + (dir[1] / norm) * headDistance,
        lifted.kps.neck[2] + (dir[2] / norm) * headDistance,
      ];
      return lifted;
    });
    if (this.autoFit) this.fitAllCharacters(false);
    this.callbacks.onStateChange();
    this.callbacks.onPreviewInvalidated();
    return Boolean(extra.facingAway);
  }

  private importKeypointsToActive<T extends { kps: Record<string, number[]> }>(
    build: (rest: Record<string, number[]>, head: number[]) => T,
  ): Omit<T, "kps"> {
    this.viewer.recordState();
    const active = this.activeCharacter();
    const keepTransform = { ...active.transform };
    this.viewer.setActiveCharacterAppearance({
      color: active.color.hex,
      transform: DEFAULT_POSE_TRANSFORM,
    });
    this.viewer.resetPose();
    this.applyNeck(active.proportions.neck);
    this.viewer.skinnedMesh?.updateMatrixWorld(true);

    const THREE = this.viewer.THREE;
    const worldOf = (name: string) =>
      this.viewer.bones[name].getWorldPosition(new THREE.Vector3()).toArray();
    const rest: Record<string, number[]> = Object.fromEntries(
      Object.entries(JOINT_BONES).map(([key, bone]) => [key, worldOf(bone)]),
    );
    rest.neck = rest.ls.map((v, i) => (v + rest.rs[i]) / 2);
    rest.hipMid = rest.lh.map((v, i) => (v + rest.rh[i]) / 2);
    const head = worldOf("head");
    const pelvis = worldOf("pelvis");

    const { kps, ...extra } = build(rest, head);
    const worldKps = Object.fromEntries(
      Object.entries(WORLD_KEYPOINT_NAMES).map(([key, name]) => [
        name,
        new THREE.Vector3(kps[key][0] + pelvis[0], kps[key][1] + pelvis[1], kps[key][2] + pelvis[2]),
      ]),
    );
    this.viewer.applyWorldKeypointImport(worldKps, {
      drawFigure: false,
      placeHipRoots: false,
      alignHead: false,
      alignHands: false,
      alignFeet: false,
      dispatchPoseChange: false,
    });
    this.viewer.setActiveCharacterAppearance({
      color: active.color.hex,
      transform: keepTransform,
    });
    return extra;
  }

  applyLighting(next: PoseLightingConfig): void {
    this.lighting = { ...next };
    if (!this.viewer.initialized) return;
    this.viewer.updateLights(buildPoseLights(next) as unknown as Array<Record<string, unknown>>);
    this.viewer.setRimDarken(next.rimDarken);
    this.viewer.setShowSkydome(next.showSkydome);
    this.callbacks.onPreviewInvalidated();
  }

  setExportDimensions(width: number, height: number): void {
    this.exportWidth = width;
    this.exportHeight = height;
    this.updateCaptureCamera(false);
    this.callbacks.onPreviewInvalidated();
  }

  setCamera(patch: Partial<PoseCameraState>, snap = false): void {
    this.camera = { ...this.camera, ...patch };
    this.updateCaptureCamera(snap);
    this.callbacks.onStateChange();
    this.callbacks.onPreviewInvalidated();
  }

  resetCamera(): void {
    this.camera = { ...DEFAULT_POSE_CAMERA };
    this.fitAllCharacters(true);
    this.callbacks.onStateChange();
    this.callbacks.onPreviewInvalidated();
  }

  useOrbitViewAsCamera(): void {
    const offset = this.viewer.camera.position.clone().sub(this.viewer.orbit.target);
    const horizontal = Math.hypot(offset.x, offset.z) || 1e-4;
    const yaw = Math.round((Math.atan2(offset.x, offset.z) * 180) / Math.PI);
    const pitch = Math.round(Math.max(-60, Math.min(60, (Math.atan2(offset.y, horizontal) * 180) / Math.PI)));
    this.camera = { ...this.camera, yaw, pitch };
    this.updateCaptureCamera(true);
    this.callbacks.onStateChange();
    this.callbacks.onPreviewInvalidated();
  }

  snapToCaptureCamera(): void {
    this.updateCaptureCamera(true);
  }

  updateCaptureCamera(snap: boolean): void {
    if (!this.viewer.initialized) return;
    const args: [number, number, number, number, number, number, number] = [
      this.exportWidth,
      this.exportHeight,
      this.camera.zoom,
      this.camera.offsetX,
      this.camera.offsetY,
      this.camera.yaw,
      -this.camera.pitch,
    ];
    if (snap) this.viewer.snapToCaptureCamera(...args);
    else this.viewer.updateCaptureCamera(...args);
    this.referenceOverlay?.sync();
  }

  /** 将全场景 1~26 个角色自动完整适配进拍摄画框，并留出顶部/底部与四角水印安全边距。 */
  fitAllCharacters(snap = false): void {
    if (!this.viewer.initialized || !this.viewer.THREE) return;
    const THREE = this.viewer.THREE;
    const meshes: THREE_NS.SkinnedMesh[] = [];
    if (this.viewer.skinnedMesh) meshes.push(this.viewer.skinnedMesh);
    for (const entry of this.viewer.passiveCharacters.values()) {
      if (entry.mesh) meshes.push(entry.mesh);
    }
    if (meshes.length === 0) return;

    const measureNdc = () => {
      this.updateCaptureCamera(false);
      this.viewer.captureCamera.updateMatrixWorld(true);
      const box = new THREE.Box2();
      const v = new THREE.Vector3();
      for (const mesh of meshes) {
        mesh.updateMatrixWorld(true);
        mesh.skeleton?.update();
        const posAttr = mesh.geometry?.getAttribute("position");
        const skinnedAny = mesh as THREE_NS.SkinnedMesh & {
          getVertexPosition?: (index: number, target: THREE_NS.Vector3) => THREE_NS.Vector3;
        };
        if (posAttr && typeof skinnedAny.getVertexPosition === "function") {
          const stride = Math.max(1, Math.floor(posAttr.count / 400));
          for (let i = 0; i < posAttr.count; i += stride) {
            skinnedAny.getVertexPosition(i, v);
            v.applyMatrix4(mesh.matrixWorld).project(this.viewer.captureCamera);
            if (Number.isFinite(v.x) && Number.isFinite(v.y)) {
              box.expandByPoint(new THREE.Vector2(v.x, v.y));
            }
          }
        } else {
          for (const bone of mesh.skeleton?.bones || []) {
            bone.getWorldPosition(v).project(this.viewer.captureCamera);
            if (Number.isFinite(v.x) && Number.isFinite(v.y)) {
              box.expandByPoint(new THREE.Vector2(v.x, v.y));
            }
          }
        }
      }
      return box;
    };

    // 留出 14% 四周安全边，兼顾人物模型发冠/脚底与四角水印防遮挡
    const targetSpan = 1.56;
    this.camera.zoom = 1;
    this.camera.offsetX = 0;
    this.camera.offsetY = 0;

    for (let pass = 0; pass < 5; pass += 1) {
      const ndc = measureNdc();
      if (ndc.isEmpty()) break;
      const size = ndc.getSize(new THREE.Vector2());
      const maxSpan = Math.max(size.x, size.y, 0.05);
      this.camera.zoom = Math.max(0.12, Math.min(6, (this.camera.zoom * targetSpan) / maxSpan));
      const mid = measureNdc().getCenter(new THREE.Vector2());
      const eps = 0.08;
      this.camera.offsetX += eps;
      const dx = measureNdc().getCenter(new THREE.Vector2()).sub(mid).divideScalar(eps);
      this.camera.offsetX -= eps;
      this.camera.offsetY += eps;
      const dy = measureNdc().getCenter(new THREE.Vector2()).sub(mid).divideScalar(eps);
      this.camera.offsetY -= eps;
      const a = dx.dot(dx) + 0.001;
      const b = dx.dot(dy);
      const c = dy.dot(dy) + 0.001;
      const u = -dx.dot(mid);
      const v = -dy.dot(mid);
      const det = a * c - b * b;
      if (Math.abs(det) > 1e-6) {
        this.camera.offsetX += Math.max(-8, Math.min(8, (u * c - v * b) / det));
        this.camera.offsetY += Math.max(-8, Math.min(8, (v * a - u * b) / det));
      }
    }
    this.updateCaptureCamera(snap);
  }

  /**
   * 将当前选中角色的缩放与位置自动适配到当前拍摄镜头框内（保持镜头不变，上下左右至少各留 10% 边距）。
   */
  fitActiveCharacterToFrame(marginRatio = 0.1): void {
    if (!this.ready || !this.viewer.THREE || !this.viewer.skinnedMesh || !this.viewer.captureCamera) return;
    const THREE = this.viewer.THREE;
    const active = this.activeCharacter();
    this.viewer.recordState();
    this.autoFit = false;
    this.updateCaptureCamera(false);

    const cam = this.viewer.captureCamera;
    cam.updateMatrixWorld(true);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion).normalize();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion).normalize();
    const targetSpan = 2 * (1 - 2 * Math.max(0.02, Math.min(0.4, marginRatio)));

    const measureActive = () => {
      const mesh = this.viewer.skinnedMesh!;
      mesh.updateMatrixWorld(true);
      mesh.skeleton?.update();
      const ndcBox = new THREE.Box2();
      const worldBox = new THREE.Box3();
      const v = new THREE.Vector3();
      const proj = new THREE.Vector3();
      const posAttr = mesh.geometry?.getAttribute("position");
      const skinnedAny = mesh as THREE_NS.SkinnedMesh & {
        getVertexPosition?: (index: number, target: THREE_NS.Vector3) => THREE_NS.Vector3;
      };
      if (posAttr && typeof skinnedAny.getVertexPosition === "function") {
        const stride = Math.max(1, Math.floor(posAttr.count / 450));
        for (let i = 0; i < posAttr.count; i += stride) {
          skinnedAny.getVertexPosition(i, v);
          v.applyMatrix4(mesh.matrixWorld);
          if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) continue;
          worldBox.expandByPoint(v);
          proj.copy(v).project(cam);
          if (Number.isFinite(proj.x) && Number.isFinite(proj.y)) {
            ndcBox.expandByPoint(new THREE.Vector2(proj.x, proj.y));
          }
        }
      } else {
        for (const bone of mesh.skeleton?.bones || []) {
          bone.getWorldPosition(v);
          worldBox.expandByPoint(v);
          proj.copy(v).project(cam);
          if (Number.isFinite(proj.x) && Number.isFinite(proj.y)) {
            ndcBox.expandByPoint(new THREE.Vector2(proj.x, proj.y));
          }
        }
      }
      return { ndcBox, worldBox };
    };

    for (let pass = 0; pass < 5; pass += 1) {
      const m1 = measureActive();
      if (m1.ndcBox.isEmpty() || m1.worldBox.isEmpty()) break;
      const size = m1.ndcBox.getSize(new THREE.Vector2());
      const maxSpan = Math.max(size.x, size.y, 0.05);
      active.transform = {
        ...active.transform,
        zoom: Math.max(0.2, Math.min(4, (active.transform.zoom * targetSpan) / maxSpan)),
      };
      this.viewer.setActiveCharacterAppearance({
        color: active.color.hex,
        transform: active.transform,
      });

      const m2 = measureActive();
      if (m2.ndcBox.isEmpty() || m2.worldBox.isEmpty()) break;
      const mid = m2.ndcBox.getCenter(new THREE.Vector2());
      const worldCenter = m2.worldBox.getCenter(new THREE.Vector3());
      const depth = Math.max(0.5, worldCenter.clone().sub(cam.position).dot(forward));
      const halfH = (depth * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / Math.max(0.01, cam.zoom);
      const halfW = halfH * cam.aspect;
      const shift = right
        .clone()
        .multiplyScalar(-mid.x * halfW)
        .add(up.clone().multiplyScalar(-mid.y * halfH));
      active.transform = {
        ...active.transform,
        x: Math.max(-15, Math.min(15, active.transform.x + shift.x)),
        y: Math.max(-15, Math.min(15, active.transform.y + shift.y)),
        z: Math.max(-15, Math.min(15, active.transform.z + shift.z)),
      };
      this.viewer.setActiveCharacterAppearance({
        color: active.color.hex,
        transform: active.transform,
      });
    }

    this.movementGizmo?.sync(this.poseTool === "move");
    this.callbacks.onStateChange();
    this.callbacks.onPreviewInvalidated();
  }

  setEditMode(mode: "pose" | "camera"): void {
    this.editMode = mode;
    if (mode === "camera") {
      this.movementGizmo?.sync(false);
      this.updateCaptureCamera(true);
    } else {
      this.movementGizmo?.sync(this.poseTool === "move");
    }
    this.callbacks.onStateChange();
  }

  setPoseTool(tool: "joints" | "move"): void {
    this.poseTool = tool;
    this.movementGizmo?.sync(this.editMode === "pose" && tool === "move");
    this.callbacks.onStateChange();
  }

  async setReferenceOverlay(url: string | null): Promise<void> {
    await this.referenceOverlay?.setSource(url);
  }

  setReferenceOverlayOpacity(opacity: number): void {
    this.referenceOverlay?.setOpacity(opacity);
  }

  getCharacterMetas(): PoseSceneCharacterMeta[] {
    return this.characters.map((c, idx) => ({
      id: c.id,
      label: c.label,
      labelStyle: c.labelStyle,
      color: c.color,
      isActive: idx === this.activeIndex,
    }));
  }

  projectCharacters(): ProjectedPoseCharacter[] {
    return projectPoseCharacters(
      this.viewer,
      this.exportWidth,
      this.exportHeight,
      this.camera,
      this.getCharacterMetas(),
    );
  }

  async renderMode(
    mode: PoseExportModeKey,
    options: {
      width?: number;
      height?: number;
      cornerWatermark: boolean;
      watermarkStyle?: PoseWatermarkStyle;
      showLabels: boolean;
      language: "zh" | "en";
    },
  ): Promise<string> {
    await this.viewer.waitForCaptureReady();
    const result = await renderPoseMode(
      mode,
      {
        viewer: this.viewer,
        width: options.width ?? this.exportWidth,
        height: options.height ?? this.exportHeight,
        baseExportWidth: this.exportWidth,
        camera: this.camera,
        lighting: this.lighting,
        characters: this.getCharacterMetas(),
        cornerWatermark: options.cornerWatermark,
        watermarkStyle: options.watermarkStyle ?? { fontFamily: "JetBrainsMapleMono", fontSize: 72 },
        language: options.language,
      },
      options.showLabels,
    );
    this.updateCaptureCamera(false);
    return result;
  }

  /** 序列化当前完整多人场景为 .pose.json 工程文档（附带 256px 缩略图）。 */
  async serializeProject(name: string, includeShape: boolean): Promise<PoseProjectDocument> {
    this.syncActiveSnapshot();
    const scale = 256 / Math.max(this.exportWidth, this.exportHeight);
    const thumbW = Math.max(64, Math.round(this.exportWidth * scale));
    const thumbH = Math.max(64, Math.round(this.exportHeight * scale));
    const thumbnail = await this.renderMode("mannequin", {
      width: thumbW,
      height: thumbH,
      cornerWatermark: false,
      showLabels: true,
      language: "en",
    });

    const characters = this.characters.map((c) => {
      const cloned = cloneRecord(c);
      if (!includeShape) {
        cloned.mesh = { ...DEFAULT_POSE_MESH };
        cloned.proportions = { ...DEFAULT_POSE_PROPORTIONS };
      }
      return cloned;
    });

    return {
      kind: "grsai-pose-project",
      version: 2,
      name,
      savedAt: Date.now(),
      thumbnail,
      includeShape,
      width: this.exportWidth,
      height: this.exportHeight,
      camera: { ...this.camera },
      lighting: { ...this.lighting },
      characters,
      activeIndex: this.activeIndex,
    };
  }

  /** 从 .pose.json 文档完整还原多人场景（支持 1~26 人，允许再次编辑每个角色）。 */
  loadProject(doc: PoseProjectDocument): void {
    if (!this.ready || !this.pack || doc.characters.length === 0) return;
    this.viewer.clearPassiveCharacters();
    this.characters = doc.characters.slice(0, MAX_POSE_CHARACTERS).map((c) => cloneRecord(c));
    this.nextCharSeq = this.characters.length + 10;
    this.activeIndex = Math.max(0, Math.min(doc.activeIndex, this.characters.length - 1));
    this.camera = { ...doc.camera };

    // 依次将每个非 active 角色构建进 passiveCharacters，最后加载 active 角色
    for (let i = 0; i < this.characters.length; i += 1) {
      if (i === this.activeIndex) continue;
      const char = this.characters[i];
      const savedActive = this.activeIndex;
      this.activeIndex = i;
      this.loadActiveModel(char.pose);
      this.viewer.upsertPassiveCharacterFromActive(char.id, {
        pose: char.pose ?? {},
        color: char.color.hex,
        transform: char.transform,
      });
      this.activeIndex = savedActive;
    }

    const active = this.activeCharacter();
    this.loadActiveModel(active.pose);
    this.updateCaptureCamera(true);
    this.selectedBoneName = null;
    this.callbacks.onBoneSelected(null);
    this.callbacks.onStateChange();
    this.callbacks.onPreviewInvalidated();
  }

  undo(): void {
    this.viewer.undo();
    this.callbacks.onStateChange();
    this.callbacks.onPreviewInvalidated();
  }

  redo(): void {
    this.viewer.redo();
    this.callbacks.onStateChange();
    this.callbacks.onPreviewInvalidated();
  }

  resize(width: number, height: number): void {
    if (!this.viewer.initialized || width < 10 || height < 10) return;
    this.viewer.resize(width, height);
  }

  private setupViewportInteraction(): void {
    const canvas = this.viewer.canvas;
    const THREE = this.viewer.THREE;
    this.viewer.orbit.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.PAN,
    };

    // 1. 镜头编辑模式拖动
    const onCameraPointerDown = (event: PointerEvent) => {
      if (this.editMode !== "camera" || !this.ready) return;
      event.stopImmediatePropagation();
      event.preventDefault();
      const start = { x: event.clientX, y: event.clientY, cam: { ...this.camera } };
      const pan = event.button !== 0 || event.shiftKey;
      const onMove = (moveEvent: PointerEvent) => {
        const dx = moveEvent.clientX - start.x;
        const dy = moveEvent.clientY - start.y;
        if (pan) {
          this.setCamera(
            {
              offsetX: start.cam.offsetX + (dx * 0.035) / start.cam.zoom,
              offsetY: start.cam.offsetY - (dy * 0.035) / start.cam.zoom,
            },
            true,
          );
        } else {
          this.setCamera(
            {
              yaw: Math.max(-180, Math.min(180, Math.round(start.cam.yaw - dx * 0.35))),
              pitch: Math.max(-60, Math.min(60, Math.round(start.cam.pitch + dy * 0.25))),
            },
            true,
          );
        }
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    };

    const onCameraWheel = (event: WheelEvent) => {
      if (this.editMode !== "camera" || !this.ready) return;
      event.stopImmediatePropagation();
      event.preventDefault();
      const nextZoom = Math.max(0.12, Math.min(6, this.camera.zoom * Math.exp(-event.deltaY * 0.001)));
      this.setCamera({ zoom: nextZoom }, true);
    };

    // 2. Shift+左键平面拖动当前角色
    const onShiftMove = (event: PointerEvent) => {
      if (event.button !== 0 || !event.shiftKey || !this.ready || this.editMode !== "pose" || this.poseTool === "move") {
        return;
      }
      event.stopImmediatePropagation();
      event.preventDefault();
      this.autoFit = false;
      this.viewer.recordState();
      const cam = this.viewer.camera;
      const dist = cam.position.distanceTo(this.viewer.orbit.target);
      const perPixel =
        (2 * dist * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / (canvas.clientHeight * cam.zoom);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
      const start = { x: event.clientX, y: event.clientY, tf: { ...this.activeCharacter().transform } };
      const onMove = (moveEvent: PointerEvent) => {
        const delta = right
          .clone()
          .multiplyScalar((moveEvent.clientX - start.x) * perPixel)
          .add(up.clone().multiplyScalar(-(moveEvent.clientY - start.y) * perPixel));
        this.setActiveTransform({
          x: Math.max(-50, Math.min(50, start.tf.x + delta.x)),
          y: Math.max(-50, Math.min(50, start.tf.y + delta.y)),
        });
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    };

    // 3. 点击其他被动角色快速切换选中对象
    const onPickPassive = (event: PointerEvent) => {
      if (event.button !== 0 || this.editMode !== "pose") return;
      const grabbed =
        this.viewer.directDrag?.active ||
        this.viewer.selectedIKEffector ||
        this.viewer.selectedPoleTarget ||
        this.viewer.transform?.dragging;
      if (grabbed || this.viewer.selectedBone) {
        this.viewer.orbit.enabled = false;
        window.addEventListener(
          "pointerup",
          () => {
            this.viewer.orbit.enabled = true;
          },
          { once: true },
        );
      }
      if (grabbed || this.characters.length <= 1) return;
      const start = { x: event.clientX, y: event.clientY };
      window.addEventListener(
        "pointerup",
        (up) => {
          if (Math.hypot(up.clientX - start.x, up.clientY - start.y) >= 5) return;
          const rect = canvas.getBoundingClientRect();
          const pointer = new THREE.Vector2(
            ((up.clientX - rect.left) / rect.width) * 2 - 1,
            -((up.clientY - rect.top) / rect.height) * 2 + 1,
          );
          const raycaster = new THREE.Raycaster();
          raycaster.setFromCamera(pointer, this.viewer.camera);
          let best: { dist: number; id: string } | null = null;
          for (const [id, entry] of this.viewer.passiveCharacters) {
            const hit = raycaster.intersectObject(entry.mesh, false)[0];
            if (hit && (!best || hit.distance < best.dist)) {
              best = { dist: hit.distance, id };
            }
          }
          const own = this.viewer.skinnedMesh
            ? raycaster.intersectObject(this.viewer.skinnedMesh, false)[0]
            : null;
          if (best && (!own || best.dist < own.distance)) {
            const idx = this.characters.findIndex((c) => c.id === best!.id);
            if (idx >= 0) this.switchCharacter(idx);
          }
        },
        { once: true },
      );
    };

    canvas.addEventListener("pointerdown", onCameraPointerDown, { capture: true });
    canvas.addEventListener("wheel", onCameraWheel, { capture: true, passive: false });
    canvas.addEventListener("pointerdown", onShiftMove, { capture: true });
    canvas.addEventListener("pointerdown", onPickPassive);

    this.cleanupInteraction = () => {
      canvas.removeEventListener("pointerdown", onCameraPointerDown, { capture: true });
      canvas.removeEventListener("wheel", onCameraWheel, { capture: true });
      canvas.removeEventListener("pointerdown", onShiftMove, { capture: true });
      canvas.removeEventListener("pointerdown", onPickPassive);
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.morphTimer) clearTimeout(this.morphTimer);
    this.cleanupInteraction?.();
    this.movementGizmo?.dispose();
    this.referenceOverlay?.dispose();
    this.viewer.dispose();
  }
}

export { COMMON_POSES };
