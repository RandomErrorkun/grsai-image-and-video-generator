/**
 * 与源项目的对照测试。
 *
 * 样本由源项目的函数亲自算出（生成脚本按临时工作目录运行源码，不读真实配置），
 * 这里拿重写版的结果逐条比对，保证请求体、配置迁移和提示词与源实现一致。
 */
import { describe, expect, it } from "vitest";
import { buildGeneratePayload, type GenerateParams } from "./api";
import { buildPlanningMessages, parseComicPlan } from "./comicPlanner";
import { normalizeProjectName } from "./comicProject";
import { migrateConfig } from "./config";
import fixture from "./__fixtures__/source_parity.json";
import { extensionForUrl } from "./tasks";
import { createPathTools } from "./paths";
import { pyInt, pySplitLines, pyStr } from "./py";
import { normalizeDialogue } from "./comicPlanner";

const PARAM_KEYS: Record<string, string> = {
  prompt: "prompt",
  model: "model",
  aspect_ratio: "aspectRatio",
  image_size: "imageSize",
  ref_image_urls: "refImageUrls",
  quality: "quality",
  background: "background",
  output_format: "outputFormat",
  duration: "duration",
  seed: "seed",
  ref_audios: "refAudios",
  first_frame: "firstFrame",
  last_frame: "lastFrame",
  ref_videos: "refVideos",
};

/** 生成样本时用到的两张参考图（相对当前目录）。 */
const SAMPLE_IMAGES = new Set(["ref_one.png", "ref_two.PNG"]);
const sampleFiles = {
  async isFile(path: string) {
    return SAMPLE_IMAGES.has(path);
  },
  async read() {
    return null;
  },
};

/** 重写版多出来的配置键，比对时剔掉。 */
const REWRITE_ONLY_KEYS = [
  "grsai_site_url",
  "submit_concurrency",
  "accent_color",
  "preview_mode",
  "comic_custom_chat_base_url",
  "comic_custom_chat_endpoint",
  "comic_custom_chat_api_key",
  "comic_custom_chat_model",
  "comic_custom_chat_body",
  "pose_watermark_area_ratio",
  "pose_label_area_ratio",
];

function withoutRewriteKeys(config: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...config };
  for (const key of REWRITE_ONLY_KEYS) delete copy[key];
  return copy;
}

/**
 * 有意不跟源项目走的地方。样本文件照旧是源项目算出来的结果，这里只在比对前改命中的用例的期望值。
 * 每一条都要写明依据和核对日期，新增时照这个格式登记。
 */
const KNOWN_DIVERGENCES: Array<{
  where: (params: Record<string, unknown>) => boolean;
  patch:
    | Record<string, unknown>
    | ((params: Record<string, unknown>, expected: Record<string, unknown>) => Record<string, unknown>);
  reason: string;
}> = [
  {
    where: (params) => params.model === "gpt-image-2.6-flare" || params.model === "gpt-image-2.6-sunburst",
    patch: { outputFormat: "png" },
    reason:
      "GPT Image 接口文档（https://qmy27nhsd9.apifox.cn/452409160e0，2026-11-25 核对）：gif 由 gpt-image-2.6 和它的两个变体支持，默认 png。" +
      "源项目把两个变体记成只支持 gif，取值不合法时也回退到 gif。",
  },
  {
    where: (params) => params.model === "agnes-video-2.5" && Array.isArray(params.refVideos) && params.refVideos.length > 0,
    patch: (params, expected) => ({
      ...expected,
      videos: (params.refVideos as string[]).map((url) => ({ url, requireAudio: false })),
    }),
    reason:
      "agnes-video 接口文档（https://qmy27nhsd9.apifox.cn/523334530e0，2026-11-25 核对）：videos 是对象数组，每项带 url、startSeconds 和 requireAudio。" +
      "源项目预留的是字符串数组。",
  },
  {
    where: (params) => params.model === "minimax-h3" && params.aspectRatio === "square",
    patch: { aspectRatio: "landscape" },
    reason:
      "minimax-h3 接口文档（https://qmy27nhsd9.apifox.cn/514679297e0，2026-11-25 核对并经实机验证）：仅支持 portrait 与 landscape，不支持 square，服务端直接拒绝 square。",
  },
  {
    where: (params) =>
      params.model === "minimax-h3" && Boolean(params.firstFrame || params.lastFrame),
    patch: (params, expected) => {
      const next: Record<string, unknown> = { ...expected };
      delete next.images;
      delete next.audios;
      if (params.firstFrame) next.firstFrame = params.firstFrame;
      if (params.lastFrame) next.lastFrame = params.lastFrame;
      return next;
    },
    reason:
      "minimax-h3 接口文档（https://qmy27nhsd9.apifox.cn/514679297e0，2026-11-25 线上更新）：现已支持 firstFrame / lastFrame 且与 images/audios 互斥。",
  },
];

