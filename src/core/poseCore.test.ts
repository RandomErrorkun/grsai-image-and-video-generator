import { describe, expect, it } from "vitest";
import {
  AUTO_CHARACTER_COLOR_SEQUENCE,
  MAX_POSE_CHARACTERS,
  POSE_PALETTES,
  autoAssignCharacterColor,
  createCustomColor,
  defaultCharacterLabel,
  nextAvailableCharacterLabel,
  resolveColorPromptToken,
  selectPaletteColor,
} from "./posePalettes";
import {
  DEFAULT_POSE_CONFIG,
  buildPoseLights,
  clampOpenUnitRatio,
  computeFontSizeForAreaRatio,
  normalizePoseConfig,
  sizeForAspectInBounds,
} from "./poseConfig";
import {
  buildPosePromptAnchor,
  computeCharacterPositions,
  upsertPoseAnchorInPrompt,
  type ProjectedPoseCharacter,
} from "./posePrompt";
import {
  BUILTIN_POSE_DIRS,
  parsePoseProjectJson,
  sanitizePoseFolderPath,
  sanitizePoseSegment,
} from "./poseStorage";

describe("posePalettes", () => {
  it("exposes all 5 palettes from color_scheme.json with expected sizes", () => {
    expect(POSE_PALETTES.Tableau10).toHaveLength(10);
    expect(POSE_PALETTES.Tableau20).toHaveLength(20);
    expect(POSE_PALETTES.Rainbow_type1).toHaveLength(7);
    expect(POSE_PALETTES.Rainbow_type2).toHaveLength(7);
    expect(POSE_PALETTES.CSS_148_colors.length).toBeGreaterThanOrEqual(147);
  });

  it("assigns 26 character colors in exact Tableau20 dark -> light -> Rainbow_type2 order", () => {
    expect(MAX_POSE_CHARACTERS).toBe(26);
    expect(AUTO_CHARACTER_COLOR_SEQUENCE).toHaveLength(26);
    expect(AUTO_CHARACTER_COLOR_SEQUENCE[0]).toEqual({ hex: "#4E79A7", palette: "Tableau20", name: "blue" });
    expect(AUTO_CHARACTER_COLOR_SEQUENCE[9]).toEqual({ hex: "#9D7660", palette: "Tableau20", name: "brown" });
    expect(AUTO_CHARACTER_COLOR_SEQUENCE[10]).toEqual({ hex: "#A0CBE8", palette: "Tableau20", name: "lightblue" });
    expect(AUTO_CHARACTER_COLOR_SEQUENCE[19]).toEqual({ hex: "#D7B5A6", palette: "Tableau20", name: "lightbrown" });
    expect(AUTO_CHARACTER_COLOR_SEQUENCE[20]).toEqual({ hex: "#FF0000", palette: "Rainbow_type2", name: "purered" });
    expect(AUTO_CHARACTER_COLOR_SEQUENCE[25]).toEqual({ hex: "#0000FF", palette: "Rainbow_type2", name: "pureblue" });

    const assigned: string[] = [];
    for (let i = 0; i < 26; i += 1) {
      const next = autoAssignCharacterColor(assigned, i);
      expect(next.hex).toBe(AUTO_CHARACTER_COLOR_SEQUENCE[i].hex);
      assigned.push(next.hex);
    }
  });

  it("resolves palette names vs custom HEX tokens and A-Z labels", () => {
    expect(resolveColorPromptToken(selectPaletteColor("Tableau20", POSE_PALETTES.Tableau20[0]))).toBe("blue");
    expect(resolveColorPromptToken(createCustomColor("#abcdef"))).toBe("#ABCDEF");
    expect(defaultCharacterLabel(0)).toBe("A");
    expect(defaultCharacterLabel(25)).toBe("Z");
    expect(nextAvailableCharacterLabel(["A", "B", "D"])).toBe("C");
  });
});

