import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { nodeByAddress, ref, type DocRow, type NodeRow } from "../org/model.ts";
import { hasOrg } from "../org/task-node.ts";
import { nodePoints } from "../org/points.ts";
import { ownBoundaries } from "../org/boundary-store.ts";
import { formatParam } from "../org/boundaries.ts";
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

/** `安全,质量`（也认顿号、中文逗号）→ 关注点节点 id；空值表示都不请。 */
export function concernsFor(db: DatabaseSync, value: unknown): number[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value !== "string")
    throw usage("concern: 应为关注点节点，多个用逗号分隔，如 安全,质量");
  const names = value
    .split(/[,，、]/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!names.length) return [];
  if (!hasOrg(db))
    throw new Problem(
      400,
      "concern: 还没有组织树",
      "usage",
      undefined,
      "atrium org import",
    );
  if (names.length > CONCERNS_MAX)
    throw usage(`concern: 一个任务至多请 ${CONCERNS_MAX} 位专员`);
  const ids: number[] = [];
  for (const name of names) {
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
        `concern: ${ref(node.id)} ${node.name} 不是关注点（专员）节点`,
        "usage",
        undefined,
        "atrium org tree",
      );
    if (node.archived_at !== null)
      throw usage(`concern: ${ref(node.id)} ${node.name} 已归档`);
    if (!ids.includes(node.id)) ids.push(node.id);
  }
  return ids;
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
  if (!ids.length || !hasOrg(db)) return map;
  const rows = all<ConcernRow & { name: string; review_status: string | null }>(
    db,
    `SELECT c.*, n.name AS name, r.status AS review_status
       FROM task_concerns c JOIN org_nodes n ON n.id=c.node_id
       LEFT JOIN tasks r ON r.id=c.review_id
      WHERE c.task_id IN (${ids.map(() => "?").join(",")})
      ORDER BY c.task_id, c.pos LIMIT 1000`,
    ...ids,
  );
  for (const row of rows) {
    const list = map.get(row.task_id) ?? [];
    list.push({
      ref: ref(row.node_id),
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
  if (!hasOrg(db)) return [];
  return concernRows(db, taskId).map((row) => checklistOf(db, row.node_id));
}

/** 各关注点章程里的 invite_when 规则（没归档的关注点才算）。 */
export function inviteRules(db: DatabaseSync): InviteRule[] {
  if (!hasOrg(db)) return [];
  return all<NodeRow & { fields: string }>(
    db,
    `SELECT n.*, d.fields AS fields FROM org_nodes n JOIN org_docs d ON d.node_id=n.id AND d.doc='charter'
      WHERE n.kind='concern' AND n.archived_at IS NULL ORDER BY n.id LIMIT 500`,
  ).flatMap((row) => {
    let when: unknown;
    try {
      when = (JSON.parse(row.fields) as { invite_when?: unknown }).invite_when;
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
  });
}

const BRIEF_READ_MAX = 64 * 1024;

/** 建任务、改任务时的提示：按标题与详述里的关键词（详述读不到就只看标题）。 */
export function textHints(
  db: DatabaseSync,
  task: {
    id: number;
    title: string;
    brief_path: string | null;
    repo: string | null;
  },
): InviteHint[] {
  const rules = inviteRules(db);
  if (!rules.length) return [];
  let brief = "";
  const file = task.brief_path
    ? isAbsolute(task.brief_path)
      ? task.brief_path
      : task.repo
        ? join(task.repo, task.brief_path)
        : undefined
    : undefined;
  if (file)
    try {
      brief = readFileSync(file, "utf8").slice(0, BRIEF_READ_MAX);
    } catch {
      // 详述读不到时只看标题；派活时会另外报错。
    }
  const invited = new Set(concernRows(db, task.id).map((r) => ref(r.node_id)));
  return inviteHints(rules, { text: `${task.title}\n${brief}` }, invited);
}

/** 执行者交付后的提示：按改动的文件。 */
export function fileHints(
  db: DatabaseSync,
  taskId: number,
  files: readonly string[],
): InviteHint[] {
  const rules = inviteRules(db);
  if (!rules.length || !files.length) return [];
  const invited = new Set(concernRows(db, taskId).map((r) => ref(r.node_id)));
  return inviteHints(rules, { files }, invited);
}
