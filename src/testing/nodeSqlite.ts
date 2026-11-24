import { DatabaseSync } from "node:sqlite";
import type { SqlExecutor } from "../core/history";

/**
 * node:sqlite 的执行器，单测里顶替 plugin-sql。
 * 绑定方式与插件一致：数字按浮点绑定，落进 INTEGER 列时由 SQLite 自己转成整数。
 */
export function nodeSqliteExecutor(path: string): SqlExecutor & { close(): void } {
  const db = new DatabaseSync(path);
  return {
    async select<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
    async execute(sql: string, params: unknown[] = []) {
      return { rowsAffected: Number(db.prepare(sql).run(...(params as never[])).changes) };
    },
    close() {
      db.close();
    },
  };
}
