/**
 * 内存里的历史库，给浏览器 mock 用：单独跑 npm run dev 调界面时不需要 Tauri。
 *
 * 只认 history.ts 发出来的那几种语句（空白随意），别的写法一律报错：
 * 免得 core/ 里添了新 SQL 而这里没跟上时，mock 一声不响地给出不对的结果。
 * 行为照 SQLite 来，绑定的值原样存取，不做类型转换。
 */
import type { SqlExecutor } from "../core/history";

interface Column {
  name: string;
  /** 建表时写的类型，只用来回报给 PRAGMA；存值的时候不看它。 */
  type: string;
  notNull: boolean;
  primaryKey: boolean;
}

/** 一行按列的顺序存成数组，补列时在末尾添 null；每次查询再拼成按列名的对象。 */
type Row = unknown[];

interface Result {
  rows: Array<Record<string, unknown>>;
  rowsAffected: number;
}

/** 正则都开了 i：关键字、表名、列名不分大小写。 */
const STATEMENTS = {
  createTable: /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(history_tasks|usage_events)\s*\(([\s\S]*)\)$/i,
  tableInfo: /^PRAGMA\s+table_info\s*\(\s*(history_tasks|usage_events)\s*\)$/i,
  addColumn: /^ALTER\s+TABLE\s+(history_tasks|usage_events)\s+ADD\s+COLUMN\s+(.+)$/i,
  createIndex: /^CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+.+$/i,
  insert: /^INSERT\s+OR\s+(?:REPLACE|IGNORE)\s+INTO\s+(history_tasks|usage_events)\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)$/i,
  update: /^UPDATE\s+history_tasks\s+SET\s+(.+?)\s+WHERE\s+id\s*=\s*\?$/i,
  selectById: /^SELECT\s+\*\s+FROM\s+history_tasks\s+WHERE\s+id\s*=\s*\?$/i,
  selectPage:
    /^SELECT\s+\*\s+FROM\s+history_tasks\s+ORDER\s+BY\s+created_at\s+DESC\s*,\s*id\s+DESC(\s+LIMIT\s+\?\s+OFFSET\s+\?)?$/i,
  selectUsageEvents:
    /^SELECT\s+\*\s+FROM\s+usage_events\s+ORDER\s+BY\s+created_at\s+DESC\s*,\s*task_id\s+DESC$/i,
  count: /^SELECT\s+COUNT\s*\(\s*1\s*\)\s+AS\s+cnt\s+FROM\s+history_tasks$/i,
  deleteAll: /^DELETE\s+FROM\s+history_tasks$/i,
  deleteByStatus: /^DELETE\s+FROM\s+history_tasks\s+WHERE\s+status\s*=\s*\?$/i,
  deleteById: /^DELETE\s+FROM\s+history_tasks\s+WHERE\s+id\s*=\s*\?$/i,
  vacuum: /^VACUUM$/i,
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\?$/;

/** 列定义里约束的起头词，类型名到这儿为止。后面紧跟括号的也算，比如 check(n > 0)。 */
const CONSTRAINT_HEAD =
  /^(PRIMARY|NOT|NULL|UNIQUE|CHECK|REFERENCES|COLLATE|CONSTRAINT|DEFAULT|GENERATED)(?![A-Za-z0-9_])/i;
/** SQLite 报类型时只把恰好是这五个词的类型名统一成大写，其余照原样。 */
const KEYWORD_TYPE = /^(int|integer|text|real|blob)$/i;

const unsupported = (sql: string) => new Error(`memory database does not support: ${sql}`);

