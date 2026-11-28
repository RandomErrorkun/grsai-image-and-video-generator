/**
 * 3D 姿势工坊的 4 模态渲染管线、真实蒙皮顶点标号精确定位、智能单角防遮挡水印与重心屏幕坐标投影。
 *
 * 支持：
 * 1. 3D 人偶（带自定义三点立体光照、纯白默认背景、可选球形网格开关）
 * 2. 3D 人偶 + 骨骼（active + 最多 25 个 passive 全部叠加彩色骨骼）
 * 3. 纯 OpenPose 风格骨架图（黑底彩色标准 ControlNet 14 关键点连线）
 * 4. 自适应紧包线性深度图（自定义支持 SkinnedMesh 蒙皮的 ShaderMaterial，白近黑远 + 纯黑背景）
 */
import type * as THREE_NS from "three";
import {
  buildPoseLights,
  type PoseExportModes,
  type PoseLabelStyle,
  type PoseLightingConfig,
  type PoseWatermarkStyle,
} from "../core/poseConfig";
import type { CharacterColorSpec } from "../core/posePalettes";
import type { ProjectedPoseCharacter } from "../core/posePrompt";
import type { PoseCameraState } from "../core/poseStorage";
import { COLORS, LIMBS, ORDER } from "./vendor/state.mjs";
import type { PoseViewerCore } from "./vendor/vnccs_pose_studio_core.mjs";

export type PoseExportModeKey = keyof PoseExportModes;

export interface PoseSceneCharacterMeta {
  id: string;
  label: string;
  labelStyle: PoseLabelStyle;
  color: CharacterColorSpec;
  isActive: boolean;
}

export interface PoseRenderOptions {
  viewer: PoseViewerCore;
  width: number;
  height: number;
  /** 导出目标宽度（用于将标号/水印像素字号按预览图比例精确缩放，保证预览与全尺寸导出所见即所得）。 */
  baseExportWidth: number;
  camera: PoseCameraState;
  lighting: PoseLightingConfig;
  characters: readonly PoseSceneCharacterMeta[];
  cornerWatermark: boolean;
  watermarkStyle: PoseWatermarkStyle;
  language: "zh" | "en";
}

interface CharacterRigView {
  meta: PoseSceneCharacterMeta;
  mesh: THREE_NS.SkinnedMesh;
  bones: Record<string, THREE_NS.Bone>;
}

interface Rect2D {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface DetailedScreenBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** 头部蒙皮顶点（受 head 骨骼主导）的真实 2D 外接框；若不可得为 null。 */
  headBox: { minX: number; maxX: number; minY: number; maxY: number } | null;
}

function hexToRgbArray(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return [255, 255, 255];
  return [
    parseInt(clean.slice(0, 2), 16) || 0,
    parseInt(clean.slice(2, 4), 16) || 0,
    parseInt(clean.slice(4, 6), 16) || 0,
  ];
}

/** 收集当前场景中所有在场角色（active + passive）的 SkinnedMesh 与骨骼字典。 */
function collectCharacterRigs(
  viewer: PoseViewerCore,
  characters: readonly PoseSceneCharacterMeta[],
): CharacterRigView[] {
  const rigs: CharacterRigView[] = [];
  for (const meta of characters) {
    if (meta.isActive) {
      if (viewer.skinnedMesh) {
        viewer.skinnedMesh.updateMatrixWorld(true);
        viewer.skeleton?.update();
        rigs.push({ meta, mesh: viewer.skinnedMesh, bones: viewer.bones || {} });
      }
    } else {
      const passive = viewer.passiveCharacters.get(meta.id);
      if (passive?.mesh) {
        passive.mesh.updateMatrixWorld(true);
        passive.skeleton?.update();
        rigs.push({ meta, mesh: passive.mesh, bones: passive.bones || {} });
      }
    }
  }
  return rigs;
}

