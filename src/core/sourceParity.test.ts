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
const REWRITE_ONLY_KEYS = ["submit_concurrency", "accent_color"];

function withoutRewriteKeys(config: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...config };
  for (const key of REWRITE_ONLY_KEYS) delete copy[key];
  return copy;
}

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
      const expected = sample.payload as Record<string, unknown> | null;
      if (actual && "seed" in actual && (params.seed === null || params.seed === undefined)) {
        expect(Number.isInteger(actual.seed)).toBe(true);
        expect(actual.seed as number).toBeGreaterThanOrEqual(1);
        expect(actual.seed as number).toBeLessThanOrEqual(2 ** 31 - 1);
        delete actual.seed;
        delete expected?.seed;
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
        const expected = sample.result.ok as Record<string, unknown>;
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
