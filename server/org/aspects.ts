import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { all, nodeByAddress, ref, type NodeRow } from "./model.ts";

/**
 * 管方面的部分（#373）：「管东西」的部分（命令行、网页、派活…）之外，还有「管方面」的部分（安全、性能、体验），
 * 它们的要点横跨多个部分。节点 `org_nodes.aspect=1` 标记管方面；`org_nodes.applies` 是这一块缺省适用于哪些部分，
 * 要点自己的 `org_points.applies` 可再覆盖；都不写即适用于整个上级（父节点及其下所有部分）。
 *
 * 判定是纯函数（`pointScope`、`covers`、`appliedFrom`），读库拼事实在 `appliedPoints`、`autoInvolved`。
 * 适用范围存节点 id 的 JSON 数组；指向的节点归档或不在了就忽略那一项。
 */

export const APPLIES_MAX = 20;

/** 加列：旧库没有这几列时补上；缺省 0 / NULL，已有部分都是「管东西」、要点跟随节点。 */
export function ensureAspectColumns(db: DatabaseSync) {
  const has = (table: string, column: string) =>
    (
      db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    ).some((c) => c.name === column);
  if (!has("org_nodes", "aspect"))
    db.exec(
      "ALTER TABLE org_nodes ADD COLUMN aspect INTEGER NOT NULL DEFAULT 0",
    );
  if (!has("org_nodes", "applies"))
    db.exec("ALTER TABLE org_nodes ADD COLUMN applies TEXT");
  if (!has("org_points", "applies"))
    db.exec("ALTER TABLE org_points ADD COLUMN applies TEXT");
}

/** 读 JSON 数组；坏数据当没写（适用于整个上级）。 */
export function parseApplies(
  value: string | null | undefined,
): number[] | null {
  if (!value) return null;
  try {
    const list = JSON.parse(value) as unknown;
    if (!Array.isArray(list)) return null;
    const ids = list.filter(
      (x): x is number => Number.isSafeInteger(x) && (x as number) > 0,
    );
    return ids.length ? ids : null;
  } catch {
    return null;
  }
}

export type ScopeNode = Pick<
  NodeRow,
  "id" | "parent_id" | "name" | "archived_at"
> & { aspect?: number; applies?: string | null };

/** 一条要点的适用范围（纯函数）：要点自己写的 → 节点写的 → 整个上级；根上的管方面节点退回它自己。 */
export function pointScope(
  node: { id: number; parent_id: number | null; applies?: string | null },
  pointApplies: string | null | undefined,
): number[] {
  return (
    parseApplies(pointApplies) ??
    parseApplies(node.applies) ?? [node.parent_id ?? node.id]
  );
}

/** part 是否落在 scope 里某一块之下（含它自己）；沿父链往上找（纯函数）。 */
export function covers(
  list: readonly Pick<ScopeNode, "id" | "parent_id" | "archived_at">[],
  scope: readonly number[],
  part: number,
): boolean {
  const alive = new Set(
    scope.filter((id) =>
      list.some((n) => n.id === id && n.archived_at === null),
    ),
  );
  const seen = new Set<number>();
  for (
    let current = list.find((n) => n.id === part);
    current && !seen.has(current.id);
    current = list.find((n) => n.id === current!.parent_id)
  ) {
    if (alive.has(current.id)) return true;
    seen.add(current.id);
  }
  return false;
}

/** 从根到 part 的节点 id（含 part）。 */
export function chainIds(
  list: readonly Pick<ScopeNode, "id" | "parent_id">[],
  part: number,
): number[] {
  const out: number[] = [];
  for (
    let current = list.find((n) => n.id === part);
    current && !out.includes(current.id);
    current = list.find((n) => n.id === current!.parent_id)
  )
    out.unshift(current.id);
  return out;
}

/** 适用范围的人话：「适用于网页、命令行」或「适用于整个 Atrium」。 */
export function scopeLabel(
  list: readonly Pick<ScopeNode, "id" | "name">[],
  scope: readonly number[],
  explicit: boolean,
): string {
  const names = scope
    .map((id) => list.find((n) => n.id === id)?.name)
    .filter(Boolean);
  if (!names.length) return "适用范围已失效";
  return explicit ? `适用于${names.join("、")}` : `适用于整个${names[0]}`;
}

export type AspectPoint = {
  ref: string;
  text: string;
  why: string;
  by: string;
  check: string | null;
  applies: string | null;
};
export type AppliedLevel = {
  /** 管方面的部分。 */
  node: string;
  name: string;
  /** 「安全 · 适用于网页」这样的来源说明。 */
  source: string;
  /** auto：要点适用于本任务归属部分；also：任务显式牵涉了这一部分。 */
  via: "auto" | "also";
  points: Omit<AspectPoint, "applies">[];
};

/**
 * 纯函数：给归属部分 part 与显式牵涉的部分 also，算出要附进来的「别处的要点」。
 * - 显式牵涉的部分：附它的全部要点（它是管方面的就注明适用范围）；
 * - 其余管方面的部分：只附适用于 part 的要点（自动牵涉）；
 * part 归属链上的节点不算（它们的要点已在归属链里）。同一部分只出现一次，按节点 id 排。
 */
