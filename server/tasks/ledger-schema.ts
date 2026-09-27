import type { DatabaseSync } from "node:sqlite";
import { all } from "./ledger-model.ts";
import { repairScheduleRecords } from "./schedule-recovery.ts";

export function ensureTaskTables(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_id INTEGER REFERENCES tasks(id),
      title TEXT NOT NULL,
      brief_path TEXT,
      role TEXT,
      repo TEXT,
      deliver TEXT NOT NULL DEFAULT 'pr' CHECK(deliver IN ('pr','comment','none')),
      issue INTEGER,
      status TEXT NOT NULL CHECK(status IN ('todo','running','done','failed','blocked','cancelled')),
      worker TEXT,
      pid INTEGER, worktree TEXT, branch TEXT,
      pr_url TEXT, ci TEXT,
      result TEXT,
      created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_id,id);
    CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status,id);
    CREATE TABLE IF NOT EXISTS task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL,
      at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT);
    CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id,id);`);
  // 负责人（事件订阅者）是后加的列：老库补上，缺省交给秘书。
  const columns = all<{ name: string }>(db, "PRAGMA table_info(tasks)");
  if (!columns.some((column) => column.name === "owner"))
    db.exec("ALTER TABLE tasks ADD COLUMN owner TEXT");
  if (!columns.some((column) => column.name === "deliver"))
    db.exec(
      "ALTER TABLE tasks ADD COLUMN deliver TEXT NOT NULL DEFAULT 'pr' CHECK(deliver IN ('pr','comment','none'))",
    );
  if (!columns.some((column) => column.name === "issue"))
    db.exec("ALTER TABLE tasks ADD COLUMN issue INTEGER");
  if (!columns.some((column) => column.name === "auto"))
    db.exec(
      "ALTER TABLE tasks ADD COLUMN auto INTEGER NOT NULL DEFAULT 0 CHECK(auto IN (0,1))",
    );
  if (!columns.some((column) => column.name === "auto_dispatched"))
    db.exec(
      "ALTER TABLE tasks ADD COLUMN auto_dispatched INTEGER NOT NULL DEFAULT 0 CHECK(auto_dispatched IN (0,1))",
    );
  if (!columns.some((column) => column.name === "schedule_state"))
    db.exec("ALTER TABLE tasks ADD COLUMN schedule_state TEXT");
  if (!columns.some((column) => column.name === "schedule_reason"))
    db.exec("ALTER TABLE tasks ADD COLUMN schedule_reason TEXT");
  db.exec(`CREATE TABLE IF NOT EXISTS task_dependencies (
    task_id INTEGER NOT NULL REFERENCES tasks(id), after_id INTEGER NOT NULL REFERENCES tasks(id),
    PRIMARY KEY(task_id,after_id));
    CREATE INDEX IF NOT EXISTS task_dependencies_after ON task_dependencies(after_id,task_id);
    CREATE TABLE IF NOT EXISTS task_pr_dependencies (
    task_id INTEGER NOT NULL REFERENCES tasks(id), repo TEXT NOT NULL, number INTEGER NOT NULL,
    merged INTEGER NOT NULL DEFAULT 0, checked_at INTEGER, error TEXT,
    PRIMARY KEY(task_id,repo,number));`);
  repairScheduleRecords(db);
}
