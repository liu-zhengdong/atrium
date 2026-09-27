import type { DatabaseSync } from "node:sqlite";
import {
  all,
  one,
  transaction,
  type DocRow,
  type NodeRow,
} from "../org/model.ts";
import { nodePoints } from "../org/points.ts";
import { ownBoundaries } from "../org/boundary-store.ts";
import { formatParam } from "../org/boundaries.ts";
import { createJobRole, editJobRole, getJobRole } from "./job-roles.ts";

export const specialistMigrationAction = (node: {
  id: number;
  name: string;
}) =>
  (node.id === 6 && node.name === "安全") ||
  (node.id === 7 && node.name === "质量")
    ? ("retire" as const)
    : ("convert" as const);

/** 旧关注点只作一次迁移；专员继续沿用 rN 与 job_roles，交付记录无需改号。 */
export function migrateSpecialists(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS specialist_migration_quarantine (
    id INTEGER PRIMARY KEY AUTOINCREMENT, node_id INTEGER NOT NULL,
    snapshot TEXT NOT NULL, error TEXT NOT NULL, at INTEGER NOT NULL);`);
  const legacy = all<NodeRow>(
    db,
    "SELECT * FROM org_nodes WHERE kind='concern' AND archived_at IS NULL ORDER BY id LIMIT 500",
  );
  for (const node of legacy) {
    try {
      transaction(db, () => migrateOne(db, node));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      db.prepare(
        "INSERT INTO specialist_migration_quarantine(node_id,snapshot,error,at) VALUES(?,?,?,?)",
      ).run(node.id, JSON.stringify(node), message, Date.now());
      console.error(`专员迁移：o${node.id} 已隔离：${message}`);
    }
  }
}

function quarantineRows(
  db: DatabaseSync,
  table: "task_concerns" | "council_members",
  nodeId: number,
  reason: string,
  now: number,
  duplicateWith?: number,
) {
  let after = 0;
  for (;;) {
    const rows = all<{ task_id: number } & Record<string, unknown>>(
      db,
      `SELECT * FROM ${table} WHERE node_id=? AND task_id>?
       ${duplicateWith === undefined ? "" : `AND task_id IN (SELECT task_id FROM ${table} WHERE node_id=?)`}
       ORDER BY task_id LIMIT 200`,
      ...(duplicateWith === undefined
        ? [nodeId, after]
        : [nodeId, after, duplicateWith]),
    );
    if (!rows.length) return;
    for (const row of rows)
      db.prepare(
        "INSERT INTO specialist_migration_quarantine(node_id,snapshot,error,at) VALUES(?,?,?,?)",
      ).run(nodeId, JSON.stringify({ table, row }), reason, now);
    after = rows.at(-1)!.task_id;
  }
}

function migrateOne(db: DatabaseSync, node: NodeRow) {
  const now = Date.now();
  // u1 明确撤销的两个示例关注点：要点留给 Atrium，审查邀请记录移入隔离表。
  if (specialistMigrationAction(node) === "retire") {
    const target = one<{ id: number }>(
      db,
      "SELECT id FROM org_nodes WHERE id=2 AND archived_at IS NULL",
    );
    if (!target) throw new Error("找不到接收要点的 o2 Atrium");
    const targetFirst = one<{ n: number }>(
      db,
      "SELECT COALESCE(MIN(pos),0) n FROM org_points WHERE node_id=?",
      target.id,
    )!.n;
    const sourceLast = one<{ n: number }>(
      db,
      "SELECT COALESCE(MAX(pos),0) n FROM org_points WHERE node_id=?",
      node.id,
    )!.n;
    db.prepare(
      "UPDATE org_points SET node_id=?,pos=pos+?,updated_at=? WHERE node_id=?",
    ).run(target.id, targetFirst - sourceLast - 1, now, node.id);
    for (const table of ["task_concerns", "council_members"] as const) {
      quarantineRows(db, table, node.id, "撤销示例专员的旧邀请", now);
      db.prepare(`DELETE FROM ${table} WHERE node_id=?`).run(node.id);
    }
    db.prepare(
      "UPDATE org_nodes SET archived_at=?,updated_at=? WHERE id=?",
    ).run(now, now, node.id);
    return;
  }
  const doc = one<DocRow>(
    db,
    "SELECT * FROM org_docs WHERE node_id=? AND doc='charter'",
    node.id,
  );
  const fields = doc ? (JSON.parse(doc.fields) as Record<string, unknown>) : {};
  const goal = typeof fields.goal === "string" ? fields.goal.trim() : "";
  const points = nodePoints(db, node.id).map((point) => ({
    ref: point.ref,
    text: point.text,
    why: point.why,
  }));
  const bottom = ownBoundaries(db, node.id).map(
    (b) => `${b.summary}${b.param ? `：${formatParam(b.param)}` : ""}`,
  );
  const invite_when = Array.isArray(fields.invite_when)
    ? fields.invite_when.filter((x): x is string => typeof x === "string")
    : [];
  const hasSkills = one(
    db,
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='org_skill_bindings'",
  );
  const boundSkills = hasSkills
    ? all<{ slug: string }>(
        db,
        `SELECT s.slug FROM org_skill_bindings b JOIN org_skills s ON s.id=b.skill_id
          WHERE b.node_id=? AND s.archived_at IS NULL ORDER BY s.slug LIMIT 20`,
        node.id,
      ).map((row) => row.slug)
    : [];
  let specialist;
  try {
    specialist = getJobRole(db, node.name);
  } catch {
    specialist = undefined;
  }
  const data = {
    review_goal: goal,
    review_points: points,
    review_bottom: bottom,
    invite_when,
    skills: [...new Set([...(specialist?.skills ?? []), ...boundSkills])],
  };
  specialist = specialist
    ? editJobRole(db, specialist.ref, data, now)
    : createJobRole(
        db,
        {
          name: node.name,
          description: goal || node.name,
          body: doc?.body?.trim() || goal || node.name,
          ...data,
        },
        now,
      );
  const id = -specialist.id;
  // 重复邀请以新专员行优先；旧行的全部内容先留在隔离表供人工核查。
  for (const table of ["task_concerns", "council_members"] as const) {
    quarantineRows(db, table, node.id, "重复邀请，保留新专员记录", now, id);
    db.prepare(
      `DELETE FROM ${table} WHERE node_id=? AND task_id IN (SELECT task_id FROM ${table} WHERE node_id=?)`,
    ).run(node.id, id);
    db.prepare(`UPDATE ${table} SET node_id=? WHERE node_id=?`).run(
      id,
      node.id,
    );
  }
  db.prepare(
    `UPDATE tasks SET job_id=?,role=NULL,node_id=NULL
    WHERE job_id IS NULL AND id IN (
      SELECT review_id FROM task_concerns WHERE node_id=? AND review_id IS NOT NULL
      UNION SELECT opinion_id FROM council_members WHERE node_id=?)`,
  ).run(specialist.id, id, id);
  db.prepare("UPDATE org_nodes SET archived_at=?,updated_at=? WHERE id=?").run(
    now,
    now,
    node.id,
  );
}