describe("request payloads match the source project", () => {
  for (const sample of fixture.payloads) {
    const params: Record<string, unknown> = {};
    for (const [pythonKey, value] of Object.entries(sample.params)) {
      params[PARAM_KEYS[pythonKey]] = value;
    }
    const label = Object.entries(sample.params)
      .filter(([, value]) => value !== null)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(" ");
    it(label, () => {
      const actual = buildGeneratePayload(params as unknown as GenerateParams) as Record<string, unknown> | null;
      // 视频模型不给种子时两边都随机取一个，只核对范围
      let expected = sample.payload as Record<string, unknown> | null;
      if (actual && "seed" in actual && (params.seed === null || params.seed === undefined)) {
        expect(Number.isInteger(actual.seed)).toBe(true);
        expect(actual.seed as number).toBeGreaterThanOrEqual(1);
        expect(actual.seed as number).toBeLessThanOrEqual(2 ** 31 - 1);
        delete actual.seed;
        if (expected) {
          expected = { ...expected };
          delete expected.seed;
        }
      }
      for (const divergence of KNOWN_DIVERGENCES) {
        if (!expected || !divergence.where(params)) continue;
        expected =
          typeof divergence.patch === "function"
            ? divergence.patch(params, expected)
            : { ...expected, ...divergence.patch };
      }
      expect(actual).toEqual(expected);
    });
  }
});

describe("config migration matches the source project", () => {
  for (const sample of fixture.config_migration) {
    const label = JSON.stringify(sample.old).slice(0, 70);
    if ("ok" in sample.result) {
      it(`migrates ${label}`, () => {
        const migrated = withoutRewriteKeys(migrateConfig(sample.old) as unknown as Record<string, unknown>);
        const expected = { ...(sample.result.ok as Record<string, unknown>) };
        // 重写版内置私有等宽字体 JetBrainsMapleMono 并调整默认字号为 9（源项目默认为 Arial / 12）
        const oldRecord = sample.old as Record<string, unknown>;
        if (!("text_font_family" in oldRecord) && expected.text_font_family === "Arial") {
          expected.text_font_family = "JetBrainsMapleMono";
        }
        if (!("text_font_size" in oldRecord) && expected.text_font_size === 12) {
          expected.text_font_size = 9;
        }
        expect(Object.keys(migrated)).toEqual(Object.keys(expected));
        expect(migrated).toEqual(expected);
      });
    } else {
      it(`rejects ${label}`, () => {
        expect(() => migrateConfig(sample.old)).toThrow();
      });
    }
  }
});

describe("comic planning matches the source project", () => {
  const cases: Array<{ story: string; style: string; pages: number; refs: string[]; language: string }> = [
    { story: "  A lonely lighthouse keeper  ", style: "", pages: 3, refs: [], language: "en" },
    { story: "Story\nlines", style: "  ink wash  ", pages: 5, refs: ["ref_one.png", "missing.png", "ref_two.PNG"], language: "en" },
    { story: "故事", style: "水墨", pages: 4, refs: ["ref_two.PNG"], language: "zh" },
  ];

  for (const [index, input] of cases.entries()) {
    it(`builds the same planning messages (case ${index})`, async () => {
      const expected = fixture.planning_messages[index].ok;
      const messages = await buildPlanningMessages(
        input.story,
        input.style,
        input.pages,
        input.refs,
        sampleFiles,
        input.language,
      );
      expect(messages).toEqual(expected);
    });
  }

  for (const sample of fixture.comic_plans) {
    it(`parses the plan the same way: ${JSON.stringify(sample.content).slice(0, 60)}`, () => {
      const expected = sample.result;
      if ("ok" in expected) {
        expect(parseComicPlan(sample.content, sample.page_count, sample.reference_count)).toEqual(expected.ok);
      } else {
        expect(() => parseComicPlan(sample.content, sample.page_count, sample.reference_count)).toThrow(
          expected.message,
        );
      }
    });
  }
});

describe("helpers match the source project", () => {
  it("extensionForUrl", () => {
    for (const sample of fixture.extension_for_url) {
      expect(extensionForUrl(sample.url, sample.default)).toBe(sample.result);
    }
  });

  it("normalizeProjectName", () => {
    for (const sample of fixture.normalize_project_name) {
      expect(normalizeProjectName(sample.name)).toBe(sample.result);
    }
  });

  it("pyStr", () => {
    for (const sample of fixture.py_str) {
      expect(pyStr(sample.value)).toBe(sample.result);
    }
  });

  it("pyInt", () => {
    for (const sample of fixture.py_int) {
      expect(pyInt(sample.value)).toBe("ok" in sample.result ? sample.result.ok : null);
    }
  });

  it("pySplitLines", () => {
    expect(pySplitLines("a\r\nb\nc\rd\x0be\x0cf\x1cg\u0085h\u2028i\u2029j")).toEqual(fixture.py_splitlines);
  });

  it("dialogue line cleaning", () => {
    for (const sample of fixture.py_strip) {
      expect(normalizeDialogue(sample.text)).toEqual([sample.result]);
    }
  });

  it("paths behave like ntpath", () => {
    const paths = createPathTools("\\");
    for (const sample of fixture.ntpath.join) {
      expect(paths.join(...sample.parts)).toBe(sample.result);
    }
    for (const sample of fixture.ntpath.absolute) {
      expect(paths.absolute(sample.path, sample.base)).toBe(sample.result);
    }
    for (const sample of fixture.ntpath.relative) {
      if ("ok" in sample.result) {
        expect(paths.relative(sample.from, sample.to)).toBe(sample.result.ok);
      } else {
        expect(() => paths.relative(sample.from, sample.to)).toThrow();
      }
    }
    for (const sample of fixture.ntpath.splitext) {
      expect(paths.splitExt(sample.path)).toEqual(sample.result);
    }
    for (const sample of fixture.ntpath.basename) {
      expect(paths.basename(sample.path)).toBe(sample.result);
    }
  });
});
