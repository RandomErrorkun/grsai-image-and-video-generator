import { describe, expect, it } from "vitest";
import type { SqlExecutor } from "../core/history";
import { nodeSqliteExecutor } from "../testing/nodeSqlite";
import { createMemoryDatabase } from "./memoryDb";

/** 与 history.ts 里的建表语句逐字相同；那边没有导出，这里照抄一份。 */
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
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    result_path TEXT,
    preview_url TEXT,
    failure_reason TEXT,
    error_message TEXT,
    updated_at TEXT NOT NULL
)`;

/** 源项目最早那版表，还没有视频任务的那几列。 */
const OLD_TABLE = `CREATE TABLE IF NOT EXISTS history_tasks (
    id TEXT PRIMARY KEY, prompt TEXT NOT NULL, model TEXT NOT NULL, aspect_ratio TEXT NOT NULL,
    image_size TEXT NOT NULL, ref_images TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL,
    result_path TEXT, preview_url TEXT, failure_reason TEXT, error_message TEXT, updated_at TEXT NOT NULL
)`;

/** history.ts 插任务用的语句。 */
const INSERT_TASK =
  "INSERT OR REPLACE INTO history_tasks (id, prompt, model, aspect_ratio, image_size, ref_images," +
  " duration, seed, ref_audios, first_frame, last_frame, ref_videos, status, created_at, result_path," +
  " preview_url, failure_reason, error_message, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

const PAGE = "SELECT * FROM history_tasks ORDER BY created_at DESC, id DESC";
const COUNT = "SELECT COUNT(1) AS cnt FROM history_tasks";
const PRAGMA = "PRAGMA table_info(history_tasks)";

/** 建好表的空库。 */
async function withTable(): Promise<SqlExecutor> {
  const db = createMemoryDatabase();
  await db.execute(CREATE_TABLE);
  return db;
}

/** 用内存库认的那种 INSERT 插一行，没写的列不给。 */
function insertRow(db: SqlExecutor, values: Record<string, unknown>) {
  const columns = Object.keys(values);
  return db.execute(
    `INSERT OR REPLACE INTO history_tasks (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    Object.values(values),
  );
}

/** 列名按建表的顺序。 */
async function columnNames(db: SqlExecutor): Promise<string[]> {
  const columns = await db.select<{ name: string }>(PRAGMA);
  return columns.map((column) => column.name);
}

/** 按列的顺序补齐一整行，没给值的列是 null。 */
function wholeRow(names: string[], values: Record<string, unknown>) {
  return Object.fromEntries(names.map((name) => [name, values[name] ?? null]));
}

/** 分页查询里各行的 id；不给 limit 就取全部。 */
async function pageIds(db: SqlExecutor, limit?: number, offset = 0): Promise<string[]> {
  const rows =
    limit === undefined
      ? await db.select<{ id: string }>(PAGE)
      : await db.select<{ id: string }>(`${PAGE} LIMIT ? OFFSET ?`, [limit, offset]);
  return rows.map((row) => row.id);
}

/**
 * 五行样本，故意不按结果顺序插入，免得稳定排序碰巧蒙对：A 最新，b、a、B 同一时刻，c 最早。
 * 同刻的三行只能靠按 id 比大小分出先后，而且大小写不同也算不同。
 */
const SAMPLE: ReadonlyArray<readonly [id: string, createdAt: string]> = [
  ["B", "2026-11-24 09:00:00"],
  ["c", "2026-11-20 09:00:00"],
  ["a", "2026-11-24 09:00:00"],
  ["A", "2026-11-25 09:00:00"],
  ["b", "2026-11-24 09:00:00"],
];
async function seedSample(db: SqlExecutor) {
  for (const [id, createdAt] of SAMPLE) await insertRow(db, { id, created_at: createdAt });
}