describe("poseConfig", () => {
  it("crops aspect ratios down from 1920x1080 bounds", () => {
    expect(sizeForAspectInBounds(16 / 9)).toEqual([1920, 1080]);
    expect(sizeForAspectInBounds(4 / 3)).toEqual([1440, 1080]);
    expect(sizeForAspectInBounds(1)).toEqual([1080, 1080]);
    expect(sizeForAspectInBounds(3 / 4)).toEqual([810, 1080]);
    expect(sizeForAspectInBounds(9 / 16)).toEqual([608, 1080]);
    expect(sizeForAspectInBounds(21 / 9)).toEqual([1920, 822]);
  });

  it("builds 3-point studio lighting and safely normalizes dirty config", () => {
    const lights = buildPoseLights(DEFAULT_POSE_CONFIG.lighting);
    expect(lights.length).toBe(4);
    expect(lights[0].type).toBe("ambient");
    expect(lights[1].type).toBe("directional");

    const normalized = normalizePoseConfig({
      exportWidth: 99999,
      lighting: { preset: "bad" },
      labelDefaults: { fontSize: 6000 },
      watermarkStyle: { fontSize: 0 },
    });
    expect(normalized.exportWidth).toBe(4096);
    expect(normalized.lighting.preset).toBe("studio");
    expect(normalized.lighting.showSkydome).toBe(false);
    expect(normalized.lighting.background).toBe("#FFFFFF");
    expect(normalized.labelDefaults.fontSize).toBe(5000);
    expect(normalized.watermarkStyle.fontSize).toBe(1);
    expect(DEFAULT_POSE_CONFIG.labelDefaults.fontSize).toBe(32);
    expect(DEFAULT_POSE_CONFIG.watermarkStyle.fontSize).toBe(72);
  });

  it("clamps open-unit area ratios to (0, 1) with 4 decimals and auto-scales font sizes", () => {
    expect(clampOpenUnitRatio(0.02, 0.02)).toBe(0.02);
    expect(clampOpenUnitRatio(0.01234, 0.01)).toBe(0.0123);
    expect(clampOpenUnitRatio(0, 0.02)).toBe(0.0001);
    expect(clampOpenUnitRatio(-0.5, 0.02)).toBe(0.0001);
    expect(clampOpenUnitRatio(1, 0.02)).toBe(0.9999);
    expect(clampOpenUnitRatio(1.5, 0.02)).toBe(0.9999);
    expect(clampOpenUnitRatio(Number.NaN, 0.02)).toBe(0.02);

    const wm1080 = computeFontSizeForAreaRatio(1920, 1080, 0.02, "姿势参考");
    const wm4k = computeFontSizeForAreaRatio(3840, 2160, 0.02, "姿势参考");
    expect(wm1080).toBeGreaterThanOrEqual(70);
    expect(wm1080).toBeLessThanOrEqual(120);
    expect(wm4k).toBeCloseTo(wm1080 * 2, -1);

    const lbl1080 = computeFontSizeForAreaRatio(1920, 1080, 0.003, "A");
    const lblMulti = computeFontSizeForAreaRatio(1920, 1080, 0.003, "ABCD");
    const lblCjk = computeFontSizeForAreaRatio(1920, 1080, 0.003, "主角人物A");
    const lblSmall = computeFontSizeForAreaRatio(608, 1080, 0.003, "A");
    expect(lbl1080).toBeGreaterThan(lblSmall);
    expect(lbl1080).toBeGreaterThan(lblMulti);
    expect(lblMulti).toBeGreaterThan(lblCjk);
    // 4 个半角字符字号约为单字符的 1/2，使总占位面积保持近似恒定
    expect(lblMulti).toBeCloseTo(lbl1080 / 2, -1);
  });
});

