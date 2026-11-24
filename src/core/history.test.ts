import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HISTORY_DB_FILE,
  LEGACY_HISTORY_FILE,
  OLD_HISTORY_FILE,
  createHistoryStore,
  type HistoryFiles,
} from "./history";
import { createPathTools } from "./paths";
import { formatLocalTime } from "./py";
import { nodeSqliteExecutor } from "../testing/nodeSqlite";

/** 源项目最早那版表还没有的列。 */
const ADDED_LATER = new Set(["duration", "seed", "ref_audios", "first_frame", "last_frame", "ref_videos"]);
const ALL_COLUMNS = [
  "id", "prompt", "model", "aspect_ratio", "image_size", "ref_images", "duration", "seed", "ref_audios",
  "first_frame", "last_frame", "ref_videos", "status", "created_at", "result_path", "preview_url",
  "failure_reason", "error_message", "updated_at",
];

const paths = createPathTools("\\");
const clock = { now: new Date(2026, 10, 24, 23, 58, 9) };
const tick = (seconds: number) => {
  clock.now = new Date(clock.now.getTime() + seconds * 1000);
};
const stamp = () => formatLocalTime(clock.now);

let workDir = "";
let dbPath = "";

const realFiles: HistoryFiles = {
  async exists(path) {
    return readFile(path).then(
      () => true,
      () => false,
    );
  },
  readText: (path) => readFile(path, "utf8"),
  async replaceWithBackup(target, backup) {
    await rm(backup, { force: true });
    await rename(target, backup);
  },
};

/** 打开过的连接都记下来，收尾时统一关闭：Windows 上文件被占用时删不掉临时目录。 */
const opened: Array<{ close(): void }> = [];

function open(file = dbPath) {
  const executor = nodeSqliteExecutor(file);
  opened.push(executor);
  const store = createHistoryStore({
    db: executor,
    dataDir: workDir,
    join: paths.join,
    files: realFiles,
    now: () => clock.now,
  });
  return { store, executor };
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "grsai-history-test-"));
  dbPath = join(workDir, "grsai_test.db");
});

afterAll(async () => {
  for (const executor of opened) {
    try {
      executor.close();
    } catch {
      // 已经关过的连接再关一次会报错，不用管
    }
  }
  await rm(workDir, { recursive: true, force: true });
});

describe("history schema", () => {
  it("creates the table with all 19 columns and the index", async () => {
    const { store, executor } = open();
    await store.ensureSchema();
    const columns = await executor.select<{ name: string }>("PRAGMA table_info(history_tasks)");
    expect(columns.map((column) => column.name)).toEqual(ALL_COLUMNS);
    const indexes = await executor.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'");
    expect(indexes.map((index) => index.name)).toContain("idx_history_created_at");
    // 重复执行不出错
    await store.ensureSchema();
    executor.close();
  });

  it("adds the video columns to a database from an older version", async () => {
    const legacyPath = join(workDir, "grsai_old.db");
    const legacy = nodeSqliteExecutor(legacyPath);
    opened.push(legacy);
    await legacy.execute(`CREATE TABLE history_tasks (
      id TEXT PRIMARY KEY, prompt TEXT NOT NULL, model TEXT NOT NULL, aspect_ratio TEXT NOT NULL,
      image_size TEXT NOT NULL, ref_images TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL,
      result_path TEXT, preview_url TEXT, failure_reason TEXT, error_message TEXT, updated_at TEXT NOT NULL)`);
    // 旧记录的 ref_images 可能是单个路径的 JSON 字符串
    await legacy.execute(
      "INSERT INTO history_tasks VALUES ('old-1', 'p', 'nano-banana', 'auto', '1K', ?, 'succeeded', '2026-01-02 03:04:05', NULL, NULL, NULL, NULL, '2026-01-02 03:04:05')",
      [JSON.stringify("C:\\pics\\a.png")],
    );
    legacy.close();

    const { store, executor } = open(legacyPath);
    await store.ensureSchema();
    const columns = await executor.select<{ name: string }>("PRAGMA table_info(history_tasks)");
    // 补的列接在旧表末尾，所以升级后的库和新库的列序不同（源项目也一样）；按列名访问不受影响
    expect(columns.slice(13).map((column) => column.name)).toEqual([...ADDED_LATER]);
    expect(new Set(columns.map((column) => column.name))).toEqual(new Set(ALL_COLUMNS));
    const tasks = await store.getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: "old-1",
      ref_images: "C:\\pics\\a.png",
      duration: null,
      seed: null,
      ref_audios: null,
      first_frame: null,
      last_frame: null,
      ref_videos: null,
    });
    executor.close();
  });
});

