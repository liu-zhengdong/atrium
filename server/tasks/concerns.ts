import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { nodeByAddress, ref, type DocRow, type NodeRow } from "../org/model.ts";
import { hasOrg } from "../org/task-node.ts";
import { nodePoints } from "../org/points.ts";
import { ownBoundaries } from "../org/boundary-store.ts";
import { formatParam } from "../org/boundaries.ts";
import { getJobRole, listJobRoles } from "./job-roles.ts";
import { all, one, taskRef, usage } from "./ledger-model.ts";
import {
  inviteHints,
  type Checklist,
  type ConcernState,
  type InviteHint,
  type InviteRule,
  type Verdict,
} from "./concern-gate.ts";

/**
 * 任务请了哪些专员（#322 第 2 步）：`task_concerns` 一行一位，指向关注点节点；
 * review_id 是本轮的专员审查任务，verdict / reason 是它的结论（没出为 null），decided_at 为落结论的时刻。
 * 这里只读写账；判定在 concern-gate.ts，派审查任务、补判父任务在 concern-runtime.ts。
 */

export const CONCERNS_MAX = 5;
export const specialistId = (id: number) => -id;
export const specialistRef = (id: number) => (id < 0 ? `r${-id}` : ref(id));

export type ConcernRow = {
  task_id: number;
  node_id: number;
  pos: number;
  review_id: number | null;
  verdict: Verdict | null;
  reason: string | null;
  decided_at: number | null;
};

