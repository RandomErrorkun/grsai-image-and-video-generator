/**
 * 历史库（对应 core/history_manager.py）：SQLite 里的 history_tasks 表。
 *
 * 表结构、时间格式和排序都与源项目一致，旧数据库可以直接拿来用。
 * 全部 SQL 都集中在这个文件里，通过 SqlExecutor 执行；测试时换成 node:sqlite。
 */
import type { VideoReferenceOption } from "./api";
import { formatLocalTime } from "./py";

export const HISTORY_DB_FILE = "grsai_history.db";
export const LEGACY_HISTORY_FILE = "history.json";
export const OLD_HISTORY_FILE = "grsai_history.json";

/** 执行 SQL 的最小接口。Tauri 里是 plugin-sql，测试里是 node:sqlite。 */
export interface SqlExecutor {
  select<T>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ rowsAffected: number }>;
}

/** 历史库在数据目录里还会碰到的文件操作。 */
export interface HistoryFiles {
  exists(path: string): Promise<boolean>;
  /** 读失败要抛错。 */
  readText(path: string): Promise<string>;
  /** 把 target 改名为 backup；backup 已存在时先删掉它。 */
  replaceWithBackup(target: string, backup: string): Promise<void>;
}

export interface HistoryTask {
  id: string;
  prompt: string;
  model: string;
  aspect_ratio: string;
  image_size: string;
  /** 旧记录里可能是字符串，也可能是字符串数组。 */
  ref_images: string | string[] | null;
  duration: number | null;
  seed: number | null;
  ref_audios: string[] | null;
  first_frame: string | null;
  last_frame: string | null;
  ref_videos: string[] | null;
  /** 与 ref_videos 按下标对应的参考视频附加参数（起始秒数、音轨开关）；旧库和无参考视频时为 null。 */
  ref_video_options: VideoReferenceOption[] | null;
  status: string;
  created_at: string;
  result_path: string | null;
  preview_url: string | null;
  failure_reason: string | null;
  error_message: string | null;
  updated_at: string;
}

export interface NewTaskInput {
  id: string;
  prompt: string;
  model: string;
  aspectRatio: string;
  imageSize: string;
  refImages?: string | string[] | null;
  duration?: number | null;
  seed?: number | null;
  refAudios?: string[] | null;
  firstFrame?: string | null;
  lastFrame?: string | null;
  refVideos?: string[] | null;
  refVideoOptions?: readonly VideoReferenceOption[] | null;
}

export interface TaskUpdate {
  resultPath?: string | null;
  previewUrl?: string | null;
  failureReason?: string | null;
  errorMessage?: string | null;
}

export interface HistoryStore {
  /** 建表、补列、建索引。启动时调一次。 */
  ensureSchema(): Promise<void>;
  /** 把旧版的 history.json 或 grsai_history.json 迁进来，迁完把原文件改名为 .bak。 */
  migrateLegacyJson(): Promise<void>;
  addTask(input: NewTaskInput): Promise<HistoryTask>;
  /** 只有给了值（非空）的字段才会写进去。任务不存在时返回 null。 */
  updateTask(taskId: string, status: string, update?: TaskUpdate): Promise<HistoryTask | null>;
  getAllTasks(): Promise<HistoryTask[]>;
  getTaskCount(): Promise<number>;
  getTasksPage(page: number, pageSize: number): Promise<HistoryTask[]>;
  clearAllTasks(): Promise<number>;
  clearFailedTasks(): Promise<number>;
  clearViolationTasks(): Promise<number>;
  clearRunningTasks(): Promise<number>;
}

export interface HistoryStoreDeps {
  db: SqlExecutor;
  /** 数据目录；旧版 JSON 文件在这里找。 */
  dataDir: string;
  join(...parts: string[]): string;
  files: HistoryFiles;
  now?: () => Date;
}