describe("history records", () => {
  it("adds a running task and only overwrites fields that are given", async () => {
    const { store, executor } = open();
    await store.ensureSchema();
    tick(1);
    const created = stamp();
    const added = await store.addTask({
      id: "task-1",
      prompt: "a cat",
      model: "wan-3.0",
      aspectRatio: "16:9",
      imageSize: "720p",
      refImages: ["C:\\in\\a.png", "C:\\in\\b.png"],
      duration: 7,
      seed: 123,
      refAudios: ["C:\\in\\a.mp3"],
      firstFrame: "C:\\in\\first.png",
    });
    expect(added).toMatchObject({
      status: "running",
      created_at: created,
      updated_at: created,
      result_path: null,
      preview_url: null,
      last_frame: null,
    });

    tick(2);
    const failedAt = stamp();
    const updated = await store.updateTask("task-1", "failed", {
      failureReason: "output_moderation",
      errorMessage: "nope",
    });
    expect(updated).toMatchObject({
      status: "failed",
      failure_reason: "output_moderation",
      error_message: "nope",
      updated_at: failedAt,
      duration: 7,
      seed: 123,
      ref_images: ["C:\\in\\a.png", "C:\\in\\b.png"],
      ref_audios: ["C:\\in\\a.mp3"],
      first_frame: "C:\\in\\first.png",
    });

    tick(3);
    // 空值不覆盖已有内容，与源项目一致
    const again = await store.updateTask("task-1", "succeeded", {
      failureReason: "",
      errorMessage: null,
      resultPath: "C:\\out\\grsai_x.png",
      previewUrl: "https://cdn/x.png",
    });
    expect(again).toMatchObject({
      status: "succeeded",
      failure_reason: "output_moderation",
      error_message: "nope",
      result_path: "C:\\out\\grsai_x.png",
      preview_url: "https://cdn/x.png",
    });

    expect(await store.updateTask("missing", "failed")).toBeNull();

    // 两列整数在库里真的是整数
    const raw = await executor.select<{ duration: unknown; seed: unknown; typeof: unknown }>(
      "SELECT duration, seed, typeof(duration) AS typeof FROM history_tasks WHERE id = 'task-1'",
    );
    expect(raw[0]).toEqual({ duration: 7, seed: 123, typeof: "integer" });
    executor.close();
  });

  it("pages through the newest first, breaking ties by id", async () => {
    const { store, executor } = open();
    // task-1 建于 2026-11-24 23:59:14
    const createdAt = ["2026-11-20 10:00:00", "2026-11-24 09:00:00", "2026-11-24 09:00:00", "2026-11-22 09:00:00"];
    for (const [index, created] of createdAt.entries()) {
      await executor.execute(
        "INSERT INTO history_tasks (id, prompt, model, aspect_ratio, image_size, status, created_at, updated_at) VALUES (?, 'p', 'm', 'auto', '1K', 'failed', ?, ?)",
        [`page-${index}`, created, created],
      );
    }
    expect(await store.getTaskCount()).toBe(5);
    const ids = async (page: number, size: number) => (await store.getTasksPage(page, size)).map((task) => task.id);
    expect(await ids(1, 2)).toEqual(["task-1", "page-2"]);
    expect(await ids(2, 2)).toEqual(["page-1", "page-3"]);
    expect(await ids(3, 2)).toEqual(["page-0"]);
    expect(await ids(4, 2)).toEqual([]);
    // 页码和每页数量至少是 1
    expect(await ids(0, 0)).toEqual(["task-1"]);
    expect((await store.getAllTasks()).map((task) => task.id)).toEqual(["task-1", "page-2", "page-1", "page-3", "page-0"]);
    executor.close();
  });

  it("clears by status and reports how many went away", async () => {
    const { store, executor } = open();
    expect(await store.clearRunningTasks()).toBe(0);
    expect(await store.clearViolationTasks()).toBe(0);
    expect(await store.clearFailedTasks()).toBe(4);
    expect(await store.getTaskCount()).toBe(1);
    expect(await store.clearAllTasks()).toBe(1);
    expect(await store.getTaskCount()).toBe(0);
    // 清理之后表还在，可以继续写
    await store.addTask({ id: "after-clear", prompt: "p", model: "m", aspectRatio: "auto", imageSize: "1K" });
    expect(await store.getTaskCount()).toBe(1);
    executor.close();
  });
});