describe("posePrompt", () => {
  const fourChars: ProjectedPoseCharacter[] = [
    {
      id: "1",
      label: "A",
      color: { hex: "#4E79A7", palette: "Tableau20", name: "blue" },
      screenX: 0.15,
      screenY: 0.5,
      depth: 5.0,
    },
    {
      id: "2",
      label: "B",
      color: { hex: "#F28E2B", palette: "Tableau20", name: "orange" },
      screenX: 0.38,
      screenY: 0.5,
      depth: 5.0,
    },
    {
      id: "3",
      label: "C",
      color: { hex: "#59A14F", palette: "Tableau20", name: "green" },
      screenX: 0.62,
      screenY: 0.5,
      depth: 5.0,
    },
    {
      id: "4",
      label: "EX",
      color: createCustomColor("#ABCDEF"),
      screenX: 0.85,
      screenY: 0.5,
      depth: 5.0,
    },
  ];

  it("generates Chinese and English Markdown anchor blocks with palette names and custom HEX", () => {
    const zh = buildPosePromptAnchor({
      characters: fourChars,
      language: "zh",
      exportModes: DEFAULT_POSE_CONFIG.exportModes,
      anchor: DEFAULT_POSE_CONFIG.promptAnchor,
    });
    expect(zh.warnings).toEqual([]);
    expect(zh.text).toContain("# 动作参考\n姿势参考图中：");
    expect(zh.text).toContain("- 在 从左数第 1 位 的blue 的编号为 A 的3D人偶为角色【】");
    expect(zh.text).toContain("- 在 从左数第 4 位 的#ABCDEF 的编号为 EX 的3D人偶为角色【】");

    const en = buildPosePromptAnchor({
      characters: fourChars,
      language: "en",
      exportModes: DEFAULT_POSE_CONFIG.exportModes,
      anchor: DEFAULT_POSE_CONFIG.promptAnchor,
    });
    expect(en.text).toContain("# Pose Reference\nIn the pose reference image:");
    expect(en.text).toContain('- The blue 3D mannequin 1st from the left labeled "A" is character []');
    expect(en.text).toContain('- The #ABCDEF 3D mannequin 4th from the left labeled "EX" is character []');
  });

  it("computes duo relative positions and emits guard warnings when needed", () => {
    const duoPos = computeCharacterPositions([
      { ...fourChars[0], screenX: 0.2, screenY: 0.7, depth: 3.0 },
      { ...fourChars[1], screenX: 0.8, screenY: 0.3, depth: 6.0 },
    ]);
    expect(duoPos.get("1")?.zh).toBe("左侧前景上方");
    expect(duoPos.get("2")?.en).toBe("on the right in the background at the bottom");

    const posOnly = buildPosePromptAnchor({
      characters: fourChars,
      language: "zh",
      exportModes: DEFAULT_POSE_CONFIG.exportModes,
      anchor: { enabled: true, useColor: false, useLabel: false, usePosition: true, positionStrategy: "rank_depth" },
    });
    expect(posOnly.warnings).toContain("multi_position_only");

    const allOff = buildPosePromptAnchor({
      characters: fourChars,
      language: "zh",
      exportModes: DEFAULT_POSE_CONFIG.exportModes,
      anchor: { enabled: true, useColor: false, useLabel: false, usePosition: false, positionStrategy: "rank_depth" },
    });
    expect(allOff.warnings).toContain("all_unchecked");
  });

  it("upserts or replaces existing pose anchor block without losing user prompt", () => {
    const block1 = "# 动作参考\n姿势参考图中：\n- 编号为 A 的3D人偶为角色【】";
    const block2 = "# 动作参考\n姿势参考图中：\n- 编号为 B 的3D人偶为角色【】";
    const appended = upsertPoseAnchorInPrompt("A cinematic portrait, soft light", block1);
    expect(appended).toBe(`A cinematic portrait, soft light\n\n${block1}`);
    const replaced = upsertPoseAnchorInPrompt(appended, block2);
    expect(replaced).toBe(`A cinematic portrait, soft light\n\n${block2}`);
  });
});

describe("poseStorage", () => {
  it("enforces English built-in folder names and supports spaces in custom subfolders", () => {
    expect(BUILTIN_POSE_DIRS).toEqual({
      root: "poses",
      recent: "recent",
      saved: "saved",
      presets: "presets",
    });
    expect(sanitizePoseSegment("Action Poses 01")).toBe("Action Poses 01");
    expect(sanitizePoseSegment("双人 互动")).toBe("双人 互动");
    expect(sanitizePoseSegment("..")).toBeNull();
    expect(sanitizePoseSegment("bad:name")).toBeNull();
    expect(sanitizePoseFolderPath("presets\\Action Poses 01/Standing Pack")).toBe("presets/Action Poses 01/Standing Pack");
    expect(sanitizePoseFolderPath("../escape")).toBeNull();
  });

  it("migrates legacy ComfyUI-Fisher-Pose saved JSON into v2 multi-character project", () => {
    const legacy = JSON.stringify({
      kind: "fisher-saved-pose",
      name: "legacy duo",
      doc: {
        width: 1024,
        height: 1024,
        people: [
          { transform: { x: -1, y: 0, z: 0, zoom: 1 } },
          { transform: { x: 1, y: 0, z: 0, zoom: 1 } },
        ],
      },
    });
    const parsed = parsePoseProjectJson(legacy, "fallback", DEFAULT_POSE_CONFIG.labelDefaults);
    expect(parsed.version).toBe(2);
    expect(parsed.characters).toHaveLength(2);
    expect(parsed.characters[0].label).toBe("A");
    expect(parsed.characters[1].label).toBe("B");
    expect(parsed.characters[0].color.name).toBe("blue");
    expect(parsed.characters[1].color.name).toBe("orange");
  });
});
