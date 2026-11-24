import { describe, expect, it } from "vitest";
import { createMemoryFs } from "../platform/memoryFs";
import {
  PROJECT_FILE_NAME,
  createComicProjectStore,
  normalizeProjectName,
  type ProjectFs,
} from "./comicProject";
import { createPathTools } from "./paths";

const paths = createPathTools("\\");
const DATA_DIR = "C:\\data";
const PROJECT_DIR = `${DATA_DIR}\\output\\Demo`;

function setup() {
  const memory = createMemoryFs(paths, DATA_DIR);
  const fs: ProjectFs = {
    ...memory,
    join: paths.join,
    relative: (from, to) => paths.relative(from, to, DATA_DIR),
    absolute: (path) => paths.absolute(path, DATA_DIR),
    splitExt: paths.splitExt,
  };
  let folder = `${DATA_DIR}\\output`;
  const store = createComicProjectStore({
    outputFolder: () => folder,
    fs,
    now: () => new Date(2026, 10, 24, 23, 5, 7),
  });
  return { store, fs, memory, setFolder: (value: string) => (folder = value) };
}

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

describe("project names", () => {
  it("turns a title into a safe folder name", () => {
    expect(normalizeProjectName("My Comic")).toBe("My_Comic");
    expect(normalizeProjectName("a/b:c*d?e")).toBe("a_b_c_d_e");
    expect(normalizeProjectName("  ")).toBe("");
    expect(normalizeProjectName("._x_.")).toBe("x");
  });
});

describe("saving a project", () => {
  it("copies the reference images into the project and writes project.json", async () => {
    const { store, fs, memory } = setup();
    await memory.write("C:\\pics\\a.PNG", png);
    await memory.write("C:\\pics\\b.webp", png);

    const saved = await store.saveProject(" Demo ", {
      story_requirement: "a story",
      style_notes: "ink",
      plan_title: "The Title",
      plan_style_notes: "watercolor",
      settings: { image_model: "nano-banana" },
      pages: [{ page_number: 1, image_prompt: "x" }, { page_number: 2, image_prompt: "y" }],
      reference_images: ["C:\\pics\\a.PNG", "C:\\pics\\gone.png", "C:\\pics\\b.webp"],
      generated_outputs: { "1": ["C:\\out\\a.png"] },
    });

    expect(saved.project_name).toBe("Demo");
    expect(saved.payload).toMatchObject({
      project_name: "Demo",
      updated_at: "2026-11-24 23:05:07",
      story_requirement: "a story",
      style_notes: "ink",
      plan_title: "The Title",
      plan_style_notes: "watercolor",
      settings: { image_model: "nano-banana" },
      pages_directory: saved.pages_dir,
      // 编号按传入位置算，中间缺的那张留了空号
      reference_images: [
        { source_path: "C:\\pics\\a.PNG", project_relative_path: "reference_images\\ref_01.png" },
        { source_path: "C:\\pics\\b.webp", project_relative_path: "reference_images\\ref_03.webp" },
      ],
    });
    expect(await fs.isDir(`${PROJECT_DIR}\\pages`)).toBe(true);
    expect(await fs.isDir(`${PROJECT_DIR}\\reference_images`)).toBe(true);
    expect(await fs.exists(`${PROJECT_DIR}\\reference_images\\ref_01.png`)).toBe(true);
    expect(await fs.exists(`${PROJECT_DIR}\\reference_images\\ref_02.png`)).toBe(false);
    expect(await fs.exists(`${PROJECT_DIR}\\reference_images\\ref_03.webp`)).toBe(true);
    // 文件内容与 json.dump(ensure_ascii=False, indent=2) 一致，没有结尾换行
    expect(await fs.readText(saved.project_file)).toBe(JSON.stringify(saved.payload, null, 2));
  });

  it("fills in defaults for anything the caller left out", async () => {
    const { store } = setup();
    const saved = await store.saveProject("Bare", {});
    expect(saved.payload).toMatchObject({
      story_requirement: "",
      settings: {},
      pages: [],
      reference_images: [],
      generated_outputs: {},
      plan_title: "",
    });
  });

  it("refuses an empty name", async () => {
    const { store } = setup();
    await expect(store.saveProject("  ", {})).rejects.toThrow("Project name is empty");
    await expect(store.loadProject("...")).rejects.toThrow("Project name is empty");
  });

  it("keeps a relative output folder relative, the way the config stores it", async () => {
    const { store, fs, setFolder } = setup();
    setFolder("./output");
    const saved = await store.saveProject("Rel", {});
    expect(saved.pages_dir).toBe(`./output\\Rel\\pages`);
    // 路径按数据目录解析，文件落在了数据目录下
    expect(await fs.exists(`${DATA_DIR}\\output\\Rel\\${PROJECT_FILE_NAME}`)).toBe(true);
    expect(await fs.readText(saved.project_file)).toContain('"project_name": "Rel"');
  });
});

describe("loading a project", () => {
  it("resolves the project's own copies of the reference images", async () => {
    const { store, memory } = setup();
    await memory.write("C:\\pics\\a.png", png);
    await memory.write("C:\\pics\\b.png", png);
    await store.saveProject("Demo", {
      pages: [{ page_number: 1 }],
      reference_images: ["C:\\pics\\a.png", "C:\\pics\\b.png"],
    });
    // 第二张的项目副本被删了，退回到当初的来源路径
    await memory.remove(`${PROJECT_DIR}\\reference_images\\ref_02.png`);

    const loaded = await store.loadProject("Demo");
    expect(loaded.project_name).toBe("Demo");
    expect(loaded.resolved_reference_images).toEqual([
      `${PROJECT_DIR}\\reference_images\\ref_01.png`,
      "C:\\pics\\b.png",
    ]);
    expect(loaded.pages_dir).toBe(loaded.pages_directory);
    expect(loaded.pages).toEqual([{ page_number: 1 }]);
    expect(loaded.project_file).toBe(`${PROJECT_DIR}\\${PROJECT_FILE_NAME}`);
  });

  it("still opens a project from the old projects folder", async () => {
    const { store, fs } = setup();
    const legacyDir = `${DATA_DIR}\\output\\projects\\Old`;
    await fs.makeDirs(legacyDir);
    await fs.writeText(
      `${legacyDir}\\${PROJECT_FILE_NAME}`,
      JSON.stringify({ story_requirement: "from the old days", reference_images: [] }),
    );
    const loaded = await store.loadProject("Old");
    expect(loaded.story_requirement).toBe("from the old days");
    expect(loaded.project_root).toBe(legacyDir);
    expect(loaded.pages_dir).toBe(`${legacyDir}\\pages`);
  });

  it("says which file is missing when there is no such project", async () => {
    const { store } = setup();
    await expect(store.loadProject("Nope")).rejects.toThrow(
      `Project file not found: ${DATA_DIR}\\output\\Nope\\${PROJECT_FILE_NAME}`,
    );
  });
});

describe("listing projects", () => {
  it("finds projects in both locations and sorts them from Z to A", async () => {
    const { store, fs } = setup();
    await store.saveProject("zeta", {});
    await store.saveProject("Alpha", {});
    const legacyDir = `${DATA_DIR}\\output\\projects\\Middle`;
    await fs.makeDirs(legacyDir);
    await fs.writeText(`${legacyDir}\\${PROJECT_FILE_NAME}`, "{}");
    // 没有嵌套的普通文件夹不算项目
    await fs.makeDirs(`${DATA_DIR}\\output\\notes`);
    expect(await store.listProjects()).toEqual(["zeta", "Middle", "Alpha"]);
  });
});
