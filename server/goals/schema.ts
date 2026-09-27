import type { DatabaseSync } from "node:sqlite";

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
}
