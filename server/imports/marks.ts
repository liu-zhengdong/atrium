import type { DatabaseSync } from "node:sqlite";

/**
 * 旧状态导入的记号（#355）：每类导入做完记一行，重复启动不再导入，也不再读旧文件。
 * 表名不与旧运行时遗留的表重名；旧表不读不写。
 */

export type ImportName = "task_briefs" | "charter_budget" | "rules_into_points";

export type ImportMark = { name: string; done_at: number; detail: string };

export function ensureImportMarks(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS state_imports (
    name TEXT PRIMARY KEY, done_at INTEGER NOT NULL, detail TEXT NOT NULL)`);
}

export function importMark(
  db: DatabaseSync,
  name: ImportName,
): ImportMark | undefined {
  return db
    .prepare("SELECT name,done_at,detail FROM state_imports WHERE name=?")
    .get(name) as ImportMark | undefined;
}

export function markImported(
  db: DatabaseSync,
  name: ImportName,
  detail: string,
  now = Date.now(),
) {
  db.prepare(
    "INSERT OR IGNORE INTO state_imports(name,done_at,detail) VALUES(?,?,?)",
  ).run(name, now, detail);
}