function boneWorldPos(
  THREE: typeof THREE_NS,
  bones: Record<string, THREE_NS.Bone>,
  names: readonly string[],
): THREE_NS.Vector3 | null {
  for (const name of names) {
    const bone = bones[name];
    if (bone) {
      return bone.getWorldPosition(new THREE.Vector3());
    }
  }
  return null;
}

function projectToCanvas(
  worldPoint: THREE_NS.Vector3,
  camera: THREE_NS.Camera,
  width: number,
  height: number,
): { x: number; y: number; ndcZ: number } {
  const ndc = worldPoint.clone().project(camera);
  return {
    x: ((ndc.x + 1) / 2) * width,
    y: ((1 - ndc.y) / 2) * height,
    ndcZ: ndc.z,
  };
}

/**
 * 采样真实蒙皮顶点世界坐标，算出每个角色在 2D 画布上的精确像素外接框与头部外接框。
 * 无论头部放大到 2.5 倍、切换 2 头身 Q 版还是大幅拉伸四肢，外接框与额头锚点都严格贴合真实几何轮廓！
 */
function sampleCharacterScreenBounds(
  THREE: typeof THREE_NS,
  rig: CharacterRigView,
  camera: THREE_NS.Camera,
  width: number,
  height: number,
): DetailedScreenBounds {
  const mesh = rig.mesh;
  mesh.updateMatrixWorld(true);
  mesh.skeleton?.update();

  const posAttr = mesh.geometry?.getAttribute("position");
  const skinIndexAttr = mesh.geometry?.getAttribute("skinIndex");
  const skinWeightAttr = mesh.geometry?.getAttribute("skinWeight");
  const headBoneIndex = mesh.skeleton?.bones?.findIndex((b) => b.name.toLowerCase() === "head") ?? -1;

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  let hMinX = Number.POSITIVE_INFINITY;
  let hMaxX = Number.NEGATIVE_INFINITY;
  let hMinY = Number.POSITIVE_INFINITY;
  let hMaxY = Number.NEGATIVE_INFINITY;

  const skinnedMeshAny = mesh as THREE_NS.SkinnedMesh & {
    getVertexPosition?: (index: number, target: THREE_NS.Vector3) => THREE_NS.Vector3;
  };

  if (posAttr && typeof skinnedMeshAny.getVertexPosition === "function") {
    const count = posAttr.count;
    const stride = Math.max(1, Math.floor(count / 1200));
    const v = new THREE.Vector3();
    for (let i = 0; i < count; i += stride) {
      skinnedMeshAny.getVertexPosition(i, v);
      v.applyMatrix4(mesh.matrixWorld);
      v.project(camera);
      if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) continue;
      const sx = ((v.x + 1) / 2) * width;
      const sy = ((1 - v.y) / 2) * height;
      if (sx < minX) minX = sx;
      if (sx > maxX) maxX = sx;
      if (sy < minY) minY = sy;
      if (sy > maxY) maxY = sy;

      if (headBoneIndex >= 0 && skinIndexAttr && skinWeightAttr) {
        let headWeight = 0;
        for (let k = 0; k < 4; k += 1) {
          const bIdx = k === 0
            ? skinIndexAttr.getX(i)
            : k === 1
              ? skinIndexAttr.getY(i)
              : k === 2
                ? skinIndexAttr.getZ(i)
                : skinIndexAttr.getW(i);
          if (Math.round(bIdx) === headBoneIndex) {
            headWeight += k === 0
              ? skinWeightAttr.getX(i)
              : k === 1
                ? skinWeightAttr.getY(i)
                : k === 2
                  ? skinWeightAttr.getZ(i)
                  : skinWeightAttr.getW(i);
          }
        }
        if (headWeight >= 0.45) {
          if (sx < hMinX) hMinX = sx;
          if (sx > hMaxX) hMaxX = sx;
          if (sy < hMinY) hMinY = sy;
          if (sy > hMaxY) hMaxY = sy;
        }
      }
    }
  }

  // 回退方案：若无法采样蒙皮顶点，退回骨骼点计算
  if (!Number.isFinite(minX)) {
    for (const bone of Object.values(rig.bones)) {
      const pos = bone.getWorldPosition(new THREE.Vector3());
      const p = projectToCanvas(pos, camera, width, height);
      if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
    }
  }
  if (!Number.isFinite(minX)) {
    const fallback = projectToCanvas(rig.mesh.position, camera, width, height);
    return {
      minX: fallback.x - 40,
      maxX: fallback.x + 40,
      minY: fallback.y - 80,
      maxY: fallback.y + 80,
      headBox: null,
    };
  }

  const headBox =
    Number.isFinite(hMinX) && Number.isFinite(hMinY) && hMaxY > hMinY
      ? { minX: hMinX, maxX: hMaxX, minY: hMinY, maxY: hMaxY }
      : null;

  return { minX, maxX, minY, maxY, headBox };
}

