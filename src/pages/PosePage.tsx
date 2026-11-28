/**
 * 3D 多角色姿势工坊页面（支持最多 26 人、5 套色板+自定义染色、自定义角色标号、
 * 三点立体光照、4 模态导出含深度图、四角防遮挡水印、1920×1080 基准裁切、
 * 智能 Markdown 身份锚定提示词块，以及 poses/ 多级带空格分类目录）。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Input,
  Slider,
  Spinner,
  Tooltip,
} from "@fluentui/react-components";
import {
  Add20Regular,
  ArrowRedo20Regular,
  ArrowReset20Regular,
  ArrowSync20Regular,
  ArrowUndo20Regular,
  Copy20Regular,
  Delete20Regular,
  Eye20Regular,
  FolderAdd20Regular,
  FolderOpen20Regular,
  ImageAdd20Regular,
  PanelLeft20Regular,
  PanelRight20Regular,
  Save20Regular,
  Send20Regular,
  Video20Regular,
} from "@fluentui/react-icons";
import { FluentSelect } from "../components/FluentSelect";
import { notice } from "../components/Notice";
import { DEFAULT_CONFIG } from "../core/config";
import {
  clampExportDimension,
  computeFontSizeForAreaRatio,
  POSE_ASPECT_PRESETS,
  POSE_LIGHTING_PRESETS,
  sizeForAspectInBounds,
  type PoseLabelPosition,
  type PoseLightingConfig,
  type PoseLightPreset,
  type PoseStudioConfig,
} from "../core/poseConfig";
import {
  autoAssignCharacterColor,
  createCustomColor,
  MAX_POSE_CHARACTERS,
  normalizeHexColor,
  PALETTE_NAMES,
  POSE_PALETTES,
  resolveColorPromptToken,
  selectPaletteColor,
  type BuiltinPaletteName,
} from "../core/posePalettes";
import {
  buildPosePromptAnchor,
  type ProjectedPoseCharacter,
} from "../core/posePrompt";
import {
  BUILTIN_POSE_DIRS,
  parsePoseProjectJson,
  POSE_FILE_EXTENSION,
  sanitizePoseFolderPath,
  sanitizePoseSegment,
  type PoseMeshParams,
  type PoseProportions,
} from "../core/poseStorage";
import { useConfigValue } from "../hooks/useConfigValue";
import { useLanguage, useTr } from "../hooks/useLanguage";
import { FONT_FAMILIES } from "./settingsView";
import { platform } from "../platform";
import { runAsync } from "../platform/async";
import type { PoseDirScanResult, PoseScannedEntry } from "../platform/types";
import { COMMON_POSES, PoseEngine } from "../pose/poseEngine";
import { dataUrlToPngBytes, type PoseExportModeKey } from "../pose/poseRenderer";
import { COMMON_POSE_THUMBNAILS } from "../pose/poseThumbnails";
import { cfg } from "../state/config";
import { sendPoseToPage, type PoseTransferTarget } from "../state/poseTransfer";
import { openFullscreenPreview, openInlinePreview } from "../state/preview";
import "./PosePage.css";

type LeftTab = "common" | "library";
type RightTab = "character" | "pose" | "body" | "scene" | "export";

const BODY_SLIDER_DEFS: ReadonlyArray<{
  key: keyof Pick<PoseMeshParams, "gender" | "age" | "height" | "weight" | "muscle">;
  labelKey: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
}> = [
  { key: "gender", labelKey: "pose.body.gender", min: 0, max: 1, step: 0.01, defaultValue: 0.5 },
  { key: "age", labelKey: "pose.body.age", min: 1, max: 90, step: 1, defaultValue: 25 },
  { key: "height", labelKey: "pose.body.height", min: 0, max: 1, step: 0.01, defaultValue: 0.5 },
  { key: "weight", labelKey: "pose.body.weight", min: 0, max: 1, step: 0.01, defaultValue: 0.5 },
  { key: "muscle", labelKey: "pose.body.muscle", min: 0, max: 1, step: 0.01, defaultValue: 0.5 },
];

const PROPORTION_SLIDER_DEFS: ReadonlyArray<{
  key: keyof PoseProportions;
  labelKey: string;
  min: number;
  max: number;
}> = [
  { key: "head", labelKey: "pose.prop.head", min: 0.6, max: 2.2 },
  { key: "neck", labelKey: "pose.prop.neck", min: 0.35, max: 2.0 },
  { key: "shoulder", labelKey: "pose.prop.shoulder", min: 0.55, max: 1.5 },
  { key: "spine", labelKey: "pose.prop.spine", min: 0.4, max: 1.6 },
  { key: "upper_arm", labelKey: "pose.prop.upper_arm", min: 0.4, max: 1.6 },
  { key: "forearm", labelKey: "pose.prop.forearm", min: 0.4, max: 1.6 },
  { key: "thigh", labelKey: "pose.prop.thigh", min: 0.35, max: 1.6 },
  { key: "shin", labelKey: "pose.prop.shin", min: 0.35, max: 1.6 },
  { key: "limb_thickness", labelKey: "pose.prop.limb_thickness", min: 0.6, max: 1.8 },
  { key: "hand_foot", labelKey: "pose.prop.hand_foot", min: 0.6, max: 1.6 },
];

/**
 * 动漫/二次元与写实头身比例预设：
 * 结合 MakeHuman 原生年龄/圆润体型 morph + 骨长缩放 + 四肢横截面粗细补偿 + 手脚协调缩放，
 * 确保 Q 版 2~5 头身圆润自然、不会出现“大头火柴人”问题。
 */
const HEAD_RATIO_PRESETS: ReadonlyArray<{
  id: string;
  labelKey: string;
  meshPatch: Partial<PoseMeshParams>;
  proportions: PoseProportions;
}> = [
  {
    id: "head2",
    labelKey: "pose.prop.preset_head2",
    meshPatch: { age: 2, height: 0.15, weight: 0.58, muscle: 0.2 },
    proportions: {
      head: 1.55,
      neck: 0.55,
      shoulder: 0.84,
      spine: 0.58,
      upper_arm: 0.58,
      forearm: 0.56,
      thigh: 0.52,
      shin: 0.48,
      limb_thickness: 1.32,
      hand_foot: 1.18,
    },
  },
  {
    id: "head3",
    labelKey: "pose.prop.preset_head3",
    meshPatch: { age: 3, height: 0.25, weight: 0.54, muscle: 0.25 },
    proportions: {
      head: 1.28,
      neck: 0.7,
      shoulder: 0.88,
      spine: 0.74,
      upper_arm: 0.72,
      forearm: 0.7,
      thigh: 0.68,
      shin: 0.65,
      limb_thickness: 1.18,
      hand_foot: 1.1,
    },
  },
  {
    id: "head4",
    labelKey: "pose.prop.preset_head4",
    meshPatch: { age: 5, height: 0.35, weight: 0.5, muscle: 0.3 },
    proportions: {
      head: 1.16,
      neck: 0.8,
      shoulder: 0.9,
      spine: 0.84,
      upper_arm: 0.82,
      forearm: 0.8,
      thigh: 0.8,
      shin: 0.78,
      limb_thickness: 1.1,
      hand_foot: 1.05,
    },
  },
  {
    id: "head5",
    labelKey: "pose.prop.preset_head5",
    meshPatch: { age: 9, height: 0.45, weight: 0.48, muscle: 0.35 },
    proportions: {
      head: 1.1,
      neck: 0.88,
      shoulder: 0.92,
      spine: 0.9,
      upper_arm: 0.88,
      forearm: 0.88,
      thigh: 0.88,
      shin: 0.88,
      limb_thickness: 1.04,
      hand_foot: 1.02,
    },
  },
  {
    id: "head6",
    labelKey: "pose.prop.preset_head6",
    meshPatch: { age: 15, height: 0.5, weight: 0.46, muscle: 0.4 },
    proportions: {
      head: 1.06,
      neck: 0.95,
      shoulder: 0.95,
      spine: 0.95,
      upper_arm: 0.95,
      forearm: 0.95,
      thigh: 0.96,
      shin: 0.96,
      limb_thickness: 1.0,
      hand_foot: 1.0,
    },
  },
  {
    id: "standard",
    labelKey: "pose.prop.preset_standard",
    meshPatch: { age: 25, height: 0.5, weight: 0.5, muscle: 0.5 },
    proportions: {
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
    },
  },
  {
    id: "tall",
    labelKey: "pose.prop.preset_tall",
    meshPatch: { age: 25, height: 0.8, weight: 0.44, muscle: 0.48 },
    proportions: {
      head: 0.9,
      neck: 1.05,
      shoulder: 1.0,
      spine: 1.04,
      upper_arm: 1.06,
      forearm: 1.08,
      thigh: 1.14,
      shin: 1.18,
      limb_thickness: 0.94,
      hand_foot: 0.98,
    },
  },
];

const PT_TO_PX = 96 / 72;

