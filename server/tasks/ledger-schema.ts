import type { DatabaseSync } from "node:sqlite";
import { all } from "./ledger-model.ts";
import { ensureQueueTable } from "./queue.ts";
import { repairScheduleRecords } from "./schedule-recovery.ts";
import { ensureUpstreamPrTable } from "./schedule-upstream.ts";
import { ensureUsageTable } from "./usage.ts";

export function ensureTaskTables(db: DatabaseSync) {
  // 排队表随账本建好：列表与排期要读排队原因，不能等任务运行时起来。
  ensureQueueTable(db);
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
  // 组织树第 3 步（#264）：谁来做（记在谁的账上）、谁投的；指向 org_nodes.id，旧任务留空，经 org link-roles 显式回填。
  if (!columns.some((column) => column.name === "node_id"))
    db.exec("ALTER TABLE tasks ADD COLUMN node_id INTEGER");
  if (!columns.some((column) => column.name === "origin_node_id"))
    db.exec("ALTER TABLE tasks ADD COLUMN origin_node_id INTEGER");
  // 目标树（#313）：任务挂在哪个里程碑上，指向 goals.id；表与校验在 server/goals/。
  if (!columns.some((column) => column.name === "goal_id"))
    db.exec("ALTER TABLE tasks ADD COLUMN goal_id INTEGER");
  db.exec("CREATE INDEX IF NOT EXISTS tasks_goal ON tasks(goal_id,status)");
  // 全景图（#322）：任务归属哪一部分，指向 org_nodes.id；旧 goal_id 由目标树迁移按目标的负责节点回填。
  if (!columns.some((column) => column.name === "part_id"))
    db.exec("ALTER TABLE tasks ADD COLUMN part_id INTEGER");
  db.exec("CREATE INDEX IF NOT EXISTS tasks_part ON tasks(part_id,status)");
  db.exec(
    "CREATE INDEX IF NOT EXISTS tasks_node ON tasks(node_id,status); CREATE INDEX IF NOT EXISTS tasks_origin_node ON tasks(origin_node_id,status)",
  );
  db.exec(`CREATE TABLE IF NOT EXISTS task_dependencies (
    task_id INTEGER NOT NULL REFERENCES tasks(id), after_id INTEGER NOT NULL REFERENCES tasks(id),
    PRIMARY KEY(task_id,after_id));
    CREATE INDEX IF NOT EXISTS task_dependencies_after ON task_dependencies(after_id,task_id);
    CREATE TABLE IF NOT EXISTS task_pr_dependencies (
    task_id INTEGER NOT NULL REFERENCES tasks(id), repo TEXT NOT NULL, number INTEGER NOT NULL,
    merged INTEGER NOT NULL DEFAULT 0, checked_at INTEGER, error TEXT,
    PRIMARY KEY(task_id,repo,number));`);
  ensureUpstreamPrTable(db);
  repairScheduleRecords(db);
  ensureUsageTable(db);
}