/**
 * 提取所有在场角色相对于当前拍摄相机的标准化屏幕坐标 (screenX, screenY) 与真实欧氏景深 depth。
 * screenX: 0=最左, 1=最右；screenY: 0=最下, 1=最上；depth: 越小越近（前景）。
 */
export function projectPoseCharacters(
  viewer: PoseViewerCore,
  width: number,
  height: number,
  cameraState: PoseCameraState,
  characters: readonly PoseSceneCharacterMeta[],
): ProjectedPoseCharacter[] {
  if (!viewer.initialized || !viewer.THREE || !viewer.captureCamera) return [];
  const THREE = viewer.THREE;
  viewer.updateCaptureCamera(
    width,
    height,
    cameraState.zoom,
    cameraState.offsetX,
    cameraState.offsetY,
    cameraState.yaw,
    -cameraState.pitch,
  );
  viewer.captureCamera.updateMatrixWorld(true);
  const cam = viewer.captureCamera;
  const rigs = collectCharacterRigs(viewer, characters);

  return rigs.map((rig) => {
    let center =
      boneWorldPos(THREE, rig.bones, ["pelvis", "spine01", "spine_01", "root"]) ??
      rig.mesh.position.clone();
    if (!boneWorldPos(THREE, rig.bones, ["pelvis", "spine01", "spine_01"])) {
      const list = Object.values(rig.bones);
      if (list.length > 0) {
        center = new THREE.Vector3();
        for (const b of list) center.add(b.getWorldPosition(new THREE.Vector3()));
        center.divideScalar(list.length);
      }
    }
    const ndc = center.clone().project(cam);
    const screenX = Math.max(0, Math.min(1, (ndc.x + 1) / 2));
    const screenY = Math.max(0, Math.min(1, (ndc.y + 1) / 2));
    const depth = cam.position.distanceTo(center);
    return {
      id: rig.meta.id,
      label: rig.meta.label,
      color: rig.meta.color,
      screenX,
      screenY,
      depth,
    };
  });
}

