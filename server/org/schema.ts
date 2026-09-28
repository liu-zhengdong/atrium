import type { DatabaseSync } from "node:sqlite";
import { ensurePointTables } from "./points.ts";
import { ensureAspectColumns } from "./aspects.ts";
import { ensureMaterialTables } from "../materials/store.ts";

/** All org tables are additive and safe to create on every service start. */
export function ensureOrgTables(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS org_nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER REFERENCES org_nodes(id),
    kind TEXT NOT NULL CHECK(kind IN ('org','project','module','concern')),
    slug TEXT NOT NULL, name TEXT NOT NULL, leader TEXT, doc_path TEXT,
    archived_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(parent_id,slug));
  CREATE UNIQUE INDEX IF NOT EXISTS org_single_root ON org_nodes((1)) WHERE parent_id IS NULL;
  CREATE TABLE IF NOT EXISTS org_node_repos (
    node_id INTEGER NOT NULL REFERENCES org_nodes(id), repo TEXT NOT NULL,
    PRIMARY KEY(node_id,repo));
  CREATE TABLE IF NOT EXISTS org_docs (
    node_id INTEGER NOT NULL REFERENCES org_nodes(id),
    doc TEXT NOT NULL CHECK(doc IN ('charter','card')),
    rev INTEGER NOT NULL, fields TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(node_id,doc));
  CREATE TABLE IF NOT EXISTS org_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id INTEGER NOT NULL REFERENCES org_nodes(id),
    target TEXT NOT NULL CHECK(target IN ('node','charter','card')),
    rev INTEGER NOT NULL, author TEXT NOT NULL, at INTEGER NOT NULL,
    reason TEXT NOT NULL, snapshot TEXT NOT NULL,
    UNIQUE(node_id,target,rev));
  CREATE INDEX IF NOT EXISTS org_revisions_node ON org_revisions(node_id,id);
  CREATE TABLE IF NOT EXISTS org_boundaries (
    node_id INTEGER NOT NULL REFERENCES org_nodes(id),
    bid TEXT NOT NULL, pos INTEGER NOT NULL,
    summary TEXT NOT NULL, detail TEXT,
    param_key TEXT CHECK(param_key IN ('quota_reserve_percent','disk_min_free_gb','money_yuan_max')),
    param_value REAL,
    CHECK((param_key IS NULL) = (param_value IS NULL)),
    PRIMARY KEY(node_id,bid));`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS org_revisions_no_update
    BEFORE UPDATE ON org_revisions BEGIN SELECT RAISE(ABORT,'org_revisions append only'); END;
  CREATE TRIGGER IF NOT EXISTS org_revisions_no_delete
    BEFORE DELETE ON org_revisions BEGIN SELECT RAISE(ABORT,'org_revisions append only'); END;
  CREATE TRIGGER IF NOT EXISTS org_nodes_no_delete
    BEFORE DELETE ON org_nodes BEGIN SELECT RAISE(ABORT,'org_nodes archive only'); END;`);
  ensurePointTables(db);
  ensureAspectColumns(db);
  // 资料挂在节点上（t192）：随组织树一起建，派活附清单时表一定在。
  ensureMaterialTables(db);
}
