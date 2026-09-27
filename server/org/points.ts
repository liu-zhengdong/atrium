import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { appliesRefs, appliesText, resolveApplies } from "./aspects.ts";
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

/**
 * 全景图的「要点」（#322，u1 09-27 定）：这一块必须守住的设计约束。每条写人话一句、为什么、谁定的，
 * 可选守护它的检查（测试文件与用例名，或 `$ ` 开头的命令）。单独成表、不留修订记录，可增删改；
 * 短号 kN 全局一致、不复用。`chainPoints` 给后续派活提示词附「本节点及上级的要点」用。
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
  applies?: string | null;
};
export type Point = {
  ref: string;
  node: string;
  text: string;
  why: string;
  by: string;
  check: string | null;
  /** 管方面的部分的要点适用于哪些部分（oN）；null 为跟随节点（缺省整个上级）。 */
  applies: string[] | null;
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
  applies: appliesRefs(row.applies),
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
  applies?: unknown;
} {
  for (const key of Object.keys(input))
    if (!["text", "why", "by", "check", "applies"].includes(key))
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
  // 适用范围要查库解析，这里原样带出（addPoint / editPoint 里解析）。
  if ("applies" in input) out.applies = input.applies;
  if (partial && !Object.keys(out).length)
    throw usage("至少改一项：要点、--why、--by、--check、--applies");
  return out;
}

function authorize(db: DatabaseSync, node: NodeRow, actor: string) {
  if (node.parent_id === null && actor !== "u1")
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

/** 根 → 本节点每层的要点（空层省略）；派活附「本节点及上级的要点」用。 */
export function chainPoints(
  db: DatabaseSync,
  nodeId: number,
): { node: string; name: string; points: Point[] }[] {
  const list = nodes(db);
  const chain: NodeRow[] = [];
  let current = list.find((n) => n.id === nodeId);
  while (current) {
    chain.unshift(current);
    const parent: number | null = current.parent_id;
    current = list.find((n) => n.id === parent);
  }
  return chain
    .map((n) => ({
      node: ref(n.id),
      name: n.name,
      points: nodePoints(db, n.id),
    }))
    .filter((level) => level.points.length);
}

export function addPoint(
  db: DatabaseSync,
  address: string,
  body: unknown,
  actor: string,
): Point {
  const input = validatePoint(objectOf(body)) as Required<
    ReturnType<typeof validatePoint>
  >;
  return transaction(db, () => {
    const node = nodeByAddress(db, address);
    authorize(db, node, actor);
    const applies = appliesOf(db, node, input.applies);
    const count = one<{ n: number; pos: number | null }>(
      db,
      "SELECT count(*) AS n, max(pos) AS pos FROM org_points WHERE node_id=?",
      node.id,
    )!;
    if (count.n >= POINTS_PER_NODE)
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
          "INSERT INTO org_points(node_id,pos,text,why,decided_by,check_ref,applies,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          node.id,
          (count.pos ?? 0) + 1,
          input.text,
          input.why,
          input.by,
          input.check ?? null,
          applies === undefined ? null : appliesText(applies),
          actor,
          Date.now(),
        ).lastInsertRowid,
    );
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
    const node = nodeByAddress(db, ref(row.node_id));
    authorize(db, node, actor);
    const applies = appliesOf(db, node, input.applies);
    db.prepare(
      "UPDATE org_points SET text=?,why=?,decided_by=?,check_ref=?,applies=?,updated_by=?,updated_at=? WHERE id=?",
    ).run(
      input.text ?? row.text,
      input.why ?? row.why,
      input.by ?? row.decided_by,
      input.check === undefined ? row.check_ref : input.check,
      applies === undefined ? (row.applies ?? null) : appliesText(applies),
      actor,
      Date.now(),
      row.id,
    );
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

/** 适用范围只给管方面的部分写；没给为 undefined，清掉为 null。 */
function appliesOf(db: DatabaseSync, node: NodeRow, value: unknown) {
  if (value === undefined) return undefined;
  const ids = resolveApplies(db, value);
  if (ids && !node.aspect)
    throw usage(
      `--applies: ${ref(node.id)} ${node.name} 不是管方面的部分；管东西的部分的要点只对本块及下层生效`,
    );
  return ids;
}

function objectOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw usage("请求体应为对象");
  return value as Record<string, unknown>;
}
