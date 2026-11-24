/**
 * 漫画项目的目录和 project.json 读写（对应 core/comic_project_manager.py）。
 * 目录结构保持不变：项目的 reference_images、pages 和 project.json 都在输出文件夹下。
 */
import { formatLocalTime } from "./py";

export const PROJECT_FILE_NAME = "project.json";

export interface ProjectReferenceImage {
  source_path: string;
  project_relative_path: string;
}

/** 存进 project.json 的内容。 */
export interface ProjectPayload {
  project_name: string;
  updated_at: string;
  story_requirement: string;
  style_notes: string;
  plan_title: string;
  plan_style_notes: string;
  settings: Record<string, unknown>;
  pages: unknown[];
  reference_images: ProjectReferenceImage[];
  generated_outputs: Record<string, unknown>;
  pages_directory: string;
}

export interface SavedProject {
  project_name: string;
  project_root: string;
  pages_dir: string;
  project_file: string;
  payload: ProjectPayload;
}

/** 读出来的项目，多出几个解析好的路径字段。 */
export interface LoadedProject extends ProjectPayload {
  /** 参考图的可用路径：项目里的副本优先，没有再用当初的来源路径。 */
  resolved_reference_images: string[];
  project_root: string;
  project_file: string;
  pages_dir: string;
}

/** 项目文件读写用到的文件操作。 */
export interface ProjectFs {
  makeDirs(path: string): Promise<void>;
  isDir(path: string): Promise<boolean>;
  isFile(path: string): Promise<boolean>;
  exists(path: string): Promise<boolean>;
  /** 列出目录下的条目名。 */
  readDir(path: string): Promise<string[]>;
  /** 复制文件；失败要抛错。 */
  copyFile(source: string, dest: string): Promise<void>;
  writeText(path: string, text: string): Promise<void>;
  /** 读失败要抛错。 */
  readText(path: string): Promise<string>;
  join(...parts: string[]): string;
  /** 相当于 os.path.relpath(to, from)。 */
  relative(from: string, to: string): string;
  /** 相当于 os.path.abspath：补成绝对路径并规整，不解析符号链接。 */
  absolute(path: string): string;
  /** 相当于 os.path.splitext：[主体, 扩展名]；扩展名带点。 */
  splitExt(path: string): [string, string];
}

export interface ComicProjectStore {
  /** 输出文件夹，不存在就建出来。 */
  projectsRoot(): Promise<string>;
  /** 旧版项目所在的输出文件夹下的 projects 子目录。 */
  legacyProjectsRoot(): string;
  listProjects(): Promise<string[]>;
  saveProject(name: string, payload: ProjectSaveInput): Promise<SavedProject>;
  loadProject(name: string): Promise<LoadedProject>;
}

/** 保存时界面交上来的内容。 */
export interface ProjectSaveInput {
  story_requirement?: string;
  style_notes?: string;
  plan_title?: string;
  plan_style_notes?: string;
  settings?: Record<string, unknown>;
  pages?: unknown[];
  reference_images?: readonly string[];
  generated_outputs?: Record<string, unknown>;
}

export interface ComicProjectStoreDeps {
  /** 输出文件夹，每次用到时才读配置。 */
  outputFolder(): string;
  fs: ProjectFs;
  now?: () => Date;
}

