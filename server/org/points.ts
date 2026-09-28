import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import {
  all,
  canEdit,
  nodeByAddress,
  nodes,
  one,
  ref,
  transaction,
  type NodeRow,
} from "./model.ts";
import { actsForUser } from "../../shared/user.ts";

/**
 * 要点：规矩只放这里（用户的原则、口味、取舍，以及各部门必须守住的约束）。每条写人话一句、为什么、谁定的，
 * 可选守护它的检查（测试文件与用例名，或 `$ ` 开头的命令）。要点挂在部门上，按树往下继承；
 * 同一部门里按 pos 排序，靠前的更重要，冲突时靠前的优先（组织根上的几条就是全组织的原则排序）。
 * 跨几块的规矩放在它们共同的上级。单独成表、不留修订记录；短号 kN 全局一致、不复用。
 */

export const POINT_LIMITS = { text: 200, why: 300, by: 40, check: 300 };
export const POINTS_PER_NODE = 30;

export type PointRow = {
  id: number;
  node_id: number;
  pos: number;
  text: string;
  why: string;
  decided_by: string;
  check_ref: string | null;
  updated_by: string;
  updated_at: number;
};
export type Point = {
  ref: string;
  node: string;
  text: string;
  why: string;
  by: string;
  check: string | null;
  updated_by: string;
  updated_at: number;
};