/** 在纯黑背景 Canvas 上按标准 ControlNet OpenPose 配色与连线绘制全部角色的 2D 投影骨架。 */
function renderPureOpenPoseCanvas(options: PoseRenderOptions): HTMLCanvasElement {
  const { viewer, width, height, camera: camState, characters } = options;
  const THREE = viewer.THREE;
  viewer.updateCaptureCamera(
    width,
    height,
    camState.zoom,
    camState.offsetX,
    camState.offsetY,
    camState.yaw,
    -camState.pitch,
  );
  viewer.captureCamera.updateMatrixWorld(true);
  const cam = viewer.captureCamera;
  const rigs = collectCharacterRigs(viewer, characters);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, width, height);

  const lineWidth = Math.max(3, Math.round(Math.min(width, height) / 170));
  const jointRadius = Math.max(4, Math.round(lineWidth * 1.15));
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const rig of rigs) {
    const b = rig.bones;
    const ls = boneWorldPos(THREE, b, ["upperarm_l", "upper_arm_l"]);
    const rs = boneWorldPos(THREE, b, ["upperarm_r", "upper_arm_r"]);
    const lh = boneWorldPos(THREE, b, ["thigh_l"]);
    const rh = boneWorldPos(THREE, b, ["thigh_r"]);
    const neck =
      boneWorldPos(THREE, b, ["neck_01", "neck"]) ??
      (ls && rs ? ls.clone().add(rs).multiplyScalar(0.5) : null);
    const headBase = boneWorldPos(THREE, b, ["head"]);
    const head =
      headBase && neck
        ? headBase.clone().add(headBase.clone().sub(neck).multiplyScalar(0.45))
        : headBase;

    const worldJoints: Record<string, THREE_NS.Vector3 | null> = {
      head,
      neck,
      rs,
      re: boneWorldPos(THREE, b, ["lowerarm_r", "forearm_r"]),
      rw: boneWorldPos(THREE, b, ["hand_r"]),
      ls,
      le: boneWorldPos(THREE, b, ["lowerarm_l", "forearm_l"]),
      lw: boneWorldPos(THREE, b, ["hand_l"]),
      rh,
      rk: boneWorldPos(THREE, b, ["calf_r", "shin_r"]),
      ra: boneWorldPos(THREE, b, ["foot_r"]),
      lh,
      lk: boneWorldPos(THREE, b, ["calf_l", "shin_l"]),
      la: boneWorldPos(THREE, b, ["foot_l"]),
    };

    const projected: Record<string, { x: number; y: number } | null> = {};
    for (const key of ORDER) {
      const wp = worldJoints[key];
      projected[key] = wp ? projectToCanvas(wp, cam, width, height) : null;
    }

    ctx.lineWidth = lineWidth;
    LIMBS.forEach(([aIdx, bIdx], limbIdx) => {
      const pA = projected[ORDER[aIdx]];
      const pB = projected[ORDER[bIdx]];
      if (!pA || !pB) return;
      ctx.strokeStyle = COLORS[limbIdx % COLORS.length];
      ctx.beginPath();
      ctx.moveTo(pA.x, pA.y);
      ctx.lineTo(pB.x, pB.y);
      ctx.stroke();
    });

    ORDER.forEach((key, idx) => {
      const p = projected[key];
      if (!p) return;
      ctx.fillStyle = COLORS[idx % COLORS.length];
      ctx.beginPath();
      ctx.arc(p.x, p.y, jointRadius, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  return canvas;
}

/**
 * 渲染自适应紧包线性深度图（白近黑远 + 纯黑背景，强制隐藏球形网格）。
 */
function renderDepthMapDataUrl(options: PoseRenderOptions): string | null {
  const { viewer, width, height, camera: camState, characters } = options;
  const THREE = viewer.THREE;
  if (!viewer.initialized || !THREE || !viewer.renderer || !viewer.captureCamera) return null;

  viewer.updateCaptureCamera(
    width,
    height,
    camState.zoom,
    camState.offsetX,
    camState.offsetY,
    camState.yaw,
    -camState.pitch,
  );
  viewer.captureCamera.updateMatrixWorld(true);
  const cam = viewer.captureCamera;
  const rigs = collectCharacterRigs(viewer, characters);
  if (rigs.length === 0) return null;

  // 采样真实蒙皮顶点视空间深度，精确紧包前后范围
  const invCam = cam.matrixWorldInverse;
  let zMin = Number.POSITIVE_INFINITY;
  let zMax = Number.NEGATIVE_INFINITY;
  const tmp = new THREE.Vector3();

  for (const rig of rigs) {
    const posAttr = rig.mesh.geometry?.getAttribute("position");
    const skinnedAny = rig.mesh as THREE_NS.SkinnedMesh & {
      getVertexPosition?: (index: number, target: THREE_NS.Vector3) => THREE_NS.Vector3;
    };
    if (posAttr && typeof skinnedAny.getVertexPosition === "function") {
      const stride = Math.max(1, Math.floor(posAttr.count / 600));
      for (let i = 0; i < posAttr.count; i += stride) {
        skinnedAny.getVertexPosition(i, tmp);
        tmp.applyMatrix4(rig.mesh.matrixWorld).applyMatrix4(invCam);
        const viewZ = -tmp.z;
        if (Number.isFinite(viewZ) && viewZ > 0.01) {
          if (viewZ < zMin) zMin = viewZ;
          if (viewZ > zMax) zMax = viewZ;
        }
      }
    } else {
      for (const bone of Object.values(rig.bones)) {
        bone.getWorldPosition(tmp).applyMatrix4(invCam);
        const viewZ = -tmp.z;
        if (Number.isFinite(viewZ) && viewZ > 0.01) {
          if (viewZ < zMin) zMin = viewZ;
          if (viewZ > zMax) zMax = viewZ;
        }
      }
    }
  }
  if (!Number.isFinite(zMin) || !Number.isFinite(zMax)) {
    zMin = 1.0;
    zMax = 10.0;
  }
  const pad = Math.max(0.15, (zMax - zMin) * 0.08);
  const nearDepth = Math.max(0.05, zMin - pad);
  const farDepth = Math.max(nearDepth + 0.4, zMax + pad);

  const depthMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uNearDepth: { value: nearDepth },
      uFarDepth: { value: farDepth },
    },
    vertexShader: `
      #include <common>
      #include <skinning_pars_vertex>
      varying float vViewDepth;
      void main() {
        #include <skinbase_vertex>
        #include <begin_vertex>
        #include <skinning_vertex>
        vec4 mvPos = modelViewMatrix * vec4(transformed, 1.0);
        vViewDepth = -mvPos.z;
        gl_Position = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: `
      uniform float uNearDepth;
      uniform float uFarDepth;
      varying float vViewDepth;
      void main() {
        float t = clamp((uFarDepth - vViewDepth) / max(uFarDepth - uNearDepth, 0.001), 0.0, 1.0);
        float gray = mix(0.18, 1.0, t);
        gl_FragColor = vec4(vec3(gray), 1.0);
      }
    `,
    side: THREE.DoubleSide,
  });

  const savedMaterials = rigs.map((rig) => ({ mesh: rig.mesh, material: rig.mesh.material }));
  const markerStates = viewer.jointMarkers.map((m) => m.visible);
  const skeletonVisible = viewer.skeletonHelper?.visible ?? false;
  const skydomeVisible = viewer.directionalSkydome?.visible ?? false;
  const gridVisible = viewer.gridHelper?.visible ?? false;
  const frameVisible = viewer.captureFrame?.visible ?? false;
  const transformObj = viewer.transformHelper ?? viewer.transform;
  const transformVisible = transformObj ? transformObj.visible : false;
  const effectorStates: Array<[THREE_NS.Object3D, boolean]> = [];
  if (viewer.ikController) {
    for (const obj of Object.values(viewer.ikController.effectors)) {
      effectorStates.push([obj, obj.visible]);
      obj.visible = false;
    }
    for (const obj of Object.values(viewer.ikController.poleTargets)) {
      effectorStates.push([obj, obj.visible]);
      obj.visible = false;
    }
  }
  const oldBg = viewer.scene.background;

  viewer.jointMarkers.forEach((m) => {
    m.visible = false;
  });
  if (viewer.skeletonHelper) viewer.skeletonHelper.visible = false;
  if (viewer.directionalSkydome) viewer.directionalSkydome.visible = false;
  if (viewer.gridHelper) viewer.gridHelper.visible = false;
  if (viewer.captureFrame) viewer.captureFrame.visible = false;
  if (transformObj) transformObj.visible = false;
  for (const rig of rigs) {
    rig.mesh.material = depthMaterial;
  }
  viewer.scene.background = new THREE.Color(0x000000);

  let dataUrl: string | null = null;
  viewer.beginCaptureBatch(width, height);
  try {
    viewer.renderer.render(viewer.scene, cam);
    dataUrl = viewer.canvas.toDataURL("image/png");
  } finally {
    viewer.endCaptureBatch();
    for (const item of savedMaterials) {
      item.mesh.material = item.material;
    }
    depthMaterial.dispose();
    viewer.scene.background = oldBg;
    viewer.jointMarkers.forEach((m, idx) => {
      m.visible = markerStates[idx];
    });
    if (viewer.skeletonHelper) viewer.skeletonHelper.visible = skeletonVisible;
    if (viewer.directionalSkydome) viewer.directionalSkydome.visible = skydomeVisible;
    if (viewer.gridHelper) viewer.gridHelper.visible = gridVisible;
    if (viewer.captureFrame) viewer.captureFrame.visible = frameVisible;
    if (transformObj) transformObj.visible = transformVisible;
    for (const [obj, vis] of effectorStates) obj.visible = vis;
  }

  return dataUrl;
}

function overlapArea(a: Rect2D, b: Rect2D): number {
  const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return ox * oy;
}

/**
 * 在导出图上绘制全部角色的自定义标号（基于真实蒙皮顶点外接框定位），返回所有角色外接框和标号占用框供单角水印避让。
 */
function drawCharacterLabels(
  ctx: CanvasRenderingContext2D,
  options: PoseRenderOptions,
  isDarkBg: boolean,
  showLabels: boolean,
): { charRects: Rect2D[]; labelRects: Rect2D[] } {
  const { viewer, width, height, baseExportWidth, camera: camState, characters } = options;
  const THREE = viewer.THREE;
  viewer.updateCaptureCamera(
    width,
    height,
    camState.zoom,
    camState.offsetX,
    camState.offsetY,
    camState.yaw,
    -camState.pitch,
  );
  viewer.captureCamera.updateMatrixWorld(true);
  const cam = viewer.captureCamera;
  const rigs = collectCharacterRigs(viewer, characters);
  // 预览小窗按 width / baseExportWidth 等比缩放字号；正式导出时比例为 1.0，严格使用用户输入的像素字号
  const previewScale = baseExportWidth > 0 ? width / baseExportWidth : 1;

  const charRects: Rect2D[] = [];
  const labelRects: Rect2D[] = [];

  for (const rig of rigs) {
    const bounds = sampleCharacterScreenBounds(THREE, rig, cam, width, height);
    charRects.push({
      x: bounds.minX,
      y: bounds.minY,
      w: Math.max(1, bounds.maxX - bounds.minX),
      h: Math.max(1, bounds.maxY - bounds.minY),
    });

    if (!showLabels) continue;
    const labelText = rig.meta.label.trim();
    if (!labelText) continue;

    const style = rig.meta.labelStyle;
    const fontSize = Math.max(8, Math.round(style.fontSize * previewScale));

    ctx.save();
    ctx.font = `700 ${fontSize}px "${style.fontFamily}", "JetBrainsMapleMono", "Microsoft YaHei", sans-serif`;
    const textW = Math.ceil(ctx.measureText(labelText).width);
    const textH = Math.ceil(fontSize * 1.1);
    const gap = Math.max(6, Math.round(fontSize * 0.25));

    let anchorX = (bounds.minX + bounds.maxX) / 2;
    let anchorY = bounds.minY - textH / 2 - gap;

    if (style.position === "below") {
      anchorY = bounds.maxY + textH / 2 + gap;
    } else if (style.position === "forehead") {
      if (bounds.headBox) {
        // 精准额头：位于头部真实蒙皮外接框的水平正中、自头顶向下 28% 处
        anchorX = (bounds.headBox.minX + bounds.headBox.maxX) / 2;
        anchorY = bounds.headBox.minY + (bounds.headBox.maxY - bounds.headBox.minY) * 0.28;
      } else {
        const headPos = boneWorldPos(THREE, rig.bones, ["head"]);
        if (headPos) {
          const p = projectToCanvas(headPos, cam, width, height);
          anchorX = p.x;
          anchorY = p.y - fontSize * 0.35;
        }
      }
    } else if (style.position === "chest") {
      const neckPos = boneWorldPos(THREE, rig.bones, ["neck_01", "neck"]);
      const pelvisPos = boneWorldPos(THREE, rig.bones, ["pelvis", "spine01", "spine_01"]);
      const chestPos =
        neckPos && pelvisPos
          ? neckPos.clone().lerp(pelvisPos, 0.32)
          : boneWorldPos(THREE, rig.bones, ["spine03", "spine02", "spine_02", "spine01"]);
      if (chestPos) {
        const p = projectToCanvas(chestPos, cam, width, height);
        anchorX = p.x;
        anchorY = p.y;
      }
    }

    // 边界夹紧防止标号裁出画布
    const padX = Math.max(6, textW / 2 + 6);
    const padY = Math.max(6, textH / 2 + 6);
    anchorX = Math.max(padX, Math.min(width - padX, anchorX));
    anchorY = Math.max(padY, Math.min(height - padY, anchorY));

    labelRects.push({
      x: anchorX - textW / 2 - 4,
      y: anchorY - textH / 2 - 4,
      w: textW + 8,
      h: textH + 8,
    });

    ctx.translate(anchorX, anchorY);
    if (style.rotation) {
      ctx.rotate((style.rotation * Math.PI) / 180);
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(2, Math.round(fontSize * 0.14));
    ctx.strokeStyle = isDarkBg ? "rgba(0, 0, 0, 0.88)" : "rgba(255, 255, 255, 0.94)";
    ctx.fillStyle = style.color || "#E5252A";
    ctx.strokeText(labelText, 0, 0);
    ctx.fillText(labelText, 0, 0);
    ctx.restore();
  }

  return { charRects, labelRects };
}

/**
 * 智能单角红色「姿势参考 / Pose Refs」水印：
 * 按 左上 -> 右上 -> 左下 -> 右下 顺序评估与全部模型/标号的重叠面积；
 * 优先选完全不遮挡（重叠=0）的第一个角落；若四个角都会遮挡，则默认放在左上角。
 */
function drawSmartCornerWatermark(
  ctx: CanvasRenderingContext2D,
  options: PoseRenderOptions,
  isDarkBg: boolean,
  obstacles: readonly Rect2D[],
): void {
  const { width, height, baseExportWidth, watermarkStyle, language } = options;
  const text = language === "zh" ? "姿势参考" : "Pose Refs";
  const previewScale = baseExportWidth > 0 ? width / baseExportWidth : 1;
  const fontSize = Math.max(8, Math.round(watermarkStyle.fontSize * previewScale));
  const marginX = Math.max(10, Math.round(width * 0.018));
  const marginY = Math.max(10, Math.round(height * 0.018));

  ctx.save();
  ctx.font = `700 ${fontSize}px "${watermarkStyle.fontFamily}", "JetBrainsMapleMono", "Microsoft YaHei", sans-serif`;
  const textW = Math.ceil(ctx.measureText(text).width);
  const textH = Math.ceil(fontSize * 1.12);

  const candidates: Array<{
    x: number;
    y: number;
    align: CanvasTextAlign;
    baseline: CanvasTextBaseline;
    rect: Rect2D;
  }> = [
    {
      // 默认首选：左上角
      x: marginX,
      y: marginY,
      align: "left",
      baseline: "top",
      rect: { x: marginX, y: marginY, w: textW, h: textH },
    },
    {
      // 右上角
      x: width - marginX,
      y: marginY,
      align: "right",
      baseline: "top",
      rect: { x: width - marginX - textW, y: marginY, w: textW, h: textH },
    },
    {
      // 左下角
      x: marginX,
      y: height - marginY,
      align: "left",
      baseline: "bottom",
      rect: { x: marginX, y: height - marginY - textH, w: textW, h: textH },
    },
    {
      // 右下角
      x: width - marginX,
      y: height - marginY,
      align: "right",
      baseline: "bottom",
      rect: { x: width - marginX - textW, y: height - marginY - textH, w: textW, h: textH },
    },
  ];

  // 找到第一个与全部角色及标号重叠面积为 0 的角落；若全有遮挡则固定选候选[0]（左上角）
  let chosen = candidates[0];
  for (const candidate of candidates) {
    let totalOverlap = 0;
    for (const obs of obstacles) {
      totalOverlap += overlapArea(candidate.rect, obs);
      if (totalOverlap > 0) break;
    }
    if (totalOverlap === 0) {
      chosen = candidate;
      break;
    }
  }

  ctx.textAlign = chosen.align;
  ctx.textBaseline = chosen.baseline;
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(2, Math.round(fontSize * 0.1));
  ctx.strokeStyle = isDarkBg ? "rgba(0, 0, 0, 0.85)" : "rgba(255, 255, 255, 0.92)";
  ctx.fillStyle = "#E5252A";
  ctx.strokeText(text, chosen.x, chosen.y);
  ctx.fillText(text, chosen.x, chosen.y);
  ctx.restore();
}

function loadImageElement(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to decode rendered pose canvas"));
    img.src = dataUrl;
  });
}

function isDarkHex(hex: string): boolean {
  const [r, g, b] = hexToRgbArray(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}

/** 渲染单一导出模态（已叠加真实蒙皮定位标号和智能单角防遮挡水印），返回 PNG DataURL。 */
export async function renderPoseMode(
  mode: PoseExportModeKey,
  options: PoseRenderOptions,
  showLabels: boolean,
): Promise<string> {
  const { viewer, width, height, camera: camState, lighting, cornerWatermark } = options;

  let baseCanvas: HTMLCanvasElement;
  let isDarkBg = false;

  if (mode === "openpose") {
    baseCanvas = renderPureOpenPoseCanvas(options);
    isDarkBg = true;
  } else {
    let rawDataUrl: string | null = null;
    if (mode === "depth") {
      rawDataUrl = renderDepthMapDataUrl(options);
      isDarkBg = true;
    } else {
      viewer.updateLights(buildPoseLights(lighting) as unknown as Array<Record<string, unknown>>);
      viewer.setRimDarken(lighting.rimDarken);
      viewer.setShowSkydome(lighting.showSkydome);
      const bg = hexToRgbArray(lighting.background);
      isDarkBg = isDarkHex(lighting.background);
      rawDataUrl = viewer.capture(
        width,
        height,
        camState.zoom,
        bg,
        camState.offsetX,
        camState.offsetY,
        camState.yaw,
        -camState.pitch,
        mode === "mannequinSkeleton",
      );
    }
    if (!rawDataUrl) {
      throw new Error(`Pose capture returned empty image for mode "${mode}"`);
    }
    const img = await loadImageElement(rawDataUrl);
    baseCanvas = document.createElement("canvas");
    baseCanvas.width = width;
    baseCanvas.height = height;
    const ctx = baseCanvas.getContext("2d");
    if (ctx) {
      ctx.drawImage(img, 0, 0, width, height);
    }
  }

  const ctx = baseCanvas.getContext("2d");
  if (ctx) {
    const { charRects, labelRects } = drawCharacterLabels(ctx, options, isDarkBg, showLabels);
    if (cornerWatermark) {
      drawSmartCornerWatermark(ctx, options, isDarkBg, [...charRects, ...labelRects]);
    }
  }

  return baseCanvas.toDataURL("image/png");
}

/** 将 PNG dataURL 解码为 Uint8Array 以便直接落盘。 */
export function dataUrlToPngBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