/** 项目名里不能当文件名用的字符换成下划线，空白换成下划线，再去掉首尾的点和下划线。 */
export function normalizeProjectName(name: string | null | undefined): string {
  const cleaned = (name ?? "")
    .trim()
    .replace(/[<>:"/\\|?*]+/g, "_")
    .replace(/\s+/g, "_");
  return cleaned.replace(/^[._]+/, "").replace(/[._]+$/, "");
}

/** 与 dict.get(key, fallback) 一致：键不存在才用 fallback。 */
function field(source: object, key: string, fallback: unknown): unknown {
  const record = source as Record<string, unknown>;
  return key in record ? record[key] : fallback;
}

/** 按 Python 的 sorted(..., reverse=True) 排：逐码点比较，降序。 */
function descending(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

export function createComicProjectStore(deps: ComicProjectStoreDeps): ComicProjectStore {
  const { fs } = deps;
  const now = deps.now ?? (() => new Date());

  function projectDir(projectName: string): [string, string] {
    const normalized = normalizeProjectName(projectName);
    if (!normalized) throw new Error("Project name is empty.");
    return [normalized, fs.join(deps.outputFolder(), normalized)];
  }

  async function projectsRoot(): Promise<string> {
    const root = deps.outputFolder();
    await fs.makeDirs(root);
    return root;
  }

  /** 旧版项目所在的输出文件夹下的 projects 子目录。 */
  function legacyProjectsRoot(): string {
    return fs.join(deps.outputFolder(), "projects");
  }

  return {
    projectsRoot,
    legacyProjectsRoot,

    async listProjects() {
      const names = new Set<string>();
      for (const root of [await projectsRoot(), legacyProjectsRoot()]) {
        if (!(await fs.isDir(root))) continue;
        for (const entry of await fs.readDir(root)) {
          const fullPath = fs.join(root, entry);
          if ((await fs.isDir(fullPath)) && (await fs.exists(fs.join(fullPath, PROJECT_FILE_NAME)))) {
            names.add(entry);
          }
        }
      }
      return [...names].sort(descending);
    },

    async saveProject(name, input) {
      const [normalizedName, projectRoot] = projectDir(name);
      const pagesDir = fs.join(projectRoot, "pages");
      await fs.makeDirs(projectRoot);
      await fs.makeDirs(pagesDir);

      // 参考图复制进项目的 reference_images，编号按传入的位置算，中途跳过的会留空号
      const refsDir = fs.join(projectRoot, "reference_images");
      await fs.makeDirs(refsDir);
      const copiedRefs: ProjectReferenceImage[] = [];
      for (const [index, refPath] of (input.reference_images ?? []).entries()) {
        if (!refPath || !(await fs.isFile(refPath))) continue;
        const [, ext = ""] = fs.splitExt(refPath);
        const targetPath = fs.join(refsDir, `ref_${String(index + 1).padStart(2, "0")}${ext.toLowerCase() || ".png"}`);
        try {
          if (fs.absolute(refPath) !== fs.absolute(targetPath)) await fs.copyFile(refPath, targetPath);
        } catch {
          continue;
        }
        copiedRefs.push({
          source_path: refPath,
          project_relative_path: fs.relative(projectRoot, targetPath),
        });
      }

      const source = input as Record<string, unknown>;
      const payload: ProjectPayload = {
        project_name: normalizedName,
        updated_at: formatLocalTime(now()),
        story_requirement: field(source, "story_requirement", "") as string,
        style_notes: field(source, "style_notes", "") as string,
        plan_title: field(source, "plan_title", "") as string,
        plan_style_notes: field(source, "plan_style_notes", "") as string,
        settings: field(source, "settings", {}) as Record<string, unknown>,
        pages: field(source, "pages", []) as unknown[],
        reference_images: copiedRefs,
        generated_outputs: field(source, "generated_outputs", {}) as Record<string, unknown>,
        pages_directory: pagesDir,
      };
      const projectFile = fs.join(projectRoot, PROJECT_FILE_NAME);
      await fs.writeText(projectFile, JSON.stringify(payload, null, 2));

      return {
        project_name: normalizedName,
        project_root: projectRoot,
        pages_dir: pagesDir,
        project_file: projectFile,
        payload,
      };
    },

    async loadProject(name) {
      const [normalizedName, projectRoot] = projectDir(name);
      let projectFile = fs.join(projectRoot, PROJECT_FILE_NAME);
      let root = projectRoot;
      if (!(await fs.exists(projectFile))) {
        // 旧版项目在输出文件夹的 projects 子目录下，仍可读取
        const legacyRoot = fs.join(legacyProjectsRoot(), normalizedName);
        const legacyFile = fs.join(legacyRoot, PROJECT_FILE_NAME);
        if (await fs.exists(legacyFile)) {
          root = legacyRoot;
          projectFile = legacyFile;
        } else {
          throw new Error(`Project file not found: ${projectFile}`);
        }
      }

      const stored = JSON.parse(await fs.readText(projectFile)) as Record<string, unknown>;
      const resolvedReferenceImages: string[] = [];
      const references = Array.isArray(stored.reference_images) ? stored.reference_images : [];
      for (const ref of references) {
        if (typeof ref !== "object" || ref === null || Array.isArray(ref)) continue;
        const record = ref as Record<string, unknown>;
        const projectRelativePath = typeof record.project_relative_path === "string"
          ? record.project_relative_path
          : "";
        const sourcePath = typeof record.source_path === "string" ? record.source_path : "";
        const projectCopy = projectRelativePath ? fs.join(root, projectRelativePath) : "";
        if (projectRelativePath && (await fs.exists(projectCopy))) resolvedReferenceImages.push(projectCopy);
        else if (sourcePath && (await fs.exists(sourcePath))) resolvedReferenceImages.push(sourcePath);
      }

      const payload = stored as unknown as ProjectPayload;
      return {
        ...payload,
        resolved_reference_images: resolvedReferenceImages,
        project_root: root,
        project_file: projectFile,
        pages_dir: payload.pages_directory || fs.join(root, "pages"),
        project_name: normalizedName,
      };
    },
  };
}