describe("schema statements", () => {
  it("reads the columns off the definition text, whatever the case and spacing", async () => {
    const db = createMemoryDatabase();
    expect(
      await db.execute(
        "  create table if not exists HISTORY_TASKS\n ( seq integer primary key not null ,\n\n note varchar(40) , flag , amount decimal(10, 5) )  ",
      ),
    ).toEqual({ rowsAffected: 0 });
    // 类型照 SQLite 的规矩回报：恰好是 integer 的那个统一成大写，其余照原样，没写类型的就是空串
    expect(await db.select("pragma table_info( history_tasks )")).toEqual([
      { cid: 0, name: "seq", type: "INTEGER", notnull: 1, dflt_value: null, pk: 1 },
      { cid: 1, name: "note", type: "varchar(40)", notnull: 0, dflt_value: null, pk: 0 },
      { cid: 2, name: "flag", type: "", notnull: 0, dflt_value: null, pk: 0 },
      { cid: 3, name: "amount", type: "decimal(10, 5)", notnull: 0, dflt_value: null, pk: 0 },
    ]);
  });

  it("leaves the table alone when it exists already", async () => {
    const db = await withTable();
    const names = await columnNames(db);
    expect(names).toHaveLength(19);
    await insertRow(db, { id: "kept", prompt: "still here" });
    expect(await db.execute("CREATE TABLE IF NOT EXISTS history_tasks (something_else TEXT)")).toEqual({
      rowsAffected: 0,
    });
    expect(await columnNames(db)).toEqual(names);
    expect(await db.select<{ prompt: string }>("SELECT * FROM history_tasks WHERE id = ?", ["kept"])).toEqual([
      expect.objectContaining({ prompt: "still here" }),
    ]);
  });

  it("reports nothing for a table that is not there", async () => {
    expect(await createMemoryDatabase().select(PRAGMA)).toEqual([]);
  });

  it("adds a column at the end; rows that were already there read null for it", async () => {
    const db = createMemoryDatabase();
    await db.execute(OLD_TABLE);
    await insertRow(db, { id: "old-1", status: "succeeded" });
    expect(await db.execute("alter table history_tasks add column duration integer")).toEqual({
      rowsAffected: 0,
    });
    await insertRow(db, { id: "new-1", status: "running", duration: 5 });
    const columns = await db.select<{ cid: number; name: string }>(PRAGMA);
    expect(columns.map((column) => column.name).slice(13)).toEqual(["duration"]);
    expect(await db.select(PRAGMA)).toEqual([
      { cid: 0, name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { cid: 1, name: "prompt", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { cid: 2, name: "model", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { cid: 3, name: "aspect_ratio", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { cid: 4, name: "image_size", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { cid: 5, name: "ref_images", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { cid: 6, name: "status", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { cid: 7, name: "created_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { cid: 8, name: "result_path", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { cid: 9, name: "preview_url", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { cid: 10, name: "failure_reason", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { cid: 11, name: "error_message", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { cid: 12, name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { cid: 13, name: "duration", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
    ]);
    const names = columns.map((column) => column.name);
    expect(await db.select("SELECT * FROM history_tasks WHERE id = ?", ["old-1"])).toEqual([
      wholeRow(names, { id: "old-1", status: "succeeded" }),
    ]);
    expect(await db.select("SELECT * FROM history_tasks WHERE id = ?", ["new-1"])).toEqual([
      wholeRow(names, { id: "new-1", status: "running", duration: 5 }),
    ]);
  });

  it("refuses to add a column that is already there", async () => {
    const db = await withTable();
    await expect(db.execute("ALTER TABLE history_tasks ADD COLUMN duration INTEGER")).rejects.toThrow(
      "duplicate column name: duration",
    );
  });

  it("treats CREATE INDEX and VACUUM as no-ops", async () => {
    const db = await withTable();
    await insertRow(db, { id: "a" });
    expect(
      await db.execute("CREATE INDEX IF NOT EXISTS idx_history_created_at ON history_tasks(created_at DESC)"),
    ).toEqual({ rowsAffected: 0 });
    expect(await db.execute("VACUUM")).toEqual({ rowsAffected: 0 });
    expect(await db.select(COUNT)).toEqual([{ cnt: 1 }]);
  });

  it("refuses column definitions it cannot represent", async () => {
    const definitions = [
      "n INTEGER DEFAULT 0",
      "n TEXT UNIQUE",
      "n text check(n > 0)",
      "id INTEGER PRIMARY KEY AUTOINCREMENT",
      '"n" TEXT',
    ];
    for (const definition of definitions) {
      const sql = `CREATE TABLE IF NOT EXISTS history_tasks (id TEXT PRIMARY KEY, ${definition})`;
      await expect(createMemoryDatabase().execute(sql)).rejects.toThrow(
        `memory database does not support: ${sql}`,
      );
    }
  });
});

describe("writing rows", () => {
  it("inserts a row; columns that were not given stay null and keys follow the column order", async () => {
    const db = await withTable();
    expect(await insertRow(db, { id: "task-1", prompt: "a cat", model: "wan-3.0", duration: 7 })).toEqual({
      rowsAffected: 1,
    });
    const rows = await db.select<Record<string, unknown>>("SELECT * FROM history_tasks WHERE id = ?", ["task-1"]);
    const names = await columnNames(db);
    expect(rows).toEqual([wholeRow(names, { id: "task-1", prompt: "a cat", model: "wan-3.0", duration: 7 })]);
    expect(Object.keys(rows[0])).toEqual(names);
  });

  it("replaces the row with the same primary key as a whole row", async () => {
    const db = await withTable();
    await insertRow(db, { id: "task-1", prompt: "first", model: "nano-banana", status: "running" });
    await insertRow(db, { id: "task-2", prompt: "other", status: "running" });
    // REPLACE 是把旧行换成新行：这次没给的列回到 null，不是只改给出来的那几列
    expect(
      await insertRow(db, { id: "task-1", prompt: "second", status: "succeeded", result_path: "C:\\out\\a.png" }),
    ).toEqual({ rowsAffected: 1 });
    expect(await db.select(COUNT)).toEqual([{ cnt: 2 }]);
    const names = await columnNames(db);
    expect(await db.select("SELECT * FROM history_tasks WHERE id = ?", ["task-1"])).toEqual([
      wholeRow(names, { id: "task-1", prompt: "second", status: "succeeded", result_path: "C:\\out\\a.png" }),
    ]);
    expect(await db.select("SELECT * FROM history_tasks WHERE id = ?", ["task-2"])).toEqual([
      wholeRow(names, { id: "task-2", prompt: "other", status: "running" }),
    ]);
  });

  it("stores the bound values as they are", async () => {
    const db = await withTable();
    const numbers = { id: "numbers", duration: 0, seed: 2147483648, ref_images: "", ref_audios: '["C:\\in\\a.mp3"]' };
    const text = { id: "text", seed: "123", aspect_ratio: "16:9" };
    await insertRow(db, numbers);
    await insertRow(db, text);
    const names = await columnNames(db);
    expect(await db.select("SELECT * FROM history_tasks WHERE id = ?", ["numbers"])).toEqual([
      wholeRow(names, numbers),
    ]);
    // 看着像数字的文本不会被转成数字
    expect(await db.select("SELECT * FROM history_tasks WHERE id = ?", ["text"])).toEqual([
      wholeRow(names, text),
    ]);
  });

  it("treats an undefined bound value as null", async () => {
    const db = await withTable();
    await db.execute("INSERT OR REPLACE INTO history_tasks (id, prompt, model) VALUES (?, ?, ?)", ["a", "p", undefined]);
    const rows = await db.select<{ prompt: unknown; model: unknown }>(
      "SELECT * FROM history_tasks WHERE id = ?",
      ["a"],
    );
    expect(rows[0].prompt).toBe("p");
    expect(rows[0].model).toBeNull();
  });

  it("does not care about case in table and column names, but does in values", async () => {
    const db = await withTable();
    await db.execute("insert or replace into HISTORY_TASKS (Id, PROMPT, Status) values (?, ?, ?)", [
      "t",
      "p",
      "running",
    ]);
    const names = await columnNames(db);
    const expected = wholeRow(names, { id: "t", prompt: "p", status: "running" });
    // 键用的是建表时的大小写
    expect(await db.select("SELECT * FROM History_Tasks WHERE ID = ?", ["t"])).toEqual([expected]);
    // 值按 BINARY 规则比，大小写不同就是不同
    expect(await db.select("SELECT * FROM History_Tasks WHERE ID = ?", ["T"])).toEqual([]);
  });

  it("updates the row with that id and counts it even when nothing differs", async () => {
    const db = await withTable();
    await insertRow(db, { id: "task-1", status: "running", updated_at: "t1" });
    await insertRow(db, { id: "task-2", status: "running", updated_at: "t1" });
    expect(
      await db.execute("UPDATE history_tasks SET status = ?, updated_at = ?, result_path = ? WHERE id = ?", [
        "succeeded",
        "t2",
        "C:\\out\\x.png",
        "task-1",
      ]),
    ).toEqual({ rowsAffected: 1 });
    // SQLite 数的是命中的行，值没变也算一行
    expect(await db.execute("UPDATE history_tasks SET status = ? WHERE id = ?", ["succeeded", "task-1"])).toEqual({
      rowsAffected: 1,
    });
    expect(await db.execute("UPDATE history_tasks SET status = ? WHERE id = ?", ["failed", "missing"])).toEqual({
      rowsAffected: 0,
    });
    const names = await columnNames(db);
    expect(await db.select("SELECT * FROM history_tasks WHERE id = ?", ["task-1"])).toEqual([
      wholeRow(names, { id: "task-1", status: "succeeded", updated_at: "t2", result_path: "C:\\out\\x.png" }),
    ]);
    expect(await db.select("SELECT * FROM history_tasks WHERE id = ?", ["task-2"])).toEqual([
      wholeRow(names, { id: "task-2", status: "running", updated_at: "t1" }),
    ]);
  });

  it("returns nothing for an id that is not there", async () => {
    const db = await withTable();
    expect(await db.select("SELECT * FROM history_tasks WHERE id = ?", ["nope"])).toEqual([]);
  });

  it("hands out a fresh object every time, so changing a result leaves the stored row alone", async () => {
    const db = await withTable();
    await insertRow(db, { id: "a", prompt: "before" });
    const rows = await db.select<Record<string, unknown>>("SELECT * FROM history_tasks WHERE id = ?", ["a"]);
    rows[0].prompt = "after";
    rows.length = 0;
    expect(await db.select<{ prompt: string }>("SELECT * FROM history_tasks WHERE id = ?", ["a"])).toEqual([
      expect.objectContaining({ prompt: "before" }),
    ]);
  });
});

describe("reading rows", () => {
  it("sorts newest first, breaks ties by id, and tells upper case from lower", async () => {
    const db = await withTable();
    await seedSample(db);
    // BINARY 排序里大写排在小写前面，倒过来就是 b、a、B
    expect(await pageIds(db)).toEqual(["A", "b", "a", "B", "c"]);
  });

  it("pages with LIMIT and OFFSET", async () => {
    const db = await withTable();
    await seedSample(db);
    expect(await pageIds(db, 2, 0)).toEqual(["A", "b"]);
    expect(await pageIds(db, 2, 2)).toEqual(["a", "B"]);
    expect(await pageIds(db, 2, 4)).toEqual(["c"]);
    expect(await pageIds(db, 2, 5)).toEqual([]);
    // 负的 LIMIT 不设上限，负的 OFFSET 按 0 算
    expect(await pageIds(db, -1, 3)).toEqual(["B", "c"]);
    expect(await pageIds(db, 2, -1)).toEqual(["A", "b"]);
  });

  it("counts the rows", async () => {
    const db = await withTable();
    expect(await db.select(COUNT)).toEqual([{ cnt: 0 }]);
    await insertRow(db, { id: "a" });
    await insertRow(db, { id: "b" });
    expect(await db.select(COUNT)).toEqual([{ cnt: 2 }]);
  });
});

describe("deleting rows", () => {
  it("deletes the rows with that status and says how many", async () => {
    const db = await withTable();
    await insertRow(db, { id: "a", status: "failed" });
    await insertRow(db, { id: "b", status: "succeeded" });
    await insertRow(db, { id: "c", status: "failed" });
    expect(await db.execute("DELETE FROM history_tasks WHERE status = ?", ["failed"])).toEqual({ rowsAffected: 2 });
    expect(await db.execute("DELETE FROM history_tasks WHERE status = ?", ["failed"])).toEqual({ rowsAffected: 0 });
    expect(await pageIds(db)).toEqual(["b"]);
  });

  it("deletes everything and leaves the table in place", async () => {
    const db = await withTable();
    await insertRow(db, { id: "a" });
    await insertRow(db, { id: "b" });
    expect(await db.execute("DELETE FROM history_tasks")).toEqual({ rowsAffected: 2 });
    expect(await db.execute("DELETE FROM history_tasks")).toEqual({ rowsAffected: 0 });
    await insertRow(db, { id: "c" });
    expect(await db.select(COUNT)).toEqual([{ cnt: 1 }]);
  });
});

describe("statements it does not know", () => {
  it("throws and names the statement", async () => {
    const db = await withTable();
    const statements = [
      "DROP TABLE history_tasks",
      "SELECT * FROM other_table",
      "SELECT * FROM history_tasks WHERE status = ?",
      "SELECT * FROM history_tasks ORDER BY created_at DESC",
      "SELECT * FROM history_tasks ORDER BY created_at DESC, id DESC LIMIT 5",
      "SELECT name FROM sqlite_master WHERE type = 'index'",
      "CREATE TABLE history_tasks (id TEXT PRIMARY KEY)",
      "ALTER TABLE history_tasks DROP COLUMN duration",
      "INSERT INTO history_tasks (id) VALUES (?)",
      "INSERT OR REPLACE INTO history_tasks (id) VALUES (1)",
      "UPDATE history_tasks SET status = 'failed' WHERE id = ?",
      "UPDATE history_tasks SET status = ? WHERE status = ?",
      "DELETE FROM history_tasks WHERE id = ?",
    ];
    for (const sql of statements) {
      await expect(db.execute(sql)).rejects.toThrow(`memory database does not support: ${sql}`);
      await expect(db.select(sql)).rejects.toThrow(`memory database does not support: ${sql}`);
    }
  });

  it("throws like SQLite when the table or a column is missing", async () => {
    const empty = createMemoryDatabase();
    await expect(empty.select(COUNT)).rejects.toThrow("no such table: history_tasks");
    await expect(empty.execute(COUNT)).rejects.toThrow("no such table: history_tasks");
    await expect(empty.execute("DELETE FROM history_tasks")).rejects.toThrow("no such table: history_tasks");

    const db = await withTable();
    await expect(insertRow(db, { nope: 1 })).rejects.toThrow("table history_tasks has no column named nope");
    await expect(db.execute("UPDATE history_tasks SET nope = ? WHERE id = ?", [1, "x"])).rejects.toThrow(
      "table history_tasks has no column named nope",
    );
  });
});

describe("agreement with SQLite", () => {
  it("gives the same answers as node:sqlite for the statements the history store issues", async () => {
    const sqlite = nodeSqliteExecutor(":memory:");
    const memory = createMemoryDatabase();
    const refImages = JSON.stringify(["C:\\in\\a.png"]);
    const refAudios = JSON.stringify(["C:\\in\\a.mp3"]);
    // 先是一张旧版本的表，再照 ensureSchema 的顺序补列、建索引，之后是任务流程里的读写
    const steps: Array<[sql: string, params?: unknown[]]> = [
      [OLD_TABLE],
      [PRAGMA],
      [
        "INSERT OR REPLACE INTO history_tasks (id, prompt, model, aspect_ratio, image_size, ref_images, status," +
          " created_at, result_path, preview_url, failure_reason, error_message, updated_at)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          "old-1",
          "p",
          "nano-banana",
          "auto",
          "1K",
          JSON.stringify("C:\\pics\\a.png"),
          "succeeded",
          "2026-01-02 03:04:05",
          null,
          null,
          null,
          null,
          "2026-01-02 03:04:05",
        ],
      ],
      ["ALTER TABLE history_tasks ADD COLUMN duration INTEGER"],
      ["ALTER TABLE history_tasks ADD COLUMN seed INTEGER"],
      ["ALTER TABLE history_tasks ADD COLUMN ref_audios TEXT"],
      ["ALTER TABLE history_tasks ADD COLUMN first_frame TEXT"],
      ["ALTER TABLE history_tasks ADD COLUMN last_frame TEXT"],
      ["ALTER TABLE history_tasks ADD COLUMN ref_videos TEXT"],
      [PRAGMA],
      [CREATE_TABLE],
      ["CREATE INDEX IF NOT EXISTS idx_history_created_at ON history_tasks(created_at DESC)"],
      [
        INSERT_TASK,
        [
          "task-1",
          "a cat",
          "wan-3.0",
          "16:9",
          "720p",
          refImages,
          7,
          123,
          refAudios,
          null,
          null,
          null,
          "running",
          "2026-11-24 23:58:10",
          null,
          null,
          null,
          null,
          "2026-11-24 23:58:10",
        ],
      ],
      // 与下面的 task-2 同一时刻，id 只差大小写，而且先插入：先后只能靠按 id 比大小分出来
      [
        INSERT_TASK,
        [
          "Task-2",
          "a cow",
          "gpt-image-2",
          "1:1",
          "1536x1024",
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          "succeeded",
          "2026-11-24 09:00:00",
          null,
          null,
          null,
          null,
          "2026-11-24 09:00:05",
        ],
      ],
      [
        INSERT_TASK,
        [
          "task-2",
          "a dog",
          "gpt-image-2",
          "1:1",
          "1536x1024",
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          "failed",
          "2026-11-24 09:00:00",
          null,
          null,
          "output_moderation",
          "nope",
          "2026-11-24 09:00:05",
        ],
      ],
      [
        // 只给必填的列：真 SQLite 不许漏 NOT NULL 列，这样两边才跑的是同一条合法语句
        "INSERT OR REPLACE INTO history_tasks (id, prompt, model, aspect_ratio, image_size, status, created_at," +
          " updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ["task-1", "a cat again", "wan-3.0", "16:9", "720p", "running", "2026-11-24 23:58:10", "2026-11-24 23:58:12"],
      ],
      ["UPDATE history_tasks SET status = ?, updated_at = ? WHERE id = ?", ["succeeded", "2026-11-24 23:58:15", "task-1"]],
      ["UPDATE history_tasks SET status = ?, updated_at = ? WHERE id = ?", ["succeeded", "2026-11-24 23:58:15", "task-1"]],
      [
        "UPDATE history_tasks SET status = ?, updated_at = ?, result_path = ?, preview_url = ? WHERE id = ?",
        ["failed", "2026-11-24 23:58:20", "C:\\out\\x.png", "https://cdn/x.png", "missing"],
      ],
      ["SELECT * FROM history_tasks WHERE id = ?", ["task-1"]],
      [PAGE],
      [`${PAGE} LIMIT ? OFFSET ?`, [1, 1]],
      [`${PAGE} LIMIT ? OFFSET ?`, [5, 10]],
      [COUNT],
      ["DELETE FROM history_tasks WHERE status = ?", ["failed"]],
      ["DELETE FROM history_tasks WHERE status = ?", ["failed"]],
      ["DELETE FROM history_tasks"],
      ["DELETE FROM history_tasks"],
      [PAGE],
      [PRAGMA],
      ["VACUUM"],
    ];
    try {
      for (const [sql, params = []] of steps) {
        if (/^(SELECT|PRAGMA)\b/i.test(sql)) {
          expect(await memory.select(sql, params), sql).toEqual(await sqlite.select(sql, params));
        } else if (/^(UPDATE|DELETE)\b/i.test(sql)) {
          expect(await memory.execute(sql, params), sql).toEqual(await sqlite.execute(sql, params));
        } else {
          // 行数只在 UPDATE 和 DELETE 上比：应用只读这两处的 rowsAffected。其余写语句后面
          // SQLite 报的是上一个写语句留下的旧计数，应用不读它，所以只核对是个数字
          const result = await memory.execute(sql, params);
          expect(typeof result.rowsAffected, sql).toBe("number");
          await sqlite.execute(sql, params);
        }
      }
    } finally {
      sqlite.close();
    }
  });
});