export function ensureConcernTable(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_concerns (
    task_id INTEGER NOT NULL REFERENCES tasks(id), node_id INTEGER NOT NULL,
    pos INTEGER NOT NULL, review_id INTEGER, verdict TEXT CHECK(verdict IN ('pass','veto','none')),
    reason TEXT, decided_at INTEGER,
    PRIMARY KEY(task_id,node_id));
  CREATE INDEX IF NOT EXISTS task_concerns_review ON task_concerns(review_id);`);
}

/** 旧 --concern 兼容专员名称与未迁移的关注点节点；空值表示都不请。 */
export function concernsFor(db: DatabaseSync, value: unknown): number[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value !== "string")
    throw usage("concern: 应为专员名称或 rN，多个用逗号分隔");
  const names = value
    .split(/[,，、]/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!names.length) return [];
  if (names.length > CONCERNS_MAX)
    throw usage(`concern: 一个任务至多请 ${CONCERNS_MAX} 位专员`);
  const ids: number[] = [];
  for (const name of names) {
    try {
      const id = specialistId(getJobRole(db, name).id);
      if (!ids.includes(id)) ids.push(id);
      continue;
    } catch (error) {
      if (!(error instanceof Problem) || error.statusCode !== 404) throw error;
    }
    if (!hasOrg(db))
      throw usage("concern: 专员不存在；请先用 atrium specialist add 创建");
    let node: NodeRow;
    try {
      node = nodeByAddress(db, name);
    } catch (error) {
      if (error instanceof Problem)
        throw new Problem(
          400,
          `concern: ${error.message}`,
          "usage",
          error.candidates,
          "atrium org tree",
        );
      throw error;
    }
    if (node.kind !== "concern")
      throw new Problem(
        400,
        `concern: 只能请关注点（专员）节点，${ref(node.id)} ${node.name} 不是`,
        "usage",
        undefined,
        "atrium org tree",
      );
    if (node.archived_at !== null)
      throw usage(`concern: 专员已归档：${ref(node.id)} ${node.name}`);
    if (!ids.includes(node.id)) ids.push(node.id);
  }
  return ids;
}

/** 新写法只认组织共用的专员名单。旧 --concern 仍走关注点节点兼容路径。 */
export function specialistsFor(db: DatabaseSync, value: unknown): number[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value !== "string")
    throw usage("ask: 应为专员名称或 rN，多个用逗号分隔");
  const names = value
    .split(/[,，、]/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (names.length > CONCERNS_MAX)
    throw usage(`ask: 一个任务至多请 ${CONCERNS_MAX} 位专员`);
  return [
    ...new Set(names.map((name) => specialistId(getJobRole(db, name).id))),
  ];
}

/** 在调用方的事务里改请的专员：去掉的删行，保留的原样（含本轮审查结论），新请的追加。 */
export function writeConcerns(db: DatabaseSync, taskId: number, ids: number[]) {
  const current = all<ConcernRow>(
    db,
    "SELECT * FROM task_concerns WHERE task_id=? ORDER BY pos LIMIT 50",
    taskId,
  );
  for (const row of current)
    if (!ids.includes(row.node_id))
      db.prepare("DELETE FROM task_concerns WHERE task_id=? AND node_id=?").run(
        taskId,
        row.node_id,
      );
  ids.forEach((id, pos) => {
    if (current.some((row) => row.node_id === id))
      db.prepare(
        "UPDATE task_concerns SET pos=? WHERE task_id=? AND node_id=?",
      ).run(pos, taskId, id);
    else
      db.prepare(
        "INSERT INTO task_concerns(task_id,node_id,pos) VALUES(?,?,?)",
      ).run(taskId, id, pos);
  });
}

export function concernRows(db: DatabaseSync, taskId: number): ConcernRow[] {
  return all<ConcernRow>(
    db,
    "SELECT * FROM task_concerns WHERE task_id=? ORDER BY pos LIMIT 50",
    taskId,
  );
}

/** 各任务请的专员与本轮结论（看板与任务详情用）；组织表不在时为空。 */
export function concernStates(
  db: DatabaseSync,
  ids: readonly number[],
): Map<number, ConcernState[]> {
  const map = new Map<number, ConcernState[]>();
  if (!ids.length) return map;
  const org = hasOrg(db);
  const rows = all<ConcernRow & { name: string; review_status: string | null }>(
    db,
    `SELECT c.*, ${org ? "COALESCE(s.name,n.name)" : "s.name"} AS name, r.status AS review_status
       FROM task_concerns c ${org ? "LEFT JOIN org_nodes n ON n.id=c.node_id AND c.node_id>0" : ""}
       LEFT JOIN job_roles s ON s.id=-c.node_id AND c.node_id<0
       LEFT JOIN tasks r ON r.id=c.review_id
      WHERE c.task_id IN (${ids.map(() => "?").join(",")})
      ORDER BY c.task_id, c.pos LIMIT 1000`,
    ...ids,
  );
  for (const row of rows) {
    const list = map.get(row.task_id) ?? [];
    list.push({
      ref: specialistRef(row.node_id),
      name: row.name,
      review: row.review_id === null ? null : taskRef(row.review_id),
      review_status: row.review_status,
      verdict: row.verdict,
      reason: row.reason,
    });
    map.set(row.task_id, list);
  }
  return map;
}

export const concernsOf = (db: DatabaseSync, taskId: number) =>
  concernStates(db, [taskId]).get(taskId) ?? [];

/** 这个任务是某任务本轮的专员审查任务。 */
export function reviewRow(db: DatabaseSync, reviewId: number) {
  return one<ConcernRow>(
    db,
    "SELECT * FROM task_concerns WHERE review_id=? LIMIT 1",
    reviewId,
  );
}

/** 本轮还有审查没出结论（父任务在等专员）。 */
export function awaitingReview(db: DatabaseSync, taskId: number) {
  return !!one(
    db,
    "SELECT 1 FROM task_concerns WHERE task_id=? AND review_id IS NOT NULL AND verdict IS NULL LIMIT 1",
    taskId,
  );
}

const charterFields = (db: DatabaseSync, id: number) => {
  const doc = one<DocRow>(
    db,
    "SELECT * FROM org_docs WHERE node_id=? AND doc='charter'",
    id,
  );
  try {
    return doc ? (JSON.parse(doc.fields) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** 专员的清单：章程目标、本节点要点、本节点自己的硬边界（底线）。 */
export function checklistOf(db: DatabaseSync, nodeId: number): Checklist {
  if (nodeId < 0) {
    const specialist = getJobRole(db, `r${-nodeId}`);
    return {
      ref: specialist.ref,
      name: specialist.name,
      goal: specialist.review_goal || specialist.description,
      points: specialist.review_points,
      bottom: specialist.review_bottom,
    };
  }
  const node = one<NodeRow>(db, "SELECT * FROM org_nodes WHERE id=?", nodeId);
  const goal = charterFields(db, nodeId).goal;
  return {
    ref: ref(nodeId),
    name: node?.name ?? ref(nodeId),
    goal: typeof goal === "string" ? goal.trim().replace(/[。.]+$/, "") : "",
    points: nodePoints(db, nodeId).map((p) => ({
      ref: p.ref,
      text: p.text,
      why: p.why,
    })),
    bottom: ownBoundaries(db, nodeId).map(
      (b) => `${b.summary}${b.param ? `：${formatParam(b.param)}` : ""}`,
    ),
  };
}

export function checklists(db: DatabaseSync, taskId: number): Checklist[] {
  return concernRows(db, taskId).map((row) => checklistOf(db, row.node_id));
}

/** 各关注点章程里的 invite_when 规则（没归档的关注点才算）。 */
export function inviteRules(db: DatabaseSync): InviteRule[] {
  const specialists = listJobRoles(db)
    .filter((role) => role.invite_when.length)
    .map((role) => ({
      ref: role.ref,
      name: role.name,
      when: role.invite_when,
    }));
  if (!hasOrg(db)) return specialists;
  return [
    ...specialists,
    ...all<NodeRow & { fields: string }>(
      db,
      `SELECT n.*, d.fields AS fields FROM org_nodes n JOIN org_docs d ON d.node_id=n.id AND d.doc='charter'
      WHERE n.kind='concern' AND n.archived_at IS NULL ORDER BY n.id LIMIT 500`,
    ).flatMap((row) => {
      let when: unknown;
      try {
        when = (JSON.parse(row.fields) as { invite_when?: unknown })
          .invite_when;
      } catch {
        return [];
      }
      return Array.isArray(when) && when.length
        ? [
            {
              ref: ref(row.id),
              name: row.name,
              when: when.filter((w): w is string => typeof w === "string"),
            },
          ]
        : [];
    }),
  ];
}

/** 建任务、改任务时的提示：按标题与库里的详述里的关键词。 */
export function textHints(
  db: DatabaseSync,
  task: { id: number; title: string; brief?: string | null },
): InviteHint[] {
  const rules = inviteRules(db);
  if (!rules.length) return [];
  const invited = new Set(
    concernRows(db, task.id).map((r) => specialistRef(r.node_id)),
  );
  return inviteHints(
    rules,
    { text: `${task.title}\n${task.brief ?? ""}` },
    invited,
  );
}

/** 执行者交付后的提示：按改动的文件。 */
export function fileHints(
  db: DatabaseSync,
  taskId: number,
  files: readonly string[],
): InviteHint[] {
  const rules = inviteRules(db);
  if (!rules.length || !files.length) return [];
  const invited = new Set(
    concernRows(db, taskId).map((r) => specialistRef(r.node_id)),
  );
  return inviteHints(rules, { files }, invited);
}
