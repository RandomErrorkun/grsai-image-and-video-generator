import type * as THREE_NS from "three";

export interface PassiveCharacterEntry {
  id: string;
  mesh: THREE_NS.SkinnedMesh;
  skeleton: THREE_NS.Skeleton;
  boneList: THREE_NS.Bone[];
  bones: Record<string, THREE_NS.Bone>;
  initialPositions: Map<string, THREE_NS.Vector3>;
  color: string;
}

export class PoseViewerCore {
  THREE: typeof THREE_NS;
  scene: THREE_NS.Scene;
  camera: THREE_NS.PerspectiveCamera;
  captureCamera: THREE_NS.PerspectiveCamera;
  renderer: THREE_NS.WebGLRenderer;
  canvas: HTMLCanvasElement;
  orbit: {
    target: THREE_NS.Vector3;
    enabled: boolean;
    enableDamping: boolean;
    mouseButtons: Record<string, number>;
    update(): boolean;
  };
  transform: {
    dragging: boolean;
    visible: boolean;
    object: THREE_NS.Object3D | null;
  };
  transformHelper?: THREE_NS.Object3D | null;
  skinnedMesh: THREE_NS.SkinnedMesh | null;
  skeleton: THREE_NS.Skeleton | null;
  boneList: THREE_NS.Bone[];
  bones: Record<string, THREE_NS.Bone>;
  passiveCharacters: Map<string, PassiveCharacterEntry>;
  jointMarkers: THREE_NS.Mesh[];
  skeletonHelper: THREE_NS.SkeletonHelper | null;
  gridHelper: THREE_NS.Object3D | null;
  captureFrame: THREE_NS.Object3D | null;
  ikController: {
    effectors: Record<string, THREE_NS.Object3D>;
    poleTargets: Record<string, THREE_NS.Object3D>;
  } | null;
  sceneCameraTarget: THREE_NS.Vector3 | null;
  headScale: number;
  limbThickness: number;
  handScale: number;
  footScale: number;
  boneLengthParams: Record<string, number>;
  directionalSkydome: THREE_NS.Object3D | null;
  directionalSkydomeVisible: boolean;
  modelRotation: { x: number; y: number; z: number };
  selectedBone: THREE_NS.Bone | null;
  selectedIKEffector: unknown;
  selectedPoleTarget: unknown;
  directDrag: { active: boolean } | null;
  maxHistory: number;
  initialized: boolean;
  options: Record<string, unknown>;

  constructor(canvas: HTMLCanvasElement, options?: Record<string, unknown>);
  init(): Promise<void>;
  isInitialized(): boolean;
  setRimDarken(value: number): void;
  setShowSkydome(visible: boolean): void;
  updateLimbThickness(scale: number): void;
  updateHandScale(scale: number): void;
  updateFootScale(scale: number): void;
  setSkinMode(mode: string): void;
  loadData(data: Record<string, unknown>, preserveCamera?: boolean): void;
  updateLights(lights: Array<Record<string, unknown>>): void;
  setPose(pose: Record<string, unknown>, silent?: boolean): void;
  getPose(): Record<string, unknown>;
  resetPose(): void;
  resetSelectedBone(): void;
  recordState(): void;
  undo(): void;
  redo(): void;
  setActiveCharacterAppearance(params: {
    color?: string;
    transform?: { x: number; y: number; z: number; zoom: number };
  }): void;
  upsertPassiveCharacterFromActive(
    id: string,
    params: {
      pose?: Record<string, unknown>;
      color?: string;
      transform?: { x: number; y: number; z: number; zoom: number };
    },
  ): boolean;
  setPassiveCharacterState(
    id: string,
    params: {
      pose?: Record<string, unknown>;
      color?: string;
      transform?: { x: number; y: number; z: number; zoom: number };
    },
  ): boolean;
  removePassiveCharacter(id: string): boolean;
  clearPassiveCharacters(): void;
  setModelRotation(x: number, y: number, z: number): void;
  updateHeadScale(scale: number): void;
  updateBoneLengthScale(group: string, value: number): void;
  _setBoneOffsetScale(boneName: string, scale: number): void;
  _cacheShapedRestBonePositions(names: string[]): void;
  updateIKEffectorPositions?(): void;
  updateMarkers?(): void;
  deselectBone(): void;
  deselectIKEffector(): void;
  deselectPoleTarget(): void;
  applyHandPreset(side: "l" | "r", preset: Record<string, number[]>): void;
  interpolateHandPose(
    from: Record<string, number[]>,
    to: Record<string, number[]>,
    t: number,
    side: "l" | "r",
  ): void;
  applyWorldKeypointImport(
    worldKps: Record<string, THREE_NS.Vector3>,
    options?: Record<string, unknown>,
  ): void;
  updateCaptureCamera(
    width: number,
    height: number,
    zoom: number,
    offsetX?: number,
    offsetY?: number,
    yawDeg?: number,
    pitchDeg?: number,
  ): void;
  snapToCaptureCamera(
    width: number,
    height: number,
    zoom: number,
    offsetX?: number,
    offsetY?: number,
    yawDeg?: number,
    pitchDeg?: number,
  ): void;
  computeModelFitFraming(
    width: number,
    height: number,
    yawDeg?: number,
    pitchDeg?: number,
    margin?: number,
  ): { zoom: number; offsetX: number; offsetY: number } | null;
  waitForCaptureReady(): Promise<void>;
  capture(
    width: number,
    height: number,
    zoom: number,
    bgColor: number[] | null,
    offsetX?: number,
    offsetY?: number,
    yawDeg?: number,
    pitchDeg?: number,
    includeSkeleton?: boolean,
  ): string | null;
  beginCaptureBatch(width: number, height: number): void;
  endCaptureBatch(): void;
  resize(width: number, height: number): void;
  requestRender(): void;
  dispose(): void;
}