describe("legacy history.json migration", () => {
  const pathOf = (name: string) => join(workDir, name);
  const writeLegacy = (name: string, content: string) => writeFile(pathOf(name), content, "utf8");
  const listWorkDir = async () => (await readdir(workDir)).sort();

  it("does nothing when there is no legacy file", async () => {
    const { store, executor } = open();
    await store.ensureSchema();
    await store.migrateLegacyJson();
    expect(await store.getTaskCount()).toBe(1);
    executor.close();
  });

  it("imports history.json, then renames it to .bak", async () => {
    await writeLegacy(
      LEGACY_HISTORY_FILE,
      JSON.stringify([
        {
          id: "legacy-1",
          prompt: "first",
          model: "nano-banana",
          status: "succeeded",
          created_at: "2025-05-06 07:08:09",
          ref_images: "C:\\old.png",
          result_path: "C:\\old.png",
        },
        { id: "legacy-2", prompt: "second", model: "gpt-image-2" },
        { prompt: "no id, skipped" },
        "not even an object",
      ]),
    );
    const { store, executor } = open();
    await store.ensureSchema();
    tick(10);
    const stamped = stamp();
    await store.migrateLegacyJson();
    const byId = Object.fromEntries((await store.getAllTasks()).map((task) => [task.id, task]));
    expect(byId["legacy-1"]).toMatchObject({
      prompt: "first",
      aspect_ratio: "auto",
      image_size: "1K",
      status: "succeeded",
      created_at: "2025-05-06 07:08:09",
      updated_at: stamped,
      ref_images: "C:\\old.png",
      result_path: "C:\\old.png",
    });
    expect(byId["legacy-2"]).toMatchObject({ status: "running", created_at: stamped });
    expect(Object.keys(byId).some((id) => id.includes("no id"))).toBe(false);

    const files = await listWorkDir();
    expect(files).toContain(`${LEGACY_HISTORY_FILE}.bak`);
    expect(files).not.toContain(LEGACY_HISTORY_FILE);
    // 再跑一遍不会重复导入
    await store.migrateLegacyJson();
    expect(await store.getTaskCount()).toBe(3);
    executor.close();
  });

  it("prefers grsai_history.json over history.json and replaces an old .bak", async () => {
    await writeFile(pathOf(`${OLD_HISTORY_FILE}.bak`), "stale", "utf8");
    await writeLegacy(OLD_HISTORY_FILE, JSON.stringify([{ id: "old-file", prompt: "from old file", model: "m" }]));
    await writeLegacy(LEGACY_HISTORY_FILE, JSON.stringify([{ id: "legacy-ignored", prompt: "ignored", model: "m" }]));
    const { store, executor } = open();
    await store.migrateLegacyJson();
    const ids = (await store.getAllTasks()).map((task) => task.id);
    expect(ids).toContain("old-file");
    expect(ids).not.toContain("legacy-ignored");
    // grsai_history.json 先迁并改名，history.json 原样留到下一次
    const files = await listWorkDir();
    expect(files).not.toContain(OLD_HISTORY_FILE);
    expect(files).toContain(LEGACY_HISTORY_FILE);
    expect(await readFile(pathOf(`${OLD_HISTORY_FILE}.bak`), "utf8")).toContain("from old file");
    executor.close();
  });

  it("leaves broken or empty files alone", async () => {
    await rm(pathOf(LEGACY_HISTORY_FILE), { force: true });
    await writeLegacy(LEGACY_HISTORY_FILE, "{ not json");
    const { store, executor } = open();
    const before = await store.getTaskCount();
    await store.migrateLegacyJson();
    expect(await store.getTaskCount()).toBe(before);
    expect(await listWorkDir()).toContain(LEGACY_HISTORY_FILE);

    await writeLegacy(LEGACY_HISTORY_FILE, "[]");
    await store.migrateLegacyJson();
    expect(await listWorkDir()).toContain(LEGACY_HISTORY_FILE);
    executor.close();
  });

  it("uses the same file name as the source project", () => {
    expect(HISTORY_DB_FILE).toBe("grsai_history.db");
  });
});
