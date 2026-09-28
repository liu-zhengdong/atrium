import type { DatabaseSync, SQLInputValue } from "node:sqlite";

/** SQLite 的小工具：各模块共用，只在这里定义。 */
export const one = <T>(
  db: DatabaseSync,
  sql: string,
  ...args: SQLInputValue[]
) => db.prepare(sql).get(...args) as T | undefined;
export const all = <T>(
  db: DatabaseSync,
  sql: string,
  ...args: SQLInputValue[]
) => db.prepare(sql).all(...args) as T[];
export const hasTable = (db: DatabaseSync, name: string) =>
  !!one(
    db,
    "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?",
    name,
  );
export const hasColumn = (db: DatabaseSync, table: string, column: string) =>
  all<{ name: string }>(db, `PRAGMA table_info(${table})`).some(
    (c) => c.name === column,
  );
/** 参数化 IN 列表的占位符。 */
export const marks = (list: readonly unknown[]) =>
  list.map(() => "?").join(",");