/** 按最外层的逗号切开，括号里的逗号（比如 DECIMAL(10, 5)）不算。 */
function splitByComma(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

/**
 * 解析一列的定义：名字，可选的类型，后面可以跟 PRIMARY KEY 和 NOT NULL。
 * 别的约束（DEFAULT、UNIQUE 这些）内存库表示不了，按不支持的语句报错。
 */
function parseColumn(definition: string, sql: string): Column {
  const [name = "", ...words] = definition.split(/\s+/);
  if (!IDENTIFIER.test(name)) throw unsupported(sql);
  const cut = words.findIndex((word) => CONSTRAINT_HEAD.test(word));
  const type = (cut === -1 ? words : words.slice(0, cut)).join(" ");
  const constraints = cut === -1 ? [] : words.slice(cut);
  const column: Column = {
    name,
    type: KEYWORD_TYPE.test(type) ? type.toUpperCase() : type,
    notNull: false,
    primaryKey: false,
  };
  // 约束都是两个词一组：PRIMARY KEY、NOT NULL
  for (let index = 0; index < constraints.length; index += 2) {
    const pair = constraints.slice(index, index + 2).join(" ").toUpperCase();
    if (pair === "PRIMARY KEY") column.primaryKey = true;
    else if (pair === "NOT NULL") column.notNull = true;
    else throw unsupported(sql);
  }
  return column;
}

/** SQLite 比较两个值先看存储类：NULL 最小，其次是数字，文本最大；同类再比大小。 */
function classRank(value: unknown): number {
  if (value === null) return 0;
  return typeof value === "number" ? 1 : 2;
}

/**
 * 文本按默认的 BINARY 排序规则比，也就是区分大小写的逐字节比较；
 * ASCII 范围内它与 JS 的字符串比较结果相同，id 和时间戳都落在这个范围里。
 */
function compareValues(left: unknown, right: unknown): number {
  const byClass = classRank(left) - classRank(right);
  if (byClass !== 0) return byClass;
  return left === right ? 0 : (left as string | number) < (right as string | number) ? -1 : 1;
}

export function createMemoryDatabase(): SqlExecutor {
  const tables = new Map<string, { schema: Column[]; rows: Row[] }>();

  /** 除了建表、PRAGMA 和 VACUUM，其余语句都要求表已经在了，与 SQLite 一样。 */
  function needTable(tableName = "history_tasks"): { schema: Column[]; rows: Row[] } {
    const entry = tables.get(tableName.toLowerCase());
    if (!entry) throw new Error(`no such table: ${tableName}`);
    return entry;
  }

  /** 列名不分大小写地找；找不到时照 SQLite 的原话报错。 */
  function columnIndex(name: string, table: Column[], tableName = "history_tasks"): number {
    const index = table.findIndex(
      (column) => column.name.toLowerCase() === name.toLowerCase(),
    );
    if (index === -1) throw new Error(`table ${tableName} has no column named ${name}`);
    return index;
  }

  /** 真插件里参数要经 IPC 序列化，undefined 到了那边就是 null。 */
  function bind(value: unknown): unknown {
    return value === undefined ? null : value;
  }

  /** SQL 的等号碰上 NULL 永远不成立。 */
  function isEqual(value: unknown, expected: unknown): boolean {
    return expected !== null && value === expected;
  }

  /** 每次查询都重新拼对象，调用方改了查询结果，不会动到库里的行。 */
  function toObjects(table: Column[], selected: Row[]): Array<Record<string, unknown>> {
    return selected.map((row) =>
      Object.fromEntries(
        table.map((column, index): [string, unknown] => [column.name, row[index]]),
      ),
    );
  }

  /** 按条件删行，回报删掉了多少行。 */
  function remove(rows: Row[], shouldRemove: (row: Row) => boolean): Result {
    let rowsAffected = 0;
    for (let index = rows.length - 1; index >= 0; index--) {
      if (shouldRemove(rows[index])) {
        rows.splice(index, 1);
        rowsAffected += 1;
      }
    }
    return { rows: [], rowsAffected };
  }

  function run(sql: string, params: unknown[]): Result {
    const text = sql.trim();
    let match: RegExpExecArray | null;

    if ((match = STATEMENTS.createTable.exec(text)) !== null) {
      const name = match[1].toLowerCase();
      if (!tables.has(name)) {
        tables.set(name, {
          schema: splitByComma(match[2]).map((part) => parseColumn(part, sql)),
          rows: [],
        });
      }
      return { rows: [], rowsAffected: 0 };
    }
    if ((match = STATEMENTS.tableInfo.exec(text)) !== null) {
      const columns = tables.get(match[1].toLowerCase())?.schema ?? [];
      return {
        rows: columns.map((column, cid) => ({
          cid,
          name: column.name,
          type: column.type,
          notnull: column.notNull ? 1 : 0,
          dflt_value: null,
          pk: column.primaryKey ? 1 : 0,
        })),
        rowsAffected: 0,
      };
    }
    if ((match = STATEMENTS.addColumn.exec(text)) !== null) {
      const entry = needTable(match[1]);
      const column = parseColumn(match[2], sql);
      const taken = entry.schema.some(
        (existing) => existing.name.toLowerCase() === column.name.toLowerCase(),
      );
      if (taken) throw new Error(`duplicate column name: ${column.name}`);
      entry.schema.push(column);
      for (const row of entry.rows) row.push(null);
      return { rows: [], rowsAffected: 0 };
    }
    if (STATEMENTS.createIndex.test(text)) {
      // 排序每次都是现排的，用不着索引
      needTable();
      return { rows: [], rowsAffected: 0 };
    }
    if ((match = STATEMENTS.insert.exec(text)) !== null) {
      const ignore = /^INSERT\s+OR\s+IGNORE\b/i.test(text);
      const tableName = match[1].toLowerCase();
      const entry = needTable(tableName);
      const table = entry.schema;
      const names = match[2].split(",").map((name) => name.trim());
      const places = match[3].split(",").map((place) => place.trim());
      if (places.some((place) => place !== "?")) throw unsupported(sql);
      const row: Row = table.map(() => null);
      names.forEach((name, position) => {
        row[columnIndex(name, table, tableName)] = bind(params[position]);
      });
      const key = table.findIndex((column) => column.primaryKey);
      const existing =
        key === -1 || row[key] === null
          ? -1
          : entry.rows.findIndex((other) => other[key] === row[key]);
      if (existing !== -1) {
        if (ignore) return { rows: [], rowsAffected: 0 };
        entry.rows.splice(existing, 1);
      }
      entry.rows.push(row);
      return { rows: [], rowsAffected: 1 };
    }
    if ((match = STATEMENTS.update.exec(text)) !== null) {
      const entry = needTable("history_tasks");
      const table = entry.schema;
      const sets: Array<[number, unknown]> = splitByComma(match[1]).map((part, position) => {
        const assignment = ASSIGNMENT.exec(part);
        if (!assignment) throw unsupported(sql);
        return [columnIndex(assignment[1], table), bind(params[position])];
      });
      const where = columnIndex("id", table);
      const key = bind(params[sets.length]);
      let rowsAffected = 0;
      for (const row of entry.rows) {
        if (!isEqual(row[where], key)) continue;
        for (const [index, value] of sets) row[index] = value;
        rowsAffected += 1;
      }
      return { rows: [], rowsAffected };
    }
    if (STATEMENTS.selectById.test(text)) {
      const entry = needTable("history_tasks");
      const where = columnIndex("id", entry.schema);
      const key = bind(params[0]);
      return { rows: toObjects(entry.schema, entry.rows.filter((row) => isEqual(row[where], key))), rowsAffected: 0 };
    }
    if ((match = STATEMENTS.selectPage.exec(text)) !== null) {
      const entry = needTable("history_tasks");
      const table = entry.schema;
      const createdAt = columnIndex("created_at", table);
      const id = columnIndex("id", table);
      const sorted = [...entry.rows].sort(
        (left, right) =>
          compareValues(right[createdAt], left[createdAt]) || compareValues(right[id], left[id]),
      );
      let page = sorted;
      if (match[1]) {
        const limit = Number(params[0]);
        const offset = Math.max(Number(params[1]), 0);
        page = sorted.slice(offset, limit < 0 ? undefined : offset + limit);
      }
      return { rows: toObjects(table, page), rowsAffected: 0 };
    }
    if (STATEMENTS.selectUsageEvents.test(text)) {
      const entry = needTable("usage_events");
      const table = entry.schema;
      const createdAt = columnIndex("created_at", table, "usage_events");
      const taskId = columnIndex("task_id", table, "usage_events");
      const sorted = [...entry.rows].sort(
        (left, right) =>
          compareValues(right[createdAt], left[createdAt]) || compareValues(right[taskId], left[taskId]),
      );
      return { rows: toObjects(table, sorted), rowsAffected: 0 };
    }
    if (STATEMENTS.count.test(text)) {
      const entry = needTable("history_tasks");
      return { rows: [{ cnt: entry.rows.length }], rowsAffected: 0 };
    }
    if (STATEMENTS.deleteByStatus.test(text)) {
      const entry = needTable("history_tasks");
      const where = columnIndex("status", entry.schema);
      const key = bind(params[0]);
      return remove(entry.rows, (row) => isEqual(row[where], key));
    }
    if (STATEMENTS.deleteById.test(text)) {
      const entry = needTable("history_tasks");
      const where = columnIndex("id", entry.schema);
      const key = bind(params[0]);
      return remove(entry.rows, (row) => isEqual(row[where], key));
    }
    if (STATEMENTS.deleteAll.test(text)) {
      const entry = needTable("history_tasks");
      return remove(entry.rows, () => true);
    }
    if (STATEMENTS.vacuum.test(text)) return { rows: [], rowsAffected: 0 };
    throw unsupported(sql);
  }

  return {
    async select<T>(sql: string, params: unknown[] = []) {
      return run(sql, params).rows as T[];
    },
    async execute(sql: string, params: unknown[] = []) {
      return { rowsAffected: run(sql, params).rowsAffected };
    },
  };
}