function quotePromptFamily(family: string): string {
  const names = family
    .split(",")
    .map((n) => n.trim().replace(/"/g, ""))
    .filter(Boolean);
  return names.length ? `${names.map((n) => `"${n}"`).join(", ")}, monospace` : '"JetBrainsMapleMono", monospace';
}

function clampPixelSize(raw: string, fallback: number): number {
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(5000, Math.round(parsed)));
}

const DEPTH_FLIP_GROUPS: ReadonlyArray<{ key: string; labelKey: string }> = [
  { key: "body", labelKey: "pose.flip.body" },
  { key: "torso", labelKey: "pose.flip.torso" },
  { key: "lArmUpper", labelKey: "pose.flip.l_arm_upper" },
  { key: "lArmLower", labelKey: "pose.flip.l_arm_lower" },
  { key: "rArmUpper", labelKey: "pose.flip.r_arm_upper" },
  { key: "rArmLower", labelKey: "pose.flip.r_arm_lower" },
  { key: "lLegUpper", labelKey: "pose.flip.l_leg_upper" },
  { key: "lLegLower", labelKey: "pose.flip.l_leg_lower" },
  { key: "rLegUpper", labelKey: "pose.flip.r_leg_upper" },
  { key: "rLegLower", labelKey: "pose.flip.r_leg_lower" },
];

interface PosePageProps {
  active: boolean;
}

function formatStamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export default function PosePage({ active }: PosePageProps) {
  const t = useTr();
  const language = useLanguage();
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<PoseEngine | null>(null);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewSeqRef = useRef(0);

  const [poseCfg, setPoseCfg] = useState<PoseStudioConfig>(() => cfg.getPoseConfig());
  const poseCfgRef = useRef(poseCfg);
  useEffect(() => {
    poseCfgRef.current = poseCfg;
  }, [poseCfg]);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [, setTick] = useState(0);
  const [selectedBone, setSelectedBone] = useState<string | null>(null);

  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [leftTab, setLeftTab] = useState<LeftTab>("common");
  const [rightTab, setRightTab] = useState<RightTab>("character");

  const [paletteName, setPaletteName] = useState<BuiltinPaletteName>("Tableau20");
  const [paletteSearch, setPaletteSearch] = useState("");
  const [customHexInput, setCustomHexInput] = useState("#4E79A7");

  const [previewMode, setPreviewMode] = useState<PoseExportModeKey>("mannequin");
  const [previewUrl, setPreviewUrl] = useState<string>("");
  const [previewMenu, setPreviewMenu] = useState<{ x: number; y: number } | null>(null);
  const [projectedChars, setProjectedChars] = useState<ProjectedPoseCharacter[]>([]);

  // 分辨率、标号字号、水印字号均采用草稿输入框（失焦 / 回车 / 点应用时生效，防止打字时热更新跳变）
  const [widthDraft, setWidthDraft] = useState(() => String(poseCfg.exportWidth));
  const [heightDraft, setHeightDraft] = useState(() => String(poseCfg.exportHeight));
  const [labelSizeDraft, setLabelSizeDraft] = useState(() => String(poseCfg.labelDefaults.fontSize));
  const [watermarkSizeDraft, setWatermarkSizeDraft] = useState(() => String(poseCfg.watermarkStyle.fontSize));

  // 提示词预览区的字体与字号跟随全局文本格式设置
  const promptFormatEnabled = useConfigValue("text_format_enabled", true);
  const promptFontFamily = useConfigValue("text_font_family", "JetBrainsMapleMono");
  const promptFontSize = useConfigValue("text_font_size", 9);
  const watermarkAreaRatio = useConfigValue(
    "pose_watermark_area_ratio",
    DEFAULT_CONFIG.pose_watermark_area_ratio,
  );
  const labelAreaRatio = useConfigValue(
    "pose_label_area_ratio",
    DEFAULT_CONFIG.pose_label_area_ratio,
  );
  const prevAreaRatiosRef = useRef({ wm: watermarkAreaRatio, lbl: labelAreaRatio });
  const promptPreviewStyle: CSSProperties = promptFormatEnabled
    ? {
        fontFamily: quotePromptFamily(promptFontFamily),
        fontSize: `${Number((promptFontSize * PT_TO_PX).toFixed(2))}px`,
      }
    : { fontFamily: '"JetBrainsMapleMono", monospace' };

  const [overlayUrl, setOverlayUrl] = useState<string | null>(null);
  const [overlayOpacity, setOverlayOpacity] = useState(0.4);

  // poses/ 目录库状态
  const [scanResult, setScanResult] = useState<PoseDirScanResult | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<string>("__all__");
  const [libraryFilter, setLibraryFilter] = useState("");
  const [jsonThumbs, setJsonThumbs] = useState<Record<string, string>>({});

  // 保存姿势弹窗
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveFolder, setSaveFolder] = useState<string>(BUILTIN_POSE_DIRS.saved);
  const [saveIncludeShape, setSaveIncludeShape] = useState(true);

  // 新建子目录弹窗
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [newFolderPath, setNewFolderPath] = useState("");

  const posesRoot = useMemo(
    () => platform.paths.join(platform.dataDir, BUILTIN_POSE_DIRS.root),
    [],
  );

  /** 更新并持久化 grsai_config.json 的 pose 块。 */
  const updatePoseConfig = useCallback((updater: (prev: PoseStudioConfig) => PoseStudioConfig) => {
    setPoseCfg((prev) => {
      const next = updater(prev);
      cfg.setPoseConfig(next);
      return next;
    });
  }, []);

  /** 确保程序目录下的 poses/recent、poses/saved、poses/presets 英文目录存在，并扫描全目录树。 */
  const refreshPosesLibrary = useCallback(async () => {
    try {
      await platform.fs.makeDirs(posesRoot);
      for (const sub of [BUILTIN_POSE_DIRS.recent, BUILTIN_POSE_DIRS.saved, BUILTIN_POSE_DIRS.presets]) {
        await platform.fs.makeDirs(platform.paths.join(posesRoot, sub));
      }
      await platform.media.allow([posesRoot], true).catch(() => {});
      const scanned = await platform.pose.scanPosesDir(posesRoot);
      setScanResult(scanned);

      // 异步提取 .pose.json 内嵌的轻量缩略图
      const jsonEntries = scanned.entries.filter((e) => e.kind === "pose_json").slice(0, 120);
      const thumbs: Record<string, string> = {};
      await Promise.all(
        jsonEntries.map(async (entry) => {
          try {
            const text = await platform.fs.readText(entry.path);
            const parsed = JSON.parse(text) as { thumbnail?: unknown };
            if (typeof parsed.thumbnail === "string" && parsed.thumbnail.startsWith("data:image/")) {
              thumbs[entry.relativePath] = parsed.thumbnail;
            }
          } catch {
            // 忽略单个损坏文件
          }
        }),
      );
      setJsonThumbs(thumbs);
    } catch (error) {
      console.error("[pose] scan poses dir failed", error);
    }
  }, [posesRoot]);

  const schedulePreview = useCallback(() => {
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    const seq = ++previewSeqRef.current;
    previewTimerRef.current = setTimeout(() => {
      previewTimerRef.current = null;
      const engine = engineRef.current;
      if (!engine || !engine.ready) return;
      const currentCfg = poseCfgRef.current;
      setProjectedChars(engine.projectCharacters());
      const scale = Math.min(1, 360 / Math.max(engine.exportWidth, engine.exportHeight));
      const pw = Math.max(80, Math.round(engine.exportWidth * scale));
      const ph = Math.max(80, Math.round(engine.exportHeight * scale));
      void engine
        .renderMode(previewMode, {
          width: pw,
          height: ph,
          cornerWatermark: currentCfg.cornerWatermark,
          watermarkStyle: currentCfg.watermarkStyle,
          showLabels: currentCfg.promptAnchor.useLabel,
          language,
        })
        .then((url) => {
          if (seq === previewSeqRef.current) setPreviewUrl(url);
        })
        .catch(() => {});
    }, 180);
  }, [language, previewMode]);

  // 首次挂载初始化 Three.js 与 MakeHuman
  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;
    let disposed = false;

    const initial = cfg.getPoseConfig();
    canvas.width = stage.clientWidth || 640;
    canvas.height = stage.clientHeight || 520;

    const engine = new PoseEngine(
      canvas,
      {
        width: initial.exportWidth,
        height: initial.exportHeight,
        lighting: initial.lighting,
        labelDefaults: initial.labelDefaults,
      },
      {
        onStateChange: () => {
          if (!disposed) setTick((n) => n + 1);
        },
        onBoneSelected: (name) => {
          if (!disposed) setSelectedBone(name);
        },
        onPreviewInvalidated: () => {
          if (!disposed) schedulePreview();
        },
      },
    );
    engineRef.current = engine;

    const observer = new ResizeObserver(() => {
      if (stage.clientWidth > 10 && stage.clientHeight > 10) {
        engine.resize(stage.clientWidth, stage.clientHeight);
      }
    });
    observer.observe(stage);

    void (async () => {
      try {
        const buffer = await platform.pose.loadBodyPack();
        if (disposed) return;
        await engine.init(buffer);
        if (disposed) return;
        setLoading(false);
        setLoadError(null);
        await refreshPosesLibrary();
      } catch (error) {
        if (!disposed) {
          setLoading(false);
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      }
    })();

    return () => {
      disposed = true;
      observer.disconnect();
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  // 切回姿势 Tab 时刷新视口尺寸与预览
  useEffect(() => {
    if (!active) return;
    const stage = stageRef.current;
    const engine = engineRef.current;
    if (stage && engine?.ready) {
      engine.resize(stage.clientWidth, stage.clientHeight);
      engine.viewer.requestRender();
      schedulePreview();
    }
  }, [active, schedulePreview]);

  // 预览模态、水印、水印样式、标号或语言变化时重新渲染预览小窗
  useEffect(() => {
    if (engineRef.current?.ready) {
      schedulePreview();
    }
  }, [
    previewMode,
    poseCfg.cornerWatermark,
    poseCfg.watermarkStyle.fontFamily,
    poseCfg.watermarkStyle.fontSize,
    poseCfg.promptAnchor.useLabel,
    language,
    schedulePreview,
  ]);

  // 关闭右下角预览图右键菜单
  useEffect(() => {
    if (!previewMenu) return;
    const close = () => setPreviewMenu(null);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [previewMenu]);

  // 快捷键 Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y（仅在姿势页激活时拦截）
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select")) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        engineRef.current?.undo();
      } else if ((key === "z" && event.shiftKey) || key === "y") {
        event.preventDefault();
        engineRef.current?.redo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active]);

  const engine = engineRef.current;
  const activeChar = engine?.activeCharacter() ?? null;
  const characters = engine?.characters ?? [];
  const activeIndex = engine?.activeIndex ?? 0;

  // 切换选中角色时同步自定义颜色输入框和标号字号输入框
  useEffect(() => {
    if (activeChar) {
      setCustomHexInput(activeChar.color.hex);
      setLabelSizeDraft(String(activeChar.labelStyle.fontSize));
    }
  }, [activeChar?.id, activeChar?.color.hex, activeChar?.labelStyle.fontSize]);

  useEffect(() => {
    setWidthDraft(String(poseCfg.exportWidth));
    setHeightDraft(String(poseCfg.exportHeight));
  }, [poseCfg.exportWidth, poseCfg.exportHeight]);

  useEffect(() => {
    setWatermarkSizeDraft(String(poseCfg.watermarkStyle.fontSize));
  }, [poseCfg.watermarkStyle.fontSize]);

  // 在设置页保存新的面积占比后，自动按新占比重算当前分辨率下的水印与全部角色标号字号
  useEffect(() => {
    const prev = prevAreaRatiosRef.current;
    const wmChanged = watermarkAreaRatio !== prev.wm;
    const lblChanged = labelAreaRatio !== prev.lbl;
    if (!wmChanged && !lblChanged) return;
    prevAreaRatiosRef.current = { wm: watermarkAreaRatio, lbl: labelAreaRatio };
    const { exportWidth: w, exportHeight: h } = poseCfgRef.current;

    let nextWmSize: number | null = null;
    let nextDefaultLblSize: number | null = null;

    if (wmChanged) {
      nextWmSize = computeFontSizeForAreaRatio(
        w,
        h,
        watermarkAreaRatio,
        language === "zh" ? "姿势参考" : "Pose Refs",
      );
      setWatermarkSizeDraft(String(nextWmSize));
    }
    if (lblChanged) {
      nextDefaultLblSize = computeFontSizeForAreaRatio(w, h, labelAreaRatio, "A");
      const activeLblSize =
        engineRef.current?.recomputeAllCharactersLabelFontSize(w, h, labelAreaRatio) ?? nextDefaultLblSize;
      setLabelSizeDraft(String(activeLblSize));
    }

    updatePoseConfig((cur) => ({
      ...cur,
      watermarkStyle:
        nextWmSize !== null ? { ...cur.watermarkStyle, fontSize: nextWmSize } : cur.watermarkStyle,
      labelDefaults:
        nextDefaultLblSize !== null
          ? { ...cur.labelDefaults, fontSize: nextDefaultLblSize }
          : cur.labelDefaults,
    }));
  }, [watermarkAreaRatio, labelAreaRatio, language, updatePoseConfig]);

  // 实时构建预制身份锚定提示词块与温和防呆提醒
  const promptResult = useMemo(
    () =>
      buildPosePromptAnchor({
        characters: projectedChars,
        language,
        exportModes: poseCfg.exportModes,
        anchor: poseCfg.promptAnchor,
      }),
    [projectedChars, language, poseCfg.exportModes, poseCfg.promptAnchor],
  );

  // --- 光照更新 ---
  const applyLightingUpdate = (nextLighting: PoseLightingConfig) => {
    updatePoseConfig((prev) => ({ ...prev, lighting: nextLighting }));
    engineRef.current?.applyLighting(nextLighting);
  };

  const handleLightPreset = (preset: Exclude<PoseLightPreset, "custom">) => {
    applyLightingUpdate({ ...POSE_LIGHTING_PRESETS[preset] });
  };

  const patchLightField = <K extends keyof PoseLightingConfig>(key: K, value: PoseLightingConfig[K]) => {
    applyLightingUpdate({ ...poseCfg.lighting, preset: "custom", [key]: value });
  };

  // --- 分辨率更新（1920×1080 基准裁切 + 按面积占比自动缩放水印与标号字号 + 自动保存） ---
  const applyExportSize = (width: number, height: number) => {
    const w = clampExportDimension(width);
    const h = clampExportDimension(height);
    const sizeChanged = w !== poseCfgRef.current.exportWidth || h !== poseCfgRef.current.exportHeight;
    setWidthDraft(String(w));
    setHeightDraft(String(h));
    if (sizeChanged) {
      const wmRatio = Number(cfg.get("pose_watermark_area_ratio", DEFAULT_CONFIG.pose_watermark_area_ratio));
      const lblRatio = Number(cfg.get("pose_label_area_ratio", DEFAULT_CONFIG.pose_label_area_ratio));
      const nextWmSize = computeFontSizeForAreaRatio(
        w,
        h,
        wmRatio,
        language === "zh" ? "姿势参考" : "Pose Refs",
      );
      const defaultLblSize = computeFontSizeForAreaRatio(w, h, lblRatio, "A");
      const activeLblSize =
        engineRef.current?.recomputeAllCharactersLabelFontSize(w, h, lblRatio) ?? defaultLblSize;
      setWatermarkSizeDraft(String(nextWmSize));
      setLabelSizeDraft(String(activeLblSize));
      updatePoseConfig((prev) => ({
        ...prev,
        exportWidth: w,
        exportHeight: h,
        watermarkStyle: { ...prev.watermarkStyle, fontSize: nextWmSize },
        labelDefaults: { ...prev.labelDefaults, fontSize: defaultLblSize },
      }));
      engineRef.current?.setExportDimensions(w, h);
    } else {
      updatePoseConfig((prev) => ({ ...prev, exportWidth: w, exportHeight: h }));
      engineRef.current?.setExportDimensions(w, h);
    }
  };

  const commitExportSizeDraft = () => {
    const w = Number(widthDraft.trim());
    const h = Number(heightDraft.trim());
    applyExportSize(
      Number.isFinite(w) && w > 0 ? w : poseCfg.exportWidth,
      Number.isFinite(h) && h > 0 ? h : poseCfg.exportHeight,
    );
  };

  const commitLabelSizeDraft = () => {
    if (!activeChar) return;
    const nextSize = clampPixelSize(labelSizeDraft, activeChar.labelStyle.fontSize);
    setLabelSizeDraft(String(nextSize));
    engineRef.current?.setActiveLabelStyle({ fontSize: nextSize });
    updatePoseConfig((prev) => ({
      ...prev,
      labelDefaults: { ...prev.labelDefaults, fontSize: nextSize },
    }));
  };

  const commitWatermarkSizeDraft = () => {
    const nextSize = clampPixelSize(watermarkSizeDraft, poseCfg.watermarkStyle.fontSize);
    setWatermarkSizeDraft(String(nextSize));
    updatePoseConfig((prev) => ({
      ...prev,
      watermarkStyle: { ...prev.watermarkStyle, fontSize: nextSize },
    }));
  };

  /** 将当前右下角预览模态渲染为全尺寸高清 PNG 写入隐藏缓存并在软件内灯箱（或全屏子窗口）打开，支持滚轮缩放与 F11。 */
  const openShotLightbox = async (fullscreen = false) => {
    const eng = engineRef.current;
    if (!eng || !eng.ready) return;
    setPreviewMenu(null);
    try {
      const dataUrl = await eng.renderMode(previewMode, {
        width: poseCfg.exportWidth,
        height: poseCfg.exportHeight,
        cornerWatermark: poseCfg.cornerWatermark,
        watermarkStyle: poseCfg.watermarkStyle,
        showLabels: poseCfg.promptAnchor.useLabel,
        language,
      });
      await platform.fs.makeDirs(posesRoot);
      const previewFile = platform.paths.join(posesRoot, `.preview_${previewMode}.png`);
      await platform.fs.write(previewFile, dataUrlToPngBytes(dataUrl));
      await platform.media.allow([previewFile], false).catch(() => {});
      if (fullscreen && platform.isTauri && platform.previewWindow) {
        openFullscreenPreview(previewFile);
      } else {
        openInlinePreview(previewFile);
      }
    } catch (error) {
      notice("error", t("common.error"), error instanceof Error ? error.message : String(error));
    }
  };

  // --- 发送到图像 / 视频生成 ---
  const handleSendTo = async (target: PoseTransferTarget) => {
    const eng = engineRef.current;
    if (!eng || !eng.ready || sending) return;

    const selectedModes: PoseExportModeKey[] = (
      ["mannequin", "mannequinSkeleton", "openpose", "depth"] as const
    ).filter((key) => poseCfg.exportModes[key]);

    if (selectedModes.length === 0) {
      notice("warning", t("common.warning"), t("pose.msg.no_export_selected"));
      return;
    }

    setSending(true);
    try {
      const recentDir = platform.paths.join(posesRoot, BUILTIN_POSE_DIRS.recent);
      await platform.fs.makeDirs(recentDir);
      const stamp = formatStamp();

      // 1. 导出选中的所有参考图 PNG 到 poses/recent/
      const exportedPaths: string[] = [];
      for (const mode of selectedModes) {
        const dataUrl = await eng.renderMode(mode, {
          width: poseCfg.exportWidth,
          height: poseCfg.exportHeight,
          cornerWatermark: poseCfg.cornerWatermark,
          watermarkStyle: poseCfg.watermarkStyle,
          showLabels: poseCfg.promptAnchor.useLabel,
          language,
        });
        const pngPath = platform.paths.join(recentDir, `pose_${stamp}_${mode}.png`);
        await platform.fs.write(pngPath, dataUrlToPngBytes(dataUrl));
        exportedPaths.push(pngPath);
      }

      // 2. 自动保存本次姿势工程到 poses/recent/，方便下次直接打开或二次修改
      const projectDoc = await eng.serializeProject(`recent_${stamp}`, true);
      const projectPath = platform.paths.join(recentDir, `pose_${stamp}${POSE_FILE_EXTENSION}`);
      await platform.fs.writeText(projectPath, JSON.stringify(projectDoc, null, 2));

      await platform.media.allow(exportedPaths, false).catch(() => {});

      // 3. 计算实时投影与预制身份锚定提示词块
      const latestProjected = eng.projectCharacters();
      setProjectedChars(latestProjected);
      const anchorResult = buildPosePromptAnchor({
        characters: latestProjected,
        language,
        exportModes: poseCfg.exportModes,
        anchor: poseCfg.promptAnchor,
      });

      sendPoseToPage({
        target,
        imagePaths: exportedPaths,
        promptBlock: anchorResult.text || undefined,
      });

      notice(
        "success",
        t("common.success"),
        t(target === "generator" ? "pose.msg.sent_image" : "pose.msg.sent_video", {
          count: exportedPaths.length,
        }),
      );
      void refreshPosesLibrary();
    } catch (error) {
      notice("error", t("common.error"), error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  // --- 手动保存姿势到指定子目录 ---
  const openSavePoseDialog = () => {
    setSaveName(`pose_${formatStamp()}`);
    if (selectedFolder !== "__all__" && selectedFolder !== "") {
      setSaveFolder(selectedFolder);
    } else {
      setSaveFolder(BUILTIN_POSE_DIRS.saved);
    }
    setSaveDialogOpen(true);
  };

  const confirmSavePose = async () => {
    const eng = engineRef.current;
    if (!eng || !eng.ready) return;
    const safeName = sanitizePoseSegment(saveName);
    if (!safeName) {
      notice("warning", t("common.warning"), t("pose.msg.invalid_name"));
      return;
    }
    const safeFolder = sanitizePoseFolderPath(saveFolder);
    if (safeFolder === null) {
      notice("warning", t("common.warning"), t("pose.msg.invalid_folder"));
      return;
    }
    try {
      const targetDir = safeFolder
        ? platform.paths.join(posesRoot, ...safeFolder.split("/"))
        : posesRoot;
      await platform.fs.makeDirs(targetDir);
      const filePath = platform.paths.join(targetDir, `${safeName}${POSE_FILE_EXTENSION}`);
      const doc = await eng.serializeProject(safeName, saveIncludeShape);
      await platform.fs.writeText(filePath, JSON.stringify(doc, null, 2));
      setSaveDialogOpen(false);
      notice("success", t("common.success"), t("pose.msg.saved_pose", { name: safeName }));
      await refreshPosesLibrary();
    } catch (error) {
      notice("error", t("common.error"), error instanceof Error ? error.message : String(error));
    }
  };

  // --- 新建分类子目录（支持空格与多级路径） ---
  const confirmCreateFolder = async () => {
    const safeFolder = sanitizePoseFolderPath(newFolderPath);
    if (!safeFolder) {
      notice("warning", t("common.warning"), t("pose.msg.invalid_folder"));
      return;
    }
    try {
      const targetDir = platform.paths.join(posesRoot, ...safeFolder.split("/"));
      await platform.fs.makeDirs(targetDir);
      setFolderDialogOpen(false);
      setNewFolderPath("");
      setSelectedFolder(safeFolder);
      notice("success", t("common.success"), t("pose.msg.folder_created", { folder: safeFolder }));
      await refreshPosesLibrary();
    } catch (error) {
      notice("error", t("common.error"), error instanceof Error ? error.message : String(error));
    }
  };

  // --- 加载 poses/ 中的条目（.pose.json 或 OpenPose 骨架图） ---
  const handleOpenLibraryEntry = async (entry: PoseScannedEntry) => {
    const eng = engineRef.current;
    if (!eng || !eng.ready) return;
    try {
      if (entry.kind === "pose_json") {
        const text = await platform.fs.readText(entry.path);
        const doc = parsePoseProjectJson(text, entry.name, poseCfg.labelDefaults);
        eng.loadProject(doc);
        if (doc.lighting) {
          applyLightingUpdate(doc.lighting);
        }
        notice("success", t("common.success"), t("pose.msg.loaded_pose", { name: entry.name }));
        return;
      }

      // OpenPose 骨架图：反推 3D 姿势到当前选中角色
      await platform.media.allow([entry.path], false).catch(() => {});
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = platform.media.url(entry.path);
      await img.decode();
      const note = eng.applyOpenPoseImage(img, entry.name);
      notice("success", t("common.success"), `${entry.name} (${note})`);
    } catch (error) {
      notice("error", t("common.error"), error instanceof Error ? error.message : String(error));
    }
  };

  const handleDeleteLibraryEntry = async (entry: PoseScannedEntry) => {
    try {
      await platform.fs.remove(entry.path);
      notice("info", t("common.info"), t("pose.msg.deleted_pose", { name: entry.name }));
      await refreshPosesLibrary();
    } catch (error) {
      notice("error", t("common.error"), error instanceof Error ? error.message : String(error));
    }
  };

  // --- 导入外部 OpenPose 图 ---
  const handlePickOpenPoseImage = async () => {
    const eng = engineRef.current;
    if (!eng || !eng.ready) return;
    const picked = await platform.dialog.pickFiles({
      title: t("pose.library.import_openpose"),
      multiple: false,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    const filePath = picked[0];
    if (!filePath) return;
    try {
      await platform.media.allow([filePath], false).catch(() => {});
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = platform.media.url(filePath);
      await img.decode();
      const name = platform.paths.basename(filePath);
      const note = eng.applyOpenPoseImage(img, name);
      notice("success", t("common.success"), `${name} (${note})`);
    } catch (error) {
      notice("error", t("common.error"), error instanceof Error ? error.message : String(error));
    }
  };

  // --- 参考图半透明叠加对位 ---
  const handlePickOverlayImage = async () => {
    const picked = await platform.dialog.pickFiles({
      title: t("pose.scene.overlay_pick"),
      multiple: false,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    const filePath = picked[0];
    if (!filePath) return;
    try {
      await platform.media.allow([filePath], false).catch(() => {});
      const url = platform.media.url(filePath);
      setOverlayUrl(url);
      await engineRef.current?.setReferenceOverlay(url);
      engineRef.current?.setReferenceOverlayOpacity(overlayOpacity);
    } catch (error) {
      notice("error", t("common.error"), error instanceof Error ? error.message : String(error));
    }
  };

  const clearOverlayImage = async () => {
    setOverlayUrl(null);
    await engineRef.current?.setReferenceOverlay(null);
  };

  // --- 过滤姿势库条目 ---
  const folderOptions = useMemo(() => {
    const base = ["__all__"];
    const folders = scanResult?.folders ?? [
      BUILTIN_POSE_DIRS.recent,
      BUILTIN_POSE_DIRS.saved,
      BUILTIN_POSE_DIRS.presets,
    ];
    return [...base, ...folders];
  }, [scanResult]);

  const filteredLibraryEntries = useMemo(() => {
    const all = scanResult?.entries ?? [];
    const q = libraryFilter.trim().toLowerCase();
    return all.filter((entry) => {
      if (selectedFolder !== "__all__") {
        if (entry.folder !== selectedFolder && !entry.folder.startsWith(`${selectedFolder}/`)) {
          return false;
        }
      }
      if (q) {
        return (
          entry.name.toLowerCase().includes(q) ||
          entry.folder.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [scanResult, selectedFolder, libraryFilter]);

  const filteredPaletteColors = useMemo(() => {
    const list = POSE_PALETTES[paletteName];
    const q = paletteSearch.trim().toLowerCase();
    if (!q) return list;
    return list.filter((c) => c.name.toLowerCase().includes(q) || c.hex.toLowerCase().includes(q));
  }, [paletteName, paletteSearch]);

  const boneRot = engine?.getSelectedBoneRotation() ?? null;
  const activeOpenpose = activeChar?.openpose as
    | { name?: string; flips?: Record<string, boolean>; depthMode?: "planar" | "estimate" }
    | null
    | undefined;

  return (
    <div className="pose-page">
      {/* 顶部工具栏 */}
      <header className="pose-toolbar">
        <div className="pose-toolbar__group">
          <Tooltip content={t("pose.toggle_left")} relationship="label">
            <Button
              size="small"
              appearance={leftOpen ? "subtle" : "transparent"}
              icon={<PanelLeft20Regular />}
              aria-label={t("pose.toggle_left")}
              onClick={() => setLeftOpen((v) => !v)}
            />
          </Tooltip>
          <div className="pose-segmented">
            <button
              type="button"
              className={engine?.editMode !== "camera" ? "pose-seg-btn is-active" : "pose-seg-btn"}
              onClick={() => engine?.setEditMode("pose")}
            >
              {t("pose.mode.pose")}
            </button>
            <button
              type="button"
              className={engine?.editMode === "camera" ? "pose-seg-btn is-active" : "pose-seg-btn"}
              onClick={() => engine?.setEditMode("camera")}
            >
              {t("pose.mode.camera")}
            </button>
          </div>
          {engine?.editMode !== "camera" ? (
            <div className="pose-segmented">
              <button
                type="button"
                className={engine?.poseTool !== "move" ? "pose-seg-btn is-active" : "pose-seg-btn"}
                onClick={() => engine?.setPoseTool("joints")}
              >
                {t("pose.tool.joints")}
              </button>
              <button
                type="button"
                className={engine?.poseTool === "move" ? "pose-seg-btn is-active" : "pose-seg-btn"}
                onClick={() => engine?.setPoseTool("move")}
              >
                {t("pose.tool.move")}
              </button>
            </div>
          ) : null}
          <Tooltip content={t("pose.undo")} relationship="label">
            <Button
              size="small"
              appearance="subtle"
              icon={<ArrowUndo20Regular />}
              aria-label={t("pose.undo")}
              onClick={() => engine?.undo()}
            />
          </Tooltip>
          <Tooltip content={t("pose.redo")} relationship="label">
            <Button
              size="small"
              appearance="subtle"
              icon={<ArrowRedo20Regular />}
              aria-label={t("pose.redo")}
              onClick={() => engine?.redo()}
            />
          </Tooltip>
          <Tooltip content={t("pose.reset_pose")} relationship="label">
            <Button
              size="small"
              appearance="subtle"
              icon={<ArrowReset20Regular />}
              aria-label={t("pose.reset_pose")}
              onClick={() => engine?.resetActivePose()}
            />
          </Tooltip>
          <Button
            size="small"
            appearance="subtle"
            onClick={() => engine?.fitAllCharacters(true)}
          >
            {t("pose.fit_frame")}
          </Button>
        </div>

        <div className="pose-toolbar__group">
          <span className="pose-toolbar__res">
            {poseCfg.exportWidth}×{poseCfg.exportHeight}
          </span>
          <Button
            size="small"
            appearance="primary"
            icon={<Send20Regular />}
            disabled={loading || sending}
            onClick={() => runAsync(handleSendTo("generator"))}
          >
            {t("pose.send_to_image")}
          </Button>
          <Button
            size="small"
            appearance="primary"
            icon={<Video20Regular />}
            disabled={loading || sending}
            onClick={() => runAsync(handleSendTo("video"))}
          >
            {t("pose.send_to_video")}
          </Button>
          <Tooltip content={t("pose.toggle_right")} relationship="label">
            <Button
              size="small"
              appearance={rightOpen ? "subtle" : "transparent"}
              icon={<PanelRight20Regular />}
              aria-label={t("pose.toggle_right")}
              onClick={() => setRightOpen((v) => !v)}
            />
          </Tooltip>
        </div>
      </header>

      {/* 主三栏区域 */}
      <div className="pose-workspace">
        {/* 左侧预设与 poses/ 姿势库 */}
        {leftOpen ? (
          <aside className="pose-panel pose-panel--left">
            <div className="pose-tabs">
              <button
                type="button"
                className={leftTab === "common" ? "pose-tab is-active" : "pose-tab"}
                onClick={() => setLeftTab("common")}
              >
                {t("pose.left.common")} ({COMMON_POSES.length})
              </button>
              <button
                type="button"
                className={leftTab === "library" ? "pose-tab is-active" : "pose-tab"}
                onClick={() => setLeftTab("library")}
              >
                {t("pose.left.library")}
              </button>
            </div>

            {leftTab === "common" ? (
              <div className="pose-panel__scroll">
                <div className="pose-thumb-grid">
                  {COMMON_POSES.map((spec) => {
                    const label = t(`pose.common.${spec.id}`);
                    return (
                      <button
                        key={spec.id}
                        type="button"
                        className="pose-thumb-card"
                        title={label}
                        onClick={() => engine?.applyCommonPose(spec)}
                      >
                        {COMMON_POSE_THUMBNAILS[spec.id] ? (
                          <img src={COMMON_POSE_THUMBNAILS[spec.id]} alt={label} loading="lazy" />
                        ) : null}
                        <span>{label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="pose-panel__scroll pose-library">
                <div className="pose-library__actions">
                  <Button size="small" appearance="primary" icon={<Save20Regular />} onClick={openSavePoseDialog}>
                    {t("pose.library.save")}
                  </Button>
                  <Button size="small" appearance="subtle" icon={<ImageAdd20Regular />} onClick={() => runAsync(handlePickOpenPoseImage())}>
                    {t("pose.library.import")}
                  </Button>
                </div>
                <div className="pose-library__tools">
                  <Tooltip content={t("pose.library.new_folder")} relationship="label">
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<FolderAdd20Regular />}
                      aria-label={t("pose.library.new_folder")}
                      onClick={() => setFolderDialogOpen(true)}
                    />
                  </Tooltip>
                  <Tooltip content={t("pose.library.refresh")} relationship="label">
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<ArrowSync20Regular />}
                      aria-label={t("pose.library.refresh")}
                      onClick={() => runAsync(refreshPosesLibrary())}
                    />
                  </Tooltip>
                  <Tooltip content={t("pose.library.open_dir")} relationship="label">
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<FolderOpen20Regular />}
                      aria-label={t("pose.library.open_dir")}
                      onClick={() => runAsync(platform.opener.openPath(posesRoot))}
                    />
                  </Tooltip>
                </div>

                <FluentSelect
                  value={selectedFolder}
                  options={folderOptions.map((opt) => ({
                    value: opt,
                    label: opt === "__all__" ? t("pose.library.all_folders") : `poses/${opt}`,
                  }))}
                  ariaLabel={t("pose.library.folder")}
                  onChange={setSelectedFolder}
                />

                <Input
                  size="small"
                  value={libraryFilter}
                  placeholder={t("pose.library.search")}
                  onChange={(_e, data) => setLibraryFilter(data.value)}
                />

                {filteredLibraryEntries.length === 0 ? (
                  <p className="pose-muted">{t("pose.library.empty")}</p>
                ) : (
                  <div className="pose-thumb-grid">
                    {filteredLibraryEntries.map((entry) => {
                      const thumbSrc =
                        entry.kind === "openpose_image"
                          ? platform.media.url(entry.path)
                          : jsonThumbs[entry.relativePath] ?? "";
                      return (
                        <div key={entry.relativePath} className="pose-thumb-card pose-thumb-card--lib">
                          <button
                            type="button"
                            className="pose-thumb-card__btn"
                            title={`${entry.folder ? `poses/${entry.folder}/` : "poses/"}${entry.name}`}
                            onClick={() => runAsync(handleOpenLibraryEntry(entry))}
                          >
                            {thumbSrc ? (
                              <img src={thumbSrc} alt={entry.name} loading="lazy" />
                            ) : (
                              <div className="pose-thumb-card__placeholder">
                                {entry.kind === "pose_json" ? "3D" : "IMG"}
                              </div>
                            )}
                            <span>{entry.name}</span>
                            <small className="pose-thumb-card__tag">
                              {entry.kind === "pose_json" ? "POSE" : "OP"}
                            </small>
                          </button>
                          <button
                            type="button"
                            className="pose-thumb-card__del"
                            title={t("pose.library.delete")}
                            onClick={() => runAsync(handleDeleteLibraryEntry(entry))}
                          >
                            ×
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </aside>
        ) : null}

        {/* 中央 3D 视口 */}
        <section className="pose-stage-wrap">
          {/* 顶部多角色胶囊切换栏（最多 26 人） */}
          <div className="pose-char-bar">
            <div className="pose-char-pills">
              {characters.map((char, idx) => (
                <button
                  key={char.id}
                  type="button"
                  className={idx === activeIndex ? "pose-char-pill is-active" : "pose-char-pill"}
                  onClick={() => engine?.switchCharacter(idx)}
                >
                  <span
                    className="pose-char-pill__dot"
                    style={{ backgroundColor: char.color.hex }}
                  />
                  <span>{char.label || `#${idx + 1}`}</span>
                </button>
              ))}
            </div>
            <div className="pose-char-bar__actions">
              <span className="pose-char-count">
                {characters.length}/{MAX_POSE_CHARACTERS}
              </span>
              <Tooltip content={t("pose.char.add")} relationship="label">
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<Add20Regular />}
                  disabled={!engine?.ready || characters.length >= MAX_POSE_CHARACTERS}
                  onClick={() => engine?.addCharacter(poseCfg.labelDefaults, false)}
                />
              </Tooltip>
              <Tooltip content={t("pose.char.duplicate")} relationship="label">
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<Copy20Regular />}
                  disabled={!engine?.ready || characters.length >= MAX_POSE_CHARACTERS}
                  onClick={() => engine?.addCharacter(poseCfg.labelDefaults, true)}
                />
              </Tooltip>
              <Tooltip content={t("pose.char.remove")} relationship="label">
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<Delete20Regular />}
                  disabled={!engine?.ready || characters.length <= 1}
                  onClick={() => engine?.removeCharacter(activeIndex)}
                />
              </Tooltip>
            </div>
          </div>

          {/* WebGL 画布舞台 */}
          <div className="pose-stage" ref={stageRef}>
            <canvas ref={canvasRef} className="pose-canvas" tabIndex={0} />

            <button
              type="button"
              className="pose-stage__snap"
              onClick={() => engine?.snapToCaptureCamera()}
            >
              {t("pose.snap_camera")}
            </button>

            <div className="pose-stage__hint">{t("pose.stage_hint")}</div>

            {/* 右下角实时导出预览小窗（可切换 4 种导出模态；点击或右键用灯箱放大/全屏预览） */}
            {!loading && !loadError ? (
              <div
                className="pose-preview-pip"
                onContextMenu={(event: ReactMouseEvent<HTMLDivElement>) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const x = Math.min(event.clientX, Math.max(8, window.innerWidth - 190));
                  const y = Math.min(event.clientY, Math.max(8, window.innerHeight - 100));
                  setPreviewMenu({ x, y });
                }}
              >
                <div className="pose-preview-pip__tabs">
                  {(["mannequin", "mannequinSkeleton", "openpose", "depth"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={previewMode === m ? "is-active" : ""}
                      onClick={() => setPreviewMode(m)}
                    >
                      {t(`pose.export.short_${m}`)}
                    </button>
                  ))}
                </div>
                {previewUrl ? (
                  <button
                    type="button"
                    className="pose-preview-pip__img-btn"
                    title={t("pose.preview.click_zoom")}
                    onClick={() => runAsync(openShotLightbox(false))}
                  >
                    <img src={previewUrl} alt="Export preview" draggable={false} />
                    <span className="pose-preview-pip__zoom-badge">
                      <Eye20Regular />
                    </span>
                  </button>
                ) : (
                  <div className="pose-preview-pip__empty">...</div>
                )}
              </div>
            ) : null}

            {previewMenu ? (
              <div
                className="pose-context-menu"
                style={{ left: previewMenu.x, top: previewMenu.y }}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <button type="button" onClick={() => runAsync(openShotLightbox(false))}>
                  {t("pose.preview.open_lightbox")}
                </button>
                {platform.isTauri && platform.previewWindow ? (
                  <button type="button" onClick={() => runAsync(openShotLightbox(true))}>
                    {t("pose.preview.open_fullscreen")}
                  </button>
                ) : null}
              </div>
            ) : null}

            {loading ? (
              <div className="pose-stage__overlay">
                <Spinner size="medium" label={t("pose.loading_body")} />
              </div>
            ) : null}

            {loadError ? (
              <div className="pose-stage__overlay pose-stage__overlay--error">
                <p>{loadError}</p>
              </div>
            ) : null}
          </div>
        </section>

        {/* 右侧属性面板（5 个子标签） */}
        {rightOpen ? (
          <aside className="pose-panel pose-panel--right">
            <div className="pose-tabs pose-tabs--compact">
              {(["character", "pose", "body", "scene", "export"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  className={rightTab === tab ? "pose-tab is-active" : "pose-tab"}
                  onClick={() => setRightTab(tab)}
                >
                  {t(`pose.right.${tab}`)}
                </button>
              ))}
            </div>

            <div className="pose-panel__scroll">
              {/* 1. 角色：颜色区分 + 标号区分 + 站位朝向 */}
              {rightTab === "character" && activeChar ? (
                <div className="pose-section-stack">
                  <section className="pose-card">
                    <div className="pose-card__head">
                      <h3>{t("pose.color.title")}</h3>
                      <span className="pose-color-badge">
                        <i style={{ backgroundColor: activeChar.color.hex }} />
                        {resolveColorPromptToken(activeChar.color)}
                      </span>
                    </div>
                    <FluentSelect
                      value={paletteName}
                      options={[...PALETTE_NAMES]}
                      ariaLabel={t("pose.color.palette")}
                      onChange={(val) => {
                        setPaletteName(val as BuiltinPaletteName);
                        setPaletteSearch("");
                      }}
                    />
                    {paletteName === "CSS_148_colors" ? (
                      <Input
                        size="small"
                        value={paletteSearch}
                        placeholder={t("pose.color.search")}
                        onChange={(_e, data) => setPaletteSearch(data.value)}
                      />
                    ) : null}
                    <div className="pose-swatch-grid">
                      {filteredPaletteColors.map((entry) => {
                        const selected =
                          activeChar.color.palette === paletteName &&
                          activeChar.color.name === entry.name;
                        return (
                          <button
                            key={`${paletteName}-${entry.name}`}
                            type="button"
                            className={selected ? "pose-swatch is-selected" : "pose-swatch"}
                            style={{ backgroundColor: entry.hex }}
                            title={`${entry.name} (${entry.hex})`}
                            onClick={() =>
                              engine?.setActiveColor(selectPaletteColor(paletteName, entry))
                            }
                          />
                        );
                      })}
                    </div>
                    <div className="pose-custom-color">
                      <input
                        type="color"
                        aria-label={t("pose.color.custom")}
                        value={normalizeHexColor(activeChar.color.hex)}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => {
                          const hex = normalizeHexColor(e.target.value);
                          setCustomHexInput(hex);
                          engine?.setActiveColor(createCustomColor(hex));
                        }}
                      />
                      <Input
                        size="small"
                        value={customHexInput}
                        onChange={(_e, data) => {
                          setCustomHexInput(data.value);
                          if (/^#?[0-9a-fA-F]{6}$/.test(data.value.trim())) {
                            engine?.setActiveColor(createCustomColor(data.value));
                          }
                        }}
                      />
                      <Button
                        size="small"
                        appearance="subtle"
                        onClick={() => {
                          const used = characters
                            .filter((_, idx) => idx !== activeIndex)
                            .map((c) => c.color.hex);
                          engine?.setActiveColor(autoAssignCharacterColor(used, activeIndex));
                        }}
                      >
                        {t("pose.color.auto")}
                      </Button>
                    </div>
                  </section>

                  <section className="pose-card">
                    <div className="pose-card__head">
                      <h3>{t("pose.label.title")}</h3>
                      <Button
                        size="small"
                        appearance="subtle"
                        onClick={() => {
                          const style = { ...activeChar.labelStyle };
                          engine?.setActiveLabelStyle(style, true);
                          updatePoseConfig((prev) => ({ ...prev, labelDefaults: style }));
                          notice("info", t("common.info"), t("pose.label.applied_all"));
                        }}
                      >
                        {t("pose.label.apply_all")}
                      </Button>
                    </div>
                    <div className="pose-row">
                      <label>{t("pose.label.content")}</label>
                      <Input
                        size="small"
                        value={activeChar.label}
                        maxLength={16}
                        onChange={(_e, data) => {
                          engine?.setActiveLabel(data.value);
                          const trimmed = data.value.trim();
                          if (trimmed) {
                            const lblRatio = Number(
                              cfg.get("pose_label_area_ratio", DEFAULT_CONFIG.pose_label_area_ratio),
                            );
                            const nextSize = computeFontSizeForAreaRatio(
                              poseCfgRef.current.exportWidth,
                              poseCfgRef.current.exportHeight,
                              lblRatio,
                              trimmed,
                            );
                            engine?.setActiveLabelStyle({ fontSize: nextSize });
                            setLabelSizeDraft(String(nextSize));
                          }
                        }}
                      />
                    </div>
                    <div className="pose-row">
                      <label>{t("pose.label.position")}</label>
                      <FluentSelect
                        value={activeChar.labelStyle.position}
                        options={(["above", "below", "forehead", "chest"] as const).map((opt) => ({
                          value: opt,
                          label: t(`pose.label.pos_${opt}`),
                        }))}
                        ariaLabel={t("pose.label.position")}
                        onChange={(pos) => {
                          const position = pos as PoseLabelPosition;
                          engine?.setActiveLabelStyle({ position });
                          updatePoseConfig((prev) => ({
                            ...prev,
                            labelDefaults: { ...prev.labelDefaults, position },
                          }));
                        }}
                      />
                    </div>
                    <div className="pose-row">
                      <label>{t("pose.label.font")}</label>
                      <FluentSelect
                        value={activeChar.labelStyle.fontFamily}
                        options={[...FONT_FAMILIES]}
                        ariaLabel={t("pose.label.font")}
                        onChange={(fontFamily) => {
                          engine?.setActiveLabelStyle({ fontFamily });
                          updatePoseConfig((prev) => ({
                            ...prev,
                            labelDefaults: { ...prev.labelDefaults, fontFamily },
                          }));
                        }}
                      />
                    </div>
                    <div className="pose-row">
                      <label>{t("pose.label.color")}</label>
                      <input
                        type="color"
                        value={activeChar.labelStyle.color}
                        onChange={(e) => {
                          const color = normalizeHexColor(e.target.value, "#E5252A");
                          engine?.setActiveLabelStyle({ color });
                          updatePoseConfig((prev) => ({
                            ...prev,
                            labelDefaults: { ...prev.labelDefaults, color },
                          }));
                        }}
                      />
                    </div>
                    <div className="pose-row">
                      <label>{t("pose.label.size")}</label>
                      <Input
                        size="small"
                        type="text"
                        inputMode="numeric"
                        placeholder="32"
                        value={labelSizeDraft}
                        onChange={(_e, d) => {
                          if (d.value === "" || /^\d+$/.test(d.value)) {
                            setLabelSizeDraft(d.value);
                          }
                        }}
                        onBlur={commitLabelSizeDraft}
                        onKeyDown={(e: ReactKeyboardEvent<HTMLInputElement>) => {
                          if (e.key === "Enter") {
                            e.currentTarget.blur();
                          }
                        }}
                      />
                    </div>
                    <div
                      className="pose-slider-row"
                      title={t("pose.slider_dblclick_reset")}
                      onDoubleClick={() => {
                        engine?.setActiveLabelStyle({ rotation: 0 });
                        updatePoseConfig((prev) => ({
                          ...prev,
                          labelDefaults: { ...prev.labelDefaults, rotation: 0 },
                        }));
                      }}
                    >
                      <div className="pose-slider-row__head">
                        <span>{t("pose.label.rotation")}</span>
                        <b>{activeChar.labelStyle.rotation}°</b>
                      </div>
                      <Slider
                        size="small"
                        min={-180}
                        max={180}
                        step={1}
                        value={activeChar.labelStyle.rotation}
                        onChange={(_e, d) => {
                          engine?.setActiveLabelStyle({ rotation: d.value });
                          updatePoseConfig((prev) => ({
                            ...prev,
                            labelDefaults: { ...prev.labelDefaults, rotation: d.value },
                          }));
                        }}
                      />
                    </div>
                  </section>

                  <section className="pose-card">
                    <div className="pose-card__head">
                      <h3>{t("pose.transform.title")}</h3>
                      <Button
                        size="small"
                        appearance="subtle"
                        onClick={() => engine?.fitActiveCharacterToFrame(0.1)}
                      >
                        {t("pose.transform.fit_camera")}
                      </Button>
                    </div>
                    <div
                      className="pose-slider-row"
                      title={t("pose.slider_dblclick_reset")}
                      onDoubleClick={() => engine?.setActiveTurn(0)}
                    >
                      <div className="pose-slider-row__head">
                        <span>{t("pose.transform.turn")}</span>
                        <b>{engine?.getActiveTurn() ?? 0}°</b>
                      </div>
                      <Slider
                        size="small"
                        min={-180}
                        max={180}
                        step={1}
                        value={engine?.getActiveTurn() ?? 0}
                        onChange={(_e, d) => engine?.setActiveTurn(d.value)}
                      />
                      <div className="pose-chip-row">
                        {[0, 45, 90, 180, -90, -45].map((deg) => (
                          <button
                            key={deg}
                            type="button"
                            className="pose-chip"
                            onClick={() => engine?.setActiveTurn(deg)}
                          >
                            {deg}°
                          </button>
                        ))}
                      </div>
                    </div>
                    {(
                      [
                        ["zoom", "pose.transform.scale", 0.2, 4, 0.05, 1],
                        ["x", "pose.transform.x", -15, 15, 0.05, 0],
                        ["y", "pose.transform.y", -15, 15, 0.05, 0],
                        ["z", "pose.transform.z", -15, 15, 0.05, 0],
                      ] as const
                    ).map(([key, labelKey, min, max, step, defVal]) => (
                      <div
                        key={key}
                        className="pose-slider-row"
                        title={t("pose.slider_dblclick_reset")}
                        onDoubleClick={() => engine?.setActiveTransform({ [key]: defVal })}
                      >
                        <div className="pose-slider-row__head">
                          <span>{t(labelKey)}</span>
                          <b>{activeChar.transform[key].toFixed(2)}</b>
                        </div>
                        <Slider
                          size="small"
                          min={min}
                          max={max}
                          step={step}
                          value={activeChar.transform[key]}
                          onChange={(_e, d) => engine?.setActiveTransform({ [key]: d.value })}
                        />
                      </div>
                    ))}
                  </section>
                </div>
              ) : null}

              {/* 2. 关节与手势 */}
              {rightTab === "pose" && activeChar ? (
                <div className="pose-section-stack">
                  <section className="pose-card">
                    <div className="pose-card__head">
                      <h3>{t("pose.bone.title")}</h3>
                      <span className="pose-muted">{selectedBone ?? t("pose.bone.none")}</span>
                    </div>
                    {(["x", "y", "z"] as const).map((axis) => (
                      <div
                        key={axis}
                        className="pose-slider-row"
                        title={t("pose.slider_dblclick_reset")}
                        onDoubleClick={() => {
                          if (boneRot) engine?.setBoneRotation(axis, 0);
                        }}
                      >
                        <div className="pose-slider-row__head">
                          <span>{axis.toUpperCase()}</span>
                          <b>{boneRot ? `${boneRot[axis]}°` : "—"}</b>
                        </div>
                        <Slider
                          size="small"
                          min={-180}
                          max={180}
                          step={1}
                          disabled={!boneRot}
                          value={boneRot ? boneRot[axis] : 0}
                          onChange={(_e, d) => engine?.setBoneRotation(axis, d.value)}
                        />
                      </div>
                    ))}
                    <div className="pose-btn-row">
                      <Button
                        size="small"
                        appearance="subtle"
                        disabled={!boneRot}
                        onClick={() => engine?.resetSelectedBone()}
                      >
                        {t("pose.bone.reset_one")}
                      </Button>
                      <Button
                        size="small"
                        appearance="subtle"
                        onClick={() => engine?.resetActivePose()}
                      >
                        {t("pose.reset_pose")}
                      </Button>
                    </div>
                  </section>

                  <section className="pose-card">
                    <div className="pose-card__head">
                      <h3>{t("pose.hands.title")}</h3>
                    </div>
                    {(["l", "r"] as const).map((side) => (
                      <div
                        key={side}
                        className="pose-hand-block"
                        title={t("pose.slider_dblclick_reset")}
                        onDoubleClick={() => engine?.setHandGrip(side, 0)}
                      >
                        <div className="pose-slider-row__head">
                          <span>{t(side === "l" ? "pose.hands.left" : "pose.hands.right")}</span>
                          <b>{activeChar.grips[side].toFixed(2)}</b>
                        </div>
                        <div className="pose-chip-row">
                          {(["OPEN", "CHOP", "FIST"] as const).map((preset) => (
                            <button
                              key={preset}
                              type="button"
                              className="pose-chip"
                              onClick={() => engine?.applyHandPreset(side, preset)}
                            >
                              {t(`pose.hands.${preset.toLowerCase()}`)}
                            </button>
                          ))}
                        </div>
                        <Slider
                          size="small"
                          min={0}
                          max={1}
                          step={0.01}
                          value={activeChar.grips[side]}
                          onChange={(_e, d) => engine?.setHandGrip(side, d.value)}
                        />
                      </div>
                    ))}
                  </section>

                  {activeOpenpose ? (
                    <section className="pose-card">
                      <div className="pose-card__head">
                        <h3>{t("pose.flip.title")}</h3>
                      </div>
                      <div className="pose-chip-row">
                        <button
                          type="button"
                          className={
                            activeOpenpose.depthMode === "planar" ? "pose-chip is-active" : "pose-chip"
                          }
                          onClick={() => engine?.setOpenPoseDepthMode("planar")}
                        >
                          {t("pose.flip.planar")}
                        </button>
                        <button
                          type="button"
                          className={
                            activeOpenpose.depthMode !== "planar" ? "pose-chip is-active" : "pose-chip"
                          }
                          onClick={() => engine?.setOpenPoseDepthMode("estimate")}
                        >
                          {t("pose.flip.estimate")}
                        </button>
                      </div>
                      <div className="pose-chip-row">
                        {DEPTH_FLIP_GROUPS.map((g) => (
                          <button
                            key={g.key}
                            type="button"
                            className={
                              activeOpenpose.flips?.[g.key] ? "pose-chip is-active" : "pose-chip"
                            }
                            onClick={() => engine?.toggleOpenPoseFlip(g.key)}
                          >
                            {t(g.labelKey)}
                          </button>
                        ))}
                      </div>
                    </section>
                  ) : null}
                </div>
              ) : null}

              {/* 3. 体型与比例 */}
              {rightTab === "body" && activeChar ? (
                <div className="pose-section-stack">
                  <section className="pose-card">
                    <div className="pose-card__head">
                      <h3>{t("pose.body.title")}</h3>
                      <Button
                        size="small"
                        appearance="subtle"
                        onClick={() => engine?.resetActiveMesh()}
                      >
                        {t("pose.reset")}
                      </Button>
                    </div>
                    {BODY_SLIDER_DEFS.map((def) => (
                      <div
                        key={def.key}
                        className="pose-slider-row"
                        title={t("pose.slider_dblclick_reset")}
                        onDoubleClick={() => engine?.setActiveMesh({ [def.key]: def.defaultValue })}
                      >
                        <div className="pose-slider-row__head">
                          <span>{t(def.labelKey)}</span>
                          <b>
                            {def.key === "age"
                              ? Math.round(activeChar.mesh[def.key])
                              : activeChar.mesh[def.key].toFixed(2)}
                          </b>
                        </div>
                        <Slider
                          size="small"
                          min={def.min}
                          max={def.max}
                          step={def.step}
                          value={activeChar.mesh[def.key]}
                          onChange={(_e, d) => engine?.setActiveMesh({ [def.key]: d.value })}
                        />
                      </div>
                    ))}
                  </section>

                  <section className="pose-card">
                    <div className="pose-card__head">
                      <h3>{t("pose.prop.title")}</h3>
                      <Button
                        size="small"
                        appearance="subtle"
                        onClick={() => engine?.resetActiveProportions()}
                      >
                        {t("pose.reset")}
                      </Button>
                    </div>
                    <div className="pose-chip-row">
                      {HEAD_RATIO_PRESETS.map((preset) => {
                        const isMatch =
                          Math.abs(activeChar.proportions.head - preset.proportions.head) < 0.03 &&
                          Math.abs(activeChar.proportions.thigh - preset.proportions.thigh) < 0.03 &&
                          Math.abs(activeChar.mesh.age - (preset.meshPatch.age ?? 25)) < 2;
                        return (
                          <button
                            key={preset.id}
                            type="button"
                            className={isMatch ? "pose-chip is-active" : "pose-chip"}
                            onClick={() =>
                              engine?.applyProportionsPreset(preset.proportions, preset.meshPatch)
                            }
                          >
                            {t(preset.labelKey)}
                          </button>
                        );
                      })}
                    </div>
                    {PROPORTION_SLIDER_DEFS.map((def) => (
                      <div
                        key={def.key}
                        className="pose-slider-row"
                        title={t("pose.slider_dblclick_reset")}
                        onDoubleClick={() => engine?.setActiveProportion(def.key, 1)}
                      >
                        <div className="pose-slider-row__head">
                          <span>{t(def.labelKey)}</span>
                          <b>{Math.round(activeChar.proportions[def.key] * 100)}%</b>
                        </div>
                        <Slider
                          size="small"
                          min={def.min}
                          max={def.max}
                          step={0.01}
                          value={activeChar.proportions[def.key]}
                          onChange={(_e, d) => engine?.setActiveProportion(def.key, d.value)}
                        />
                      </div>
                    ))}
                  </section>
                </div>
              ) : null}

              {/* 4. 镜头、立体光照（自动保存）与参考图叠加 */}
              {rightTab === "scene" && engine ? (
                <div className="pose-section-stack">
                  <section className="pose-card">
                    <div className="pose-card__head">
                      <h3>{t("pose.camera.title")}</h3>
                      <Button size="small" appearance="subtle" onClick={() => engine.resetCamera()}>
                        {t("pose.reset")}
                      </Button>
                    </div>
                    <div
                      className="pose-slider-row"
                      title={t("pose.slider_dblclick_reset")}
                      onDoubleClick={() => engine.setCamera({ yaw: 0 }, true)}
                    >
                      <div className="pose-slider-row__head">
                        <span>{t("pose.camera.yaw")}</span>
                        <b>{engine.camera.yaw}°</b>
                      </div>
                      <Slider
                        size="small"
                        min={-180}
                        max={180}
                        step={1}
                        value={engine.camera.yaw}
                        onChange={(_e, d) => engine.setCamera({ yaw: d.value }, true)}
                      />
                      <div className="pose-chip-row">
                        {[-90, -45, 0, 45, 90, 180].map((deg) => (
                          <button
                            key={deg}
                            type="button"
                            className="pose-chip"
                            onClick={() => engine.setCamera({ yaw: deg }, true)}
                          >
                            {deg}°
                          </button>
                        ))}
                      </div>
                    </div>
                    <div
                      className="pose-slider-row"
                      title={t("pose.slider_dblclick_reset")}
                      onDoubleClick={() => engine.setCamera({ pitch: 0 }, true)}
                    >
                      <div className="pose-slider-row__head">
                        <span>{t("pose.camera.pitch")}</span>
                        <b>{engine.camera.pitch}°</b>
                      </div>
                      <Slider
                        size="small"
                        min={-60}
                        max={60}
                        step={1}
                        value={engine.camera.pitch}
                        onChange={(_e, d) => engine.setCamera({ pitch: d.value }, true)}
                      />
                    </div>
                    <div
                      className="pose-slider-row"
                      title={t("pose.slider_dblclick_reset")}
                      onDoubleClick={() => engine.setCamera({ zoom: 1 }, true)}
                    >
                      <div className="pose-slider-row__head">
                        <span>{t("pose.camera.zoom")}</span>
                        <b>{engine.camera.zoom.toFixed(2)}×</b>
                      </div>
                      <Slider
                        size="small"
                        min={0.12}
                        max={6}
                        step={0.02}
                        value={engine.camera.zoom}
                        onChange={(_e, d) => engine.setCamera({ zoom: d.value }, true)}
                      />
                    </div>
                    <Button size="small" appearance="subtle" onClick={() => engine.useOrbitViewAsCamera()}>
                      {t("pose.camera.from_view")}
                    </Button>
                  </section>

                  <section className="pose-card">
                    <div className="pose-card__head">
                      <h3>{t("pose.light.title")}</h3>
                      <span className="pose-muted">{t("pose.auto_saved")}</span>
                    </div>
                    <div className="pose-chip-row">
                      {(["studio", "soft_front", "dramatic_side", "flat"] as const).map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          className={
                            poseCfg.lighting.preset === preset ? "pose-chip is-active" : "pose-chip"
                          }
                          onClick={() => handleLightPreset(preset)}
                        >
                          {t(`pose.light.preset_${preset}`)}
                        </button>
                      ))}
                    </div>
                    {(
                      [
                        ["ambientIntensity", "pose.light.ambient", 0.05, 1.5, 0.02, POSE_LIGHTING_PRESETS.studio.ambientIntensity],
                        ["keyIntensity", "pose.light.key", 0, 2.5, 0.05, POSE_LIGHTING_PRESETS.studio.keyIntensity],
                        ["keyAzimuth", "pose.light.azimuth", -180, 180, 1, POSE_LIGHTING_PRESETS.studio.keyAzimuth],
                        ["keyElevation", "pose.light.elevation", -45, 85, 1, POSE_LIGHTING_PRESETS.studio.keyElevation],
                        ["fillIntensity", "pose.light.fill", 0, 2.0, 0.05, POSE_LIGHTING_PRESETS.studio.fillIntensity],
                        ["rimIntensity", "pose.light.rim", 0, 2.0, 0.05, POSE_LIGHTING_PRESETS.studio.rimIntensity],
                        ["rimDarken", "pose.light.rim_darken", 0, 0.65, 0.02, POSE_LIGHTING_PRESETS.studio.rimDarken],
                      ] as const
                    ).map(([key, labelKey, min, max, step, defVal]) => (
                      <div
                        key={key}
                        className="pose-slider-row"
                        title={t("pose.slider_dblclick_reset")}
                        onDoubleClick={() => patchLightField(key, defVal)}
                      >
                        <div className="pose-slider-row__head">
                          <span>{t(labelKey)}</span>
                          <b>
                            {key === "keyAzimuth" || key === "keyElevation"
                              ? `${Math.round(poseCfg.lighting[key])}°`
                              : poseCfg.lighting[key].toFixed(2)}
                          </b>
                        </div>
                        <Slider
                          size="small"
                          min={min}
                          max={max}
                          step={step}
                          value={poseCfg.lighting[key]}
                          onChange={(_e, d) => patchLightField(key, d.value)}
                        />
                      </div>
                    ))}
                    <div className="pose-row">
                      <label>{t("pose.light.background")}</label>
                      <input
                        type="color"
                        value={poseCfg.lighting.background}
                        onChange={(e) =>
                          patchLightField("background", normalizeHexColor(e.target.value, "#FFFFFF"))
                        }
                      />
                    </div>
                    <Checkbox
                      label={t("pose.light.show_skydome")}
                      checked={poseCfg.lighting.showSkydome}
                      onChange={(_e, data) => patchLightField("showSkydome", data.checked === true)}
                    />
                  </section>

                  <section className="pose-card">
                    <div className="pose-card__head">
                      <h3>{t("pose.scene.overlay_title")}</h3>
                    </div>
                    <div className="pose-btn-row">
                      <Button size="small" appearance="subtle" onClick={() => runAsync(handlePickOverlayImage())}>
                        {t("pose.scene.overlay_pick")}
                      </Button>
                      {overlayUrl ? (
                        <Button size="small" appearance="subtle" onClick={() => runAsync(clearOverlayImage())}>
                          {t("pose.scene.overlay_clear")}
                        </Button>
                      ) : null}
                    </div>
                    {overlayUrl ? (
                      <div
                        className="pose-slider-row"
                        title={t("pose.slider_dblclick_reset")}
                        onDoubleClick={() => {
                          setOverlayOpacity(0.4);
                          engine.setReferenceOverlayOpacity(0.4);
                        }}
                      >
                        <div className="pose-slider-row__head">
                          <span>{t("pose.scene.overlay_opacity")}</span>
                          <b>{Math.round(overlayOpacity * 100)}%</b>
                        </div>
                        <Slider
                          size="small"
                          min={0.05}
                          max={0.9}
                          step={0.05}
                          value={overlayOpacity}
                          onChange={(_e, d) => {
                            setOverlayOpacity(d.value);
                            engine.setReferenceOverlayOpacity(d.value);
                          }}
                        />
                      </div>
                    ) : null}
                  </section>
                </div>
              ) : null}

              {/* 5. 导出分辨率、4 模态多选、四角水印与预制提示词锚定块 */}
              {rightTab === "export" ? (
                <div className="pose-section-stack">
                  <section className="pose-card">
                    <div className="pose-card__head">
                      <h3>{t("pose.export.resolution")}</h3>
                      <span className="pose-muted">1920×1080 base</span>
                    </div>
                    <div className="pose-chip-row">
                      {POSE_ASPECT_PRESETS.map((preset) => {
                        const [pw, ph] = sizeForAspectInBounds(preset.ratio);
                        const isActive =
                          poseCfg.exportWidth === pw && poseCfg.exportHeight === ph;
                        return (
                          <button
                            key={preset.label}
                            type="button"
                            className={isActive ? "pose-chip is-active" : "pose-chip"}
                            title={`${pw}×${ph}`}
                            onClick={() => applyExportSize(pw, ph)}
                          >
                            {preset.label}
                          </button>
                        );
                      })}
                    </div>
                    <div className="pose-dim-inputs">
                      <label>
                        <span>W</span>
                        <Input
                          size="small"
                          type="text"
                          inputMode="numeric"
                          value={widthDraft}
                          onChange={(_e, d) => {
                            if (d.value === "" || /^\d+$/.test(d.value)) {
                              setWidthDraft(d.value);
                            }
                          }}
                          onBlur={commitExportSizeDraft}
                          onKeyDown={(e: ReactKeyboardEvent<HTMLInputElement>) => {
                            if (e.key === "Enter") {
                              commitExportSizeDraft();
                            }
                          }}
                        />
                      </label>
                      <label>
                        <span>H</span>
                        <Input
                          size="small"
                          type="text"
                          inputMode="numeric"
                          value={heightDraft}
                          onChange={(_e, d) => {
                            if (d.value === "" || /^\d+$/.test(d.value)) {
                              setHeightDraft(d.value);
                            }
                          }}
                          onBlur={commitExportSizeDraft}
                          onKeyDown={(e: ReactKeyboardEvent<HTMLInputElement>) => {
                            if (e.key === "Enter") {
                              commitExportSizeDraft();
                            }
                          }}
                        />
                      </label>
                      <Button
                        size="small"
                        appearance="subtle"
                        className="pose-dim-apply"
                        onClick={commitExportSizeDraft}
                      >
                        {t("pose.export.apply")}
                      </Button>
                    </div>
                  </section>

                  <section className="pose-card">
                    <div className="pose-card__head">
                      <h3>{t("pose.export.modes_title")}</h3>
                    </div>
                    {(
                      ["mannequin", "mannequinSkeleton", "openpose", "depth"] as const
                    ).map((modeKey) => (
                      <Checkbox
                        key={modeKey}
                        label={t(`pose.export.mode_${modeKey}`)}
                        checked={poseCfg.exportModes[modeKey]}
                        onChange={(_e, data) =>
                          updatePoseConfig((prev) => ({
                            ...prev,
                            exportModes: {
                              ...prev.exportModes,
                              [modeKey]: data.checked === true,
                            },
                          }))
                        }
                      />
                    ))}
                    <Checkbox
                      label={t("pose.export.corner_watermark")}
                      checked={poseCfg.cornerWatermark}
                      onChange={(_e, data) =>
                        updatePoseConfig((prev) => ({
                          ...prev,
                          cornerWatermark: data.checked === true,
                        }))
                      }
                    />
                    {poseCfg.cornerWatermark ? (
                      <div className="pose-watermark-opts">
                        <div className="pose-row">
                          <label>{t("pose.export.watermark_font")}</label>
                          <FluentSelect
                            value={poseCfg.watermarkStyle.fontFamily}
                            options={[...FONT_FAMILIES]}
                            ariaLabel={t("pose.export.watermark_font")}
                            onChange={(fontFamily) =>
                              updatePoseConfig((prev) => ({
                                ...prev,
                                watermarkStyle: { ...prev.watermarkStyle, fontFamily },
                              }))
                            }
                          />
                        </div>
                        <div className="pose-row">
                          <label>{t("pose.export.watermark_size")}</label>
                          <Input
                            size="small"
                            type="text"
                            inputMode="numeric"
                            placeholder="72"
                            value={watermarkSizeDraft}
                            onChange={(_e, d) => {
                              if (d.value === "" || /^\d+$/.test(d.value)) {
                                setWatermarkSizeDraft(d.value);
                              }
                            }}
                            onBlur={commitWatermarkSizeDraft}
                            onKeyDown={(e: ReactKeyboardEvent<HTMLInputElement>) => {
                              if (e.key === "Enter") {
                                e.currentTarget.blur();
                              }
                            }}
                          />
                        </div>
                      </div>
                    ) : null}
                  </section>

                  <section className="pose-card">
                    <div className="pose-card__head">
                      <h3>{t("pose.prompt.title")}</h3>
                      <Button
                        size="small"
                        appearance="subtle"
                        disabled={!promptResult.text}
                        onClick={() => {
                          if (!promptResult.text) return;
                          void navigator.clipboard?.writeText(promptResult.text);
                          notice("success", t("common.success"), t("pose.prompt.copied"));
                        }}
                      >
                        {t("pose.prompt.copy")}
                      </Button>
                    </div>
                    <Checkbox
                      label={t("pose.prompt.enable")}
                      checked={poseCfg.promptAnchor.enabled}
                      onChange={(_e, data) =>
                        updatePoseConfig((prev) => ({
                          ...prev,
                          promptAnchor: { ...prev.promptAnchor, enabled: data.checked === true },
                        }))
                      }
                    />
                    {poseCfg.promptAnchor.enabled ? (
                      <>
                        <div className="pose-prompt-checks">
                          <Checkbox
                            label={t("pose.prompt.use_color")}
                            checked={poseCfg.promptAnchor.useColor}
                            onChange={(_e, data) =>
                              updatePoseConfig((prev) => ({
                                ...prev,
                                promptAnchor: {
                                  ...prev.promptAnchor,
                                  useColor: data.checked === true,
                                },
                              }))
                            }
                          />
                          <Checkbox
                            label={t("pose.prompt.use_label")}
                            checked={poseCfg.promptAnchor.useLabel}
                            onChange={(_e, data) =>
                              updatePoseConfig((prev) => ({
                                ...prev,
                                promptAnchor: {
                                  ...prev.promptAnchor,
                                  useLabel: data.checked === true,
                                },
                              }))
                            }
                          />
                          <Checkbox
                            label={t("pose.prompt.use_position")}
                            checked={poseCfg.promptAnchor.usePosition}
                            onChange={(_e, data) =>
                              updatePoseConfig((prev) => ({
                                ...prev,
                                promptAnchor: {
                                  ...prev.promptAnchor,
                                  usePosition: data.checked === true,
                                },
                              }))
                            }
                          />
                        </div>

                        {poseCfg.promptAnchor.usePosition && characters.length >= 3 ? (
                          <div className="pose-row">
                            <label>{t("pose.prompt.strategy")}</label>
                            <FluentSelect
                              value={poseCfg.promptAnchor.positionStrategy}
                              options={(["rank_depth", "grid9"] as const).map((opt) => ({
                                value: opt,
                                label: t(`pose.prompt.strategy_${opt}`),
                              }))}
                              ariaLabel={t("pose.prompt.strategy")}
                              onChange={(val) =>
                                updatePoseConfig((prev) => ({
                                  ...prev,
                                  promptAnchor: {
                                    ...prev.promptAnchor,
                                    positionStrategy: val === "grid9" ? "grid9" : "rank_depth",
                                  },
                                }))
                              }
                            />
                          </div>
                        ) : null}

                        {promptResult.warnings.map((warn) => (
                          <div key={warn} className="pose-warning-banner">
                            {t(`pose.prompt.warn_${warn}`)}
                          </div>
                        ))}

                        <pre className="pose-prompt-preview" style={promptPreviewStyle}>
                          {promptResult.text}
                        </pre>
                      </>
                    ) : null}
                  </section>
                </div>
              ) : null}
            </div>
          </aside>
        ) : null}
      </div>

      {/* 保存当前姿势弹窗 */}
      <Dialog
        open={saveDialogOpen}
        onOpenChange={(_e, data) => {
          if (!data.open) setSaveDialogOpen(false);
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t("pose.library.save")}</DialogTitle>
            <DialogContent className="pose-dialog-content">
              <label>
                <span>{t("pose.library.save_name")}</span>
                <Input
                  value={saveName}
                  onChange={(_e, d) => setSaveName(d.value)}
                />
              </label>
              <label>
                <span>{t("pose.library.save_folder")}</span>
                <Input
                  value={saveFolder}
                  placeholder="saved / My Category"
                  onChange={(_e, d) => setSaveFolder(d.value)}
                />
              </label>
              <Checkbox
                label={t("pose.library.save_include_shape")}
                checked={saveIncludeShape}
                onChange={(_e, d) => setSaveIncludeShape(d.checked === true)}
              />
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setSaveDialogOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button appearance="primary" onClick={() => runAsync(confirmSavePose())}>
                {t("common.ok")}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* 新建姿势子目录弹窗 */}
      <Dialog
        open={folderDialogOpen}
        onOpenChange={(_e, data) => {
          if (!data.open) setFolderDialogOpen(false);
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t("pose.library.new_folder")}</DialogTitle>
            <DialogContent className="pose-dialog-content">
              <label>
                <span>{t("pose.library.new_folder_hint")}</span>
                <Input
                  value={newFolderPath}
                  placeholder="presets/Action Poses"
                  onChange={(_e, d) => setNewFolderPath(d.value)}
                />
              </label>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setFolderDialogOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button appearance="primary" onClick={() => runAsync(confirmCreateFolder())}>
                {t("common.ok")}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
