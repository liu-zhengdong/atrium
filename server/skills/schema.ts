import type { DatabaseSync } from "node:sqlite";
import { ensureOrgTables } from "../org/schema.ts";

/**
 * 组织技能的表（#264 第 3b 步）：当前版在 org_skills，修订只追加，绑定挂在节点上。
 * 都是新增表，每次服务启动都可以安全执行；旧版留下的 org_skill_proposals 不读不写。
 */
export function ensureSkillTables(db: DatabaseSync) {
  ensureOrgTables(db);
  db.exec(`CREATE TABLE IF NOT EXISTS org_skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL,
    owner_node_id INTEGER REFERENCES org_nodes(id),
    rev INTEGER NOT NULL, files TEXT NOT NULL,
    archived_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS org_skill_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id INTEGER NOT NULL REFERENCES org_skills(id),
    rev INTEGER NOT NULL, author TEXT NOT NULL, reviewer TEXT, at INTEGER NOT NULL,
    reason TEXT NOT NULL, source TEXT, snapshot TEXT NOT NULL,
    UNIQUE(skill_id,rev));
  CREATE TABLE IF NOT EXISTS org_skill_bindings (
    skill_id INTEGER NOT NULL REFERENCES org_skills(id),
    node_id INTEGER NOT NULL REFERENCES org_nodes(id),
    created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY(skill_id,node_id));
  CREATE INDEX IF NOT EXISTS org_skill_bindings_node ON org_skill_bindings(node_id);`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS org_skill_revisions_no_update
    BEFORE UPDATE ON org_skill_revisions BEGIN SELECT RAISE(ABORT,'org_skill_revisions append only'); END;
  CREATE TRIGGER IF NOT EXISTS org_skill_revisions_no_delete
    BEFORE DELETE ON org_skill_revisions BEGIN SELECT RAISE(ABORT,'org_skill_revisions append only'); END;
  CREATE TRIGGER IF NOT EXISTS org_skills_no_delete
    BEFORE DELETE ON org_skills BEGIN SELECT RAISE(ABORT,'org_skills archive only'); END;`);
}
