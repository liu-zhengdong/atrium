import type { DatabaseSync } from "node:sqlite";
import { all } from "../org/model.ts";

/**
 * 目标树（#313）：顶层目标（parent_id 为空）与多层里程碑。不留修订记录（u1 定），只记最后改动人与时间。
 * 节点只增不删，短号 gN 全局一致、不复用；放弃用状态表达。任务挂里程碑的列 tasks.goal_id 由任务账本建。
 */
export function ensureGoalTables(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER REFERENCES goals(id),
    result TEXT NOT NULL,
    criteria TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL CHECK(status IN ('planned','active','achieved','blocked','dropped')),
    note TEXT,
    node_id INTEGER NOT NULL,
    due TEXT,
    updated_by TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS goals_parent ON goals(parent_id,id);
  CREATE TABLE IF NOT EXISTS goal_dependencies (
    goal_id INTEGER NOT NULL REFERENCES goals(id), after_id INTEGER NOT NULL REFERENCES goals(id),
    PRIMARY KEY(goal_id,after_id));
  CREATE INDEX IF NOT EXISTS goal_dependencies_after ON goal_dependencies(after_id,goal_id);
  CREATE TRIGGER IF NOT EXISTS goals_no_delete
    BEFORE DELETE ON goals BEGIN SELECT RAISE(ABORT,'goals drop only'); END;`);
  // 第 2 步（达成判定）：命令型验收在哪个仓库跑（绝对路径，可空）；每次判定一行，只增不删。
  if (
    !all<{ name: string }>(db, "PRAGMA table_info(goals)").some(
      (c) => c.name === "repo",
    )
  )
    db.exec("ALTER TABLE goals ADD COLUMN repo TEXT");
  db.exec(`CREATE TABLE IF NOT EXISTS goal_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id INTEGER NOT NULL REFERENCES goals(id),
    criterion TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('command','manual')),
    result TEXT NOT NULL CHECK(result IN ('running','pass','fail','timeout','error')),
    exit_code INTEGER, summary TEXT, note TEXT, log TEXT,
    owner INTEGER,
    actor TEXT NOT NULL,
    started_at INTEGER NOT NULL, ended_at INTEGER);
  CREATE INDEX IF NOT EXISTS goal_checks_goal ON goal_checks(goal_id,id);
  CREATE INDEX IF NOT EXISTS goal_checks_running ON goal_checks(result) WHERE result='running';`);
  // 全景图（#322）：目标树迁为节点阶段记录后下线。goal_migrations 记每个 gN 迁到哪个节点（任务 --goal gN 照此映射），
  // goal_retirement 只有一行，有它就表示已迁移、goal 命令下线；goals 表原样保留，便于核对与回滚。
  db.exec(`CREATE TABLE IF NOT EXISTS goal_migrations (
    goal_id INTEGER PRIMARY KEY REFERENCES goals(id),
    node_id INTEGER NOT NULL, at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS goal_retirement (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    at INTEGER NOT NULL, actor TEXT NOT NULL, backup TEXT);`);
}