export function appliedFrom(
  list: readonly ScopeNode[],
  points: ReadonlyMap<number, readonly AspectPoint[]>,
  part: number | null,
  also: readonly number[],
): AppliedLevel[] {
  const chain = new Set(part === null ? [] : chainIds(list, part));
  const out: AppliedLevel[] = [];
  const nodeScope = (n: ScopeNode) => ({
    scope: pointScope(n, null),
    explicit: parseApplies(n.applies) !== null,
  });
  for (const n of [...list].sort((a, b) => a.id - b.id)) {
    if (n.archived_at !== null || chain.has(n.id)) continue;
    const own = points.get(n.id) ?? [];
    if (also.includes(n.id)) {
      if (!own.length) continue;
      const { scope, explicit } = nodeScope(n);
      out.push({
        node: ref(n.id),
        name: n.name,
        source: n.aspect
          ? `${n.name} · ${scopeLabel(list, scope, explicit)}`
          : `${n.name} · 本任务牵涉`,
        via: "also",
        points: own.map(strip),
      });
      continue;
    }
    if (!n.aspect || part === null) continue;
    const hit = own.filter((p) => covers(list, pointScope(n, p.applies), part));
    if (!hit.length) continue;
    const partName = list.find((x) => x.id === part)?.name ?? ref(part);
    out.push({
      node: ref(n.id),
      name: n.name,
      source: `${n.name} · 适用于${partName}`,
      via: "auto",
      points: hit.map(strip),
    });
  }
  return out;
}
const strip = ({ applies: _applies, ...rest }: AspectPoint) => rest;

/** 读库：节点与各节点的要点（算适用范围用）；全景一次读、按部分多次算。 */
export function aspectFacts(db: DatabaseSync) {
  const list = all<ScopeNode>(
    db,
    "SELECT id,parent_id,name,archived_at,aspect,applies FROM org_nodes ORDER BY id LIMIT 501",
  );
  const points = new Map<number, AspectPoint[]>();
  for (const row of all<{
    id: number;
    node_id: number;
    text: string;
    why: string;
    decided_by: string;
    check_ref: string | null;
    applies: string | null;
  }>(
    db,
    "SELECT p.id,p.node_id,p.text,p.why,p.decided_by,p.check_ref,p.applies FROM org_points p JOIN org_nodes n ON n.id=p.node_id WHERE n.archived_at IS NULL ORDER BY p.node_id,p.pos,p.id LIMIT 5000",
  ))
    points.set(row.node_id, [
      ...(points.get(row.node_id) ?? []),
      {
        ref: `k${row.id}`,
        text: row.text,
        why: row.why,
        by: row.decided_by,
        check: row.check_ref,
        applies: row.applies,
      },
    ]);
  return { list, points };
}

/** 读库：part 自动牵涉与显式牵涉的部分的要点。 */
export function appliedPoints(
  db: DatabaseSync,
  part: number | null,
  also: readonly number[] = [],
): AppliedLevel[] {
  const { list, points } = aspectFacts(db);
  return appliedFrom(list, points, part, also);
}

/** 自动牵涉：有要点适用于 part 的管方面部分（不含归属链上的）。 */
export function autoInvolved(db: DatabaseSync, part: number | null): number[] {
  return appliedPoints(db, part)
    .filter((l) => l.via === "auto")
    .map((l) => Number(l.node.slice(1)));
}

const usage = (message: string) =>
  new Problem(400, message, "usage", undefined, "atrium org tree");

/**
 * 把 `--applies o4,o13`（或列表）解析成节点 id；空串 / 空列表 / null 表示清掉（适用于整个上级）。
 * 节点须存在且没归档。flag 用于报错。
 */
export function resolveApplies(
  db: DatabaseSync,
  value: unknown,
  flag = "--applies",
): number[] | null {
  if (value === undefined || value === null || value === "") return null;
  const items =
    typeof value === "string"
      ? value.split(/[,，、]/)
      : Array.isArray(value) && value.every((v) => typeof v === "string")
        ? (value as string[])
        : null;
  if (!items) throw usage(`${flag}: 应为部分列表，如 o4,o13`);
  const names = items.map((s) => s.trim()).filter(Boolean);
  if (!names.length) return null;
  if (names.length > APPLIES_MAX)
    throw usage(`${flag}: 至多 ${APPLIES_MAX} 个部分`);
  const ids: number[] = [];
  for (const name of names) {
    let node: NodeRow;
    try {
      node = nodeByAddress(db, name);
    } catch (error) {
      if (error instanceof Problem)
        throw new Problem(
          400,
          `${flag}: ${error.message}`,
          "usage",
          error.candidates,
          "atrium org tree",
        );
      throw error;
    }
    if (node.archived_at !== null)
      throw usage(`${flag}: ${ref(node.id)} ${node.name} 已归档`);
    if (!ids.includes(node.id)) ids.push(node.id);
  }
  return ids;
}

export const appliesText = (ids: number[] | null) =>
  ids && ids.length ? JSON.stringify(ids) : null;
export const appliesRefs = (value: string | null | undefined) =>
  parseApplies(value)?.map(ref) ?? null;

/**
 * 纯函数：把管方面的部分改回普通 module 前，哪些适用范围还在、要先清掉。
 * 返回还带 applies 的要点短号，以及本部分的缺省范围是否也还在。
 */
export function aspectClearance(
  nodeApplies: string | null | undefined,
  points: readonly { ref: string; applies?: string | null }[],
): { points: string[]; node: boolean } {
  return {
    points: points
      .filter((p) => parseApplies(p.applies) !== null)
      .map((p) => p.ref),
    node: parseApplies(nodeApplies) !== null,
  };
}