type StoredTask = Omit<HistoryTask, "ref_images" | "ref_audios" | "ref_videos" | "ref_video_options"> & {
  ref_images: string | null;
  ref_audios: string | null;
  ref_videos: string | null;
  ref_video_options: string | null;
};

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS history_tasks (
    id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    model TEXT NOT NULL,
    aspect_ratio TEXT NOT NULL,
    image_size TEXT NOT NULL,
    ref_images TEXT,
    duration INTEGER,
    seed INTEGER,
    ref_audios TEXT,
    first_frame TEXT,
    last_frame TEXT,
    ref_videos TEXT,
    ref_video_options TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    result_path TEXT,
    preview_url TEXT,
    failure_reason TEXT,
    error_message TEXT,
    updated_at TEXT NOT NULL
)`;

/** 旧版本数据库缺的视频任务相关列。 */
const OPTIONAL_COLUMNS: ReadonlyArray<readonly [name: string, declaration: string]> = [
  ["duration", "INTEGER"],
  ["seed", "INTEGER"],
  ["ref_audios", "TEXT"],
  ["first_frame", "TEXT"],
  ["last_frame", "TEXT"],
  ["ref_videos", "TEXT"],
  ["ref_video_options", "TEXT"],
];

const CREATE_INDEX =
  "CREATE INDEX IF NOT EXISTS idx_history_created_at ON history_tasks(created_at DESC)";

const INSERT_TASK = `INSERT OR REPLACE INTO history_tasks (
    id, prompt, model, aspect_ratio, image_size, ref_images,
    duration, seed, ref_audios, first_frame, last_frame, ref_videos, ref_video_options,
    status, created_at, result_path, preview_url,
    failure_reason, error_message, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const ORDER_BY = "ORDER BY created_at DESC, id DESC";

/** 存成 JSON 文本；没有内容就是 null。 */
function serializeJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

/** 存的是 JSON 文本；旧记录的 ref_images 也可能是裸字符串。解析不了按 null 处理。 */
function deserializeJson(value: unknown): unknown {
  if (value === null || value === undefined || value === "") return null;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function toTask(row: StoredTask): HistoryTask {
  return {
    ...row,
    ref_images: deserializeJson(row.ref_images) as HistoryTask["ref_images"],
    ref_audios: deserializeJson(row.ref_audios) as string[] | null,
    ref_videos: deserializeJson(row.ref_videos) as string[] | null,
    ref_video_options: deserializeJson(row.ref_video_options) as VideoReferenceOption[] | null,
  };
}

/** 旧 JSON 记录里的可选字符串字段：是字符串就用，否则当作没有。 */
function optionalText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function createHistoryStore(deps: HistoryStoreDeps): HistoryStore {
  const { db, files, join } = deps;
  const now = deps.now ?? (() => new Date());
  const timestamp = () => formatLocalTime(now());

  async function ensureSchema(): Promise<void> {
    await db.execute(CREATE_TABLE);
    const columns = await db.select<{ name: string }>("PRAGMA table_info(history_tasks)");
    const existing = new Set(columns.map((column) => column.name));
    for (const [column, declaration] of OPTIONAL_COLUMNS) {
      if (!existing.has(column)) {
        await db.execute(`ALTER TABLE history_tasks ADD COLUMN ${column} ${declaration}`);
      }
    }
    await db.execute(CREATE_INDEX);
  }

  async function migrateLegacyJson(): Promise<void> {
    const legacyPath = join(deps.dataDir, LEGACY_HISTORY_FILE);
    const oldPath = join(deps.dataDir, OLD_HISTORY_FILE);
    const legacyExists = await files.exists(legacyPath);
    const oldExists = await files.exists(oldPath);
    if (!legacyExists && !oldExists) return;

    // 先迁 grsai_history.json，没有再迁 history.json
    const sourcePath = oldExists ? oldPath : legacyPath;
    let legacyTasks: unknown;
    try {
      legacyTasks = JSON.parse(await files.readText(sourcePath));
    } catch {
      legacyTasks = [];
    }
    if (!Array.isArray(legacyTasks) || legacyTasks.length === 0) return;

    for (const task of legacyTasks) {
      if (typeof task !== "object" || task === null || Array.isArray(task)) continue;
      const record = task as Record<string, unknown>;
      if (!record.id) continue;
      await db.execute(INSERT_TASK, [
        record.id,
        record.prompt ?? "",
        record.model ?? "",
        record.aspect_ratio ?? "auto",
        record.image_size ?? "1K",
        serializeJson(record.ref_images ?? null),
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        record.status ?? "running",
        record.created_at || timestamp(),
        optionalText(record.result_path),
        optionalText(record.preview_url),
        optionalText(record.failure_reason),
        optionalText(record.error_message),
        timestamp(),
      ]);
    }

    // 迁完改名留底；改不成也不影响使用，与源项目一致
    try {
      await files.replaceWithBackup(sourcePath, `${sourcePath}.bak`);
    } catch {
      // 备份失败就算了
    }
  }

  async function addTask(input: NewTaskInput): Promise<HistoryTask> {
    const createdAt = timestamp();
    const refImages = input.refImages ?? null;
    const refAudios = input.refAudios ?? null;
    const refVideos = input.refVideos ?? null;
    const refVideoOptions =
      input.refVideoOptions && input.refVideoOptions.length > 0 ? [...input.refVideoOptions] : null;
    await db.execute(INSERT_TASK, [
      input.id,
      input.prompt,
      input.model,
      input.aspectRatio,
      input.imageSize,
      serializeJson(refImages),
      input.duration ?? null,
      input.seed ?? null,
      serializeJson(refAudios),
      input.firstFrame ?? null,
      input.lastFrame ?? null,
      serializeJson(refVideos),
      serializeJson(refVideoOptions),
      "running",
      createdAt,
      null,
      null,
      null,
      null,
      createdAt,
    ]);
    return {
      id: input.id,
      prompt: input.prompt,
      model: input.model,
      aspect_ratio: input.aspectRatio,
      image_size: input.imageSize,
      ref_images: refImages,
      duration: input.duration ?? null,
      seed: input.seed ?? null,
      ref_audios: refAudios,
      first_frame: input.firstFrame ?? null,
      last_frame: input.lastFrame ?? null,
      ref_videos: refVideos,
      ref_video_options: refVideoOptions,
      status: "running",
      created_at: createdAt,
      result_path: null,
      preview_url: null,
      failure_reason: null,
      error_message: null,
      updated_at: createdAt,
    };
  }

  async function updateTask(
    taskId: string,
    status: string,
    update: TaskUpdate = {},
  ): Promise<HistoryTask | null> {
    const fields: string[] = ["status = ?", "updated_at = ?"];
    const params: unknown[] = [status, timestamp()];
    // 与源项目一致：空值不覆盖已有内容
    for (const [column, value] of [
      ["result_path", update.resultPath],
      ["preview_url", update.previewUrl],
      ["failure_reason", update.failureReason],
      ["error_message", update.errorMessage],
    ] as const) {
      if (value) {
        fields.push(`${column} = ?`);
        params.push(value);
      }
    }
    await db.execute(`UPDATE history_tasks SET ${fields.join(", ")} WHERE id = ?`, [...params, taskId]);
    const rows = await db.select<StoredTask>("SELECT * FROM history_tasks WHERE id = ?", [taskId]);
    return rows[0] ? toTask(rows[0]) : null;
  }

  async function getAllTasks(): Promise<HistoryTask[]> {
    const rows = await db.select<StoredTask>(`SELECT * FROM history_tasks ${ORDER_BY}`);
    return rows.map(toTask);
  }

  async function getTaskCount(): Promise<number> {
    const rows = await db.select<{ cnt: number }>("SELECT COUNT(1) AS cnt FROM history_tasks");
    return Number(rows[0]?.cnt ?? 0);
  }

  async function clearAllTasks(): Promise<number> {
    const deleted = await getTaskCount();
    await db.execute("DELETE FROM history_tasks");
    await db.execute("VACUUM");
    return deleted;
  }

  async function clearByStatus(status: string): Promise<number> {
    const result = await db.execute("DELETE FROM history_tasks WHERE status = ?", [status]);
    await db.execute("VACUUM");
    return Math.max(result.rowsAffected ?? 0, 0);
  }

  async function getTasksPage(page: number, pageSize: number): Promise<HistoryTask[]> {
    const safePage = Math.max(Math.trunc(page), 1);
    const safePageSize = Math.max(Math.trunc(pageSize), 1);
    const rows = await db.select<StoredTask>(
      `SELECT * FROM history_tasks ${ORDER_BY} LIMIT ? OFFSET ?`,
      [safePageSize, (safePage - 1) * safePageSize],
    );
    return rows.map(toTask);
  }

  return {
    ensureSchema,
    migrateLegacyJson,
    addTask,
    updateTask,
    getAllTasks,
    getTaskCount,
    getTasksPage,
    clearAllTasks,
    clearFailedTasks: () => clearByStatus("failed"),
    clearViolationTasks: () => clearByStatus("violation"),
    clearRunningTasks: () => clearByStatus("running"),
  };
}
