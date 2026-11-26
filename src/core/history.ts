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
  /** 缓存在库里的低画质方形缩略图（data:image/webp|jpeg;base64,...），原文件删/移后仍可预览参考。 */
  thumbnail: string | null;
  /** 结果文件落盘时计算的 SHA-256（小写 64 位十六进制），点击打开前用于校验文件未被替换。 */
  result_sha256: string | null;
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
  thumbnail?: string | null;
  resultSha256?: string | null;
  failureReason?: string | null;
  errorMessage?: string | null;
  /** 为真时显式清空 failure_reason 和 error_message（如失败任务经再获取恢复为成功时）。 */
  clearFailure?: boolean;
}

export interface UsageLedgerRecord {
  readonly task_id: string;
  readonly date: string;
  readonly model: string;
  readonly kind: "image" | "video";
  readonly credits: number;
  readonly status: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface UsageLedgerInput {
  taskId: string;
  date: string;
  model: string;
  kind: "image" | "video";
  credits: number;
  status: string;
  createdAt: string;
  /** 为真时若该 task_id 已存在则跳过，用于历史回填不覆盖当时锁定的积分快照。 */
  ignoreIfExists?: boolean;
}

export interface HistoryStore {
  /** 建表、补列、建索引。启动时调一次。 */
  ensureSchema(): Promise<void>;
  /** 把旧版的 history.json 或 grsai_history.json 迁进来，迁完把原文件改名为 .bak。 */
  migrateLegacyJson(): Promise<void>;
  addTask(input: NewTaskInput): Promise<HistoryTask>;
  /** 按任务 id 读取单条记录，不存在返回 null。 */
  getTask(taskId: string): Promise<HistoryTask | null>;
  /** 只有给了值（非空）的字段才会写进去；clearFailure 为真时清空失败信息。任务不存在时返回 null。 */
  updateTask(taskId: string, status: string, update?: TaskUpdate): Promise<HistoryTask | null>;
  getAllTasks(): Promise<HistoryTask[]>;
  getTaskCount(): Promise<number>;
  getTasksPage(page: number, pageSize: number): Promise<HistoryTask[]>;
  /** 按任务 id 列表删除历史记录（不影响独立的 usage_events 用量台账）。 */
  deleteTasks(taskIds: readonly string[]): Promise<number>;
  clearAllTasks(): Promise<number>;
  clearFailedTasks(): Promise<number>;
  clearViolationTasks(): Promise<number>;
  clearRunningTasks(): Promise<number>;
  /** 写入/更新一条独立用量台账记录。 */
  recordUsageEvent(input: UsageLedgerInput): Promise<void>;
  /** 读取全部独立用量台账记录（按时间倒序）。 */
  getUsageEvents(): Promise<UsageLedgerRecord[]>;
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
    thumbnail TEXT,
    result_sha256 TEXT,
    failure_reason TEXT,
    error_message TEXT,
    updated_at TEXT NOT NULL
)`;

/** 旧版本数据库缺的扩展列（启动时按需自动补齐，不影响旧数据与源项目按列名读取）。 */
const OPTIONAL_COLUMNS: ReadonlyArray<readonly [name: string, declaration: string]> = [
  ["duration", "INTEGER"],
  ["seed", "INTEGER"],
  ["ref_audios", "TEXT"],
  ["first_frame", "TEXT"],
  ["last_frame", "TEXT"],
  ["ref_videos", "TEXT"],
  ["ref_video_options", "TEXT"],
  ["thumbnail", "TEXT"],
  ["result_sha256", "TEXT"],
];

const CREATE_INDEX =
  "CREATE INDEX IF NOT EXISTS idx_history_created_at ON history_tasks(created_at DESC)";

/** 独立用量台账表：保存任务结算时的估算积分快照，即使删除历史记录也不丢失用量统计。 */
const CREATE_USAGE_TABLE = `CREATE TABLE IF NOT EXISTS usage_events (
    task_id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    model TEXT NOT NULL,
    kind TEXT NOT NULL,
    credits INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)`;

const CREATE_USAGE_INDEX =
  "CREATE INDEX IF NOT EXISTS idx_usage_events_date ON usage_events(date DESC)";

const INSERT_USAGE_REPLACE = `INSERT OR REPLACE INTO usage_events (
    task_id, date, model, kind, credits, status, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

const INSERT_USAGE_IGNORE = `INSERT OR IGNORE INTO usage_events (
    task_id, date, model, kind, credits, status, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

const INSERT_TASK = `INSERT OR REPLACE INTO history_tasks (
    id, prompt, model, aspect_ratio, image_size, ref_images,
    duration, seed, ref_audios, first_frame, last_frame, ref_videos, ref_video_options,
    status, created_at, result_path, preview_url, thumbnail, result_sha256,
    failure_reason, error_message, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

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

  // 进程内写操作串行队列：多任务同时落盘或高频点击时依次写入，避免 SQLITE_BUSY 锁冲突
  let writeChain: Promise<void> = Promise.resolve();
  function enqueueWrite<T>(work: () => Promise<T>): Promise<T> {
    const run = writeChain.then(work, work);
    writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function ensureSchema(): Promise<void> {
    return enqueueWrite(async () => {
      await db.execute(CREATE_TABLE);
      const columns = await db.select<{ name: string }>("PRAGMA table_info(history_tasks)");
      const existing = new Set(columns.map((column) => column.name));
      for (const [column, declaration] of OPTIONAL_COLUMNS) {
        if (!existing.has(column)) {
          await db.execute(`ALTER TABLE history_tasks ADD COLUMN ${column} ${declaration}`);
        }
      }
      await db.execute(CREATE_INDEX);
      await db.execute(CREATE_USAGE_TABLE);
      await db.execute(CREATE_USAGE_INDEX);
    });
  }

  function migrateLegacyJson(): Promise<void> {
    return enqueueWrite(async () => {
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
          optionalText(record.thumbnail),
          optionalText(record.result_sha256),
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
    });
  }

  function addTask(input: NewTaskInput): Promise<HistoryTask> {
    return enqueueWrite(async () => {
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
        thumbnail: null,
        result_sha256: null,
        failure_reason: null,
        error_message: null,
        updated_at: createdAt,
      };
    });
  }

  async function getTask(taskId: string): Promise<HistoryTask | null> {
    const rows = await db.select<StoredTask>("SELECT * FROM history_tasks WHERE id = ?", [taskId]);
    return rows[0] ? toTask(rows[0]) : null;
  }

  function updateTask(
    taskId: string,
    status: string,
    update: TaskUpdate = {},
  ): Promise<HistoryTask | null> {
    return enqueueWrite(async () => {
      const fields: string[] = ["status = ?", "updated_at = ?"];
      const params: unknown[] = [status, timestamp()];
      // 与源项目一致：空值不覆盖已有内容；显式指定 clearFailure 时把失败原因清为 null
      for (const [column, value] of [
        ["result_path", update.resultPath],
        ["preview_url", update.previewUrl],
        ["thumbnail", update.thumbnail],
        ["result_sha256", update.resultSha256],
      ] as const) {
        if (value) {
          fields.push(`${column} = ?`);
          params.push(value);
        }
      }
      if (update.clearFailure) {
        fields.push("failure_reason = ?", "error_message = ?");
        params.push(null, null);
      } else {
        for (const [column, value] of [
          ["failure_reason", update.failureReason],
          ["error_message", update.errorMessage],
        ] as const) {
          if (value) {
            fields.push(`${column} = ?`);
            params.push(value);
          }
        }
      }
      await db.execute(`UPDATE history_tasks SET ${fields.join(", ")} WHERE id = ?`, [...params, taskId]);
      const rows = await db.select<StoredTask>("SELECT * FROM history_tasks WHERE id = ?", [taskId]);
      return rows[0] ? toTask(rows[0]) : null;
    });
  }

  async function getAllTasks(): Promise<HistoryTask[]> {
    const rows = await db.select<StoredTask>(`SELECT * FROM history_tasks ${ORDER_BY}`);
    return rows.map(toTask);
  }

  async function getTaskCount(): Promise<number> {
    const rows = await db.select<{ cnt: number }>("SELECT COUNT(1) AS cnt FROM history_tasks");
    return Number(rows[0]?.cnt ?? 0);
  }

  function deleteTasks(taskIds: readonly string[]): Promise<number> {
    return enqueueWrite(async () => {
      const unique = [...new Set(taskIds.filter((id) => id.trim() !== ""))];
      if (unique.length === 0) return 0;
      let deleted = 0;
      for (const id of unique) {
        const result = await db.execute("DELETE FROM history_tasks WHERE id = ?", [id]);
        deleted += Math.max(result.rowsAffected ?? 0, 0);
      }
      return deleted;
    });
  }

  function recordUsageEvent(input: UsageLedgerInput): Promise<void> {
    return enqueueWrite(async () => {
      const sql = input.ignoreIfExists ? INSERT_USAGE_IGNORE : INSERT_USAGE_REPLACE;
      await db.execute(sql, [
        input.taskId,
        input.date,
        input.model,
        input.kind,
        Math.max(0, Math.trunc(input.credits)),
        input.status,
        input.createdAt,
        timestamp(),
      ]);
    });
  }

  async function getUsageEvents(): Promise<UsageLedgerRecord[]> {
    const rows = await db.select<UsageLedgerRecord>(
      "SELECT * FROM usage_events ORDER BY created_at DESC, task_id DESC",
    );
    return rows.map((row) => ({
      ...row,
      kind: row.kind === "video" ? "video" : "image",
      credits: Number(row.credits ?? 0),
    }));
  }

  function clearAllTasks(): Promise<number> {
    return enqueueWrite(async () => {
      const deleted = await getTaskCount();
      await db.execute("DELETE FROM history_tasks");
      await db.execute("VACUUM");
      return deleted;
    });
  }

  function clearByStatus(status: string): Promise<number> {
    return enqueueWrite(async () => {
      const result = await db.execute("DELETE FROM history_tasks WHERE status = ?", [status]);
      await db.execute("VACUUM");
      return Math.max(result.rowsAffected ?? 0, 0);
    });
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
    getTask,
    updateTask,
    getAllTasks,
    getTaskCount,
    getTasksPage,
    deleteTasks,
    clearAllTasks,
    clearFailedTasks: () => clearByStatus("failed"),
    clearViolationTasks: () => clearByStatus("violation"),
    clearRunningTasks: () => clearByStatus("running"),
    recordUsageEvent,
    getUsageEvents,
  };
}