export function ensurePointTables(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS org_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id INTEGER NOT NULL REFERENCES org_nodes(id),
    pos INTEGER NOT NULL,
    text TEXT NOT NULL, why TEXT NOT NULL, decided_by TEXT NOT NULL,
    check_ref TEXT, updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS org_points_node ON org_points(node_id,pos,id);`);
}

export const pointRef = (id: number) => `k${id}`;
const view = (row: PointRow): Point => ({
  ref: pointRef(row.id),
  node: ref(row.node_id),
  text: row.text,
  why: row.why,
  by: row.decided_by,
  check: row.check_ref,
  updated_by: row.updated_by,
  updated_at: row.updated_at,
});

const usage = (message: string, next?: string) =>
  new Problem(400, message, "usage", undefined, next);

/** 字段校验（纯函数）：partial 为真时只校验给了的字段（改要点）。 */
export function validatePoint(
  input: Record<string, unknown>,
  partial = false,
): {
  text?: string;
  why?: string;
  by?: string;
  check?: string | null;
  pos?: number;
} {
  for (const key of Object.keys(input))
    if (!["text", "why", "by", "check", "pos"].includes(key))
      throw usage(`${key}: 是未知字段`);
  const out: ReturnType<typeof validatePoint> = {};
  const field = (key: "text" | "why" | "by", flag: string, label: string) => {
    if (!(key in input)) {
      if (!partial) throw usage(`${flag}: ${label}必填`);
      return;
    }
    const value = input[key];
    if (typeof value !== "string" || !value.trim())
      throw usage(`${flag}: ${label}不能为空`);
    if (Array.from(value.trim()).length > POINT_LIMITS[key])
      throw usage(`${flag}: ${label}不能超过 ${POINT_LIMITS[key]} 字`);
    out[key] = value.trim();
  };
  field("text", "要点", "要点");
  field("why", "--why", "为什么");
  field("by", "--by", "谁定的");
  if ("check" in input) {
    const value = input.check;
    if (value === null || value === "") out.check = null;
    else if (typeof value !== "string")
      throw usage("--check: 应为测试文件与用例名，或 $ 开头的命令");
    else if (Array.from(value.trim()).length > POINT_LIMITS.check)
      throw usage(`--check: 不能超过 ${POINT_LIMITS.check} 字`);
    else out.check = value.trim();
  }
  if ("pos" in input) {
    const value = Number(input.pos);
    if (!Number.isInteger(value) || value < 1 || value > POINTS_PER_NODE)
      throw usage(`--pos: 应为 1–${POINTS_PER_NODE} 的整数（1 最重要）`);
    out.pos = value;
  }
  if (partial && !Object.keys(out).length)
    throw usage("至少改一项：要点、--why、--by、--check、--pos");
  return out;
}

/** 把 id 挪到第 pos 位（1 起），其余按原先后顺延（纯函数）。 */
export function reorder(ids: readonly number[], id: number, pos: number) {
  const rest = ids.filter((x) => x !== id);
  const at = Math.max(0, Math.min(rest.length, pos - 1));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

function authorize(db: DatabaseSync, node: NodeRow, actor: string) {
  if (node.parent_id === null && !actsForUser(actor))
    throw new Problem(403, "根节点的要点只有你能改");
  if (!canEdit(nodes(db), node, actor))
    throw new Problem(
      403,
      `要点无权限：${actor} 不是 ${ref(node.id)} 的 leader 或祖先 leader`,
    );
  if (node.archived_at !== null)
    throw new Problem(400, `${ref(node.id)} 已归档`);
}

function parsePointRef(value: string): number {
  const match = /^k([1-9][0-9]{0,15})$/.exec(value.trim());
  if (!match) throw usage("要点短号应为 k1 这样的格式");
  return Number(match[1]);
}
function requirePoint(db: DatabaseSync, value: string): PointRow {
  const id = parsePointRef(value);
  const row = one<PointRow>(db, "SELECT * FROM org_points WHERE id=?", id);
  if (!row)
    throw new Problem(
      404,
      `要点 ${pointRef(id)} 不存在`,
      "not_found",
      undefined,
      "atrium org tree",
    );
  return row;
}

export function nodePoints(db: DatabaseSync, nodeId: number): Point[] {
  return all<PointRow>(
    db,
    "SELECT * FROM org_points WHERE node_id=? ORDER BY pos,id LIMIT ?",
    nodeId,
    POINTS_PER_NODE,
  ).map(view);
}

/** 根 → 本节点每层的要点（空层省略）：派活与 leader 唤醒附「本部门及上级的要点」用。 */
export function chainPoints(
  db: DatabaseSync,
  nodeId: number,
): { node: string; name: string; points: Point[] }[] {
  const list = nodes(db);
  const chain: NodeRow[] = [];
  const seen = new Set<number>();
  for (
    let current = list.find((n) => n.id === nodeId);
    current && !seen.has(current.id);
    current = list.find((n) => n.id === current!.parent_id)
  ) {
    seen.add(current.id);
    chain.unshift(current);
  }
  return chain
    .map((n) => ({
      node: ref(n.id),
      name: n.name,
      points: nodePoints(db, n.id),
    }))
    .filter((level) => level.points.length);
}

/** 把本节点的要点按 ids 的先后重写 pos（1 起）。 */
function writeOrder(db: DatabaseSync, ids: readonly number[]) {
  const update = db.prepare("UPDATE org_points SET pos=? WHERE id=?");
  ids.forEach((id, i) => update.run(i + 1, id));
}
const orderOf = (db: DatabaseSync, nodeId: number) =>
  all<{ id: number }>(
    db,
    "SELECT id FROM org_points WHERE node_id=? ORDER BY pos,id LIMIT 100",
    nodeId,
  ).map((r) => r.id);

export function addPoint(
  db: DatabaseSync,
  address: string,
  body: unknown,
  actor: string,
): Point {
  const input = validatePoint(objectOf(body)) as Required<
    Omit<ReturnType<typeof validatePoint>, "pos">
  > & { pos?: number };
  return transaction(db, () => {
    const node = nodeByAddress(db, address);
    authorize(db, node, actor);
    const order = orderOf(db, node.id);
    if (order.length >= POINTS_PER_NODE)
      throw new Problem(
        409,
        `${ref(node.id)} 已有 ${POINTS_PER_NODE} 条要点，先删掉过时的`,
        "conflict",
        undefined,
        `atrium org show ${ref(node.id)}`,
      );
    const id = Number(
      db
        .prepare(
          "INSERT INTO org_points(node_id,pos,text,why,decided_by,check_ref,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          node.id,
          order.length + 1,
          input.text,
          input.why,
          input.by,
          input.check ?? null,
          actor,
          Date.now(),
        ).lastInsertRowid,
    );
    if (input.pos !== undefined)
      writeOrder(db, reorder([...order, id], id, input.pos));
    return view(one<PointRow>(db, "SELECT * FROM org_points WHERE id=?", id)!);
  });
}

export function editPoint(
  db: DatabaseSync,
  reference: string,
  body: unknown,
  actor: string,
): Point {
  const input = validatePoint(objectOf(body), true);
  return transaction(db, () => {
    const row = requirePoint(db, reference);
    authorize(db, nodeByAddress(db, ref(row.node_id)), actor);
    db.prepare(
      "UPDATE org_points SET text=?,why=?,decided_by=?,check_ref=?,updated_by=?,updated_at=? WHERE id=?",
    ).run(
      input.text ?? row.text,
      input.why ?? row.why,
      input.by ?? row.decided_by,
      input.check === undefined ? row.check_ref : input.check,
      actor,
      Date.now(),
      row.id,
    );
    if (input.pos !== undefined)
      writeOrder(db, reorder(orderOf(db, row.node_id), row.id, input.pos));
    return view(
      one<PointRow>(db, "SELECT * FROM org_points WHERE id=?", row.id)!,
    );
  });
}

export function removePoint(
  db: DatabaseSync,
  reference: string,
  actor: string,
): Point {
  return transaction(db, () => {
    const row = requirePoint(db, reference);
    authorize(db, nodeByAddress(db, ref(row.node_id)), actor);
    db.prepare("DELETE FROM org_points WHERE id=?").run(row.id);
    return view(row);
  });
}

function objectOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw usage("请求体应为对象");
  return value as Record<string, unknown>;
}
