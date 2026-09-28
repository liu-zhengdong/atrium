import type { DatabaseSync } from "node:sqlite";
import { all, nodes, one, type NodeRow } from "../org/model.ts";
import { LOCAL_USER, SECRETARY } from "../../shared/user.ts";
import {
  ACTIVE_SQL,
  decisionLine,
  scopeWhere,
  views,
  type Decision,
  type DecisionScope,
  type Row,
} from "./decisions.ts";

/**
 * 决定记录的摘要（t211）：记录多了不撑爆上下文。`memo show`、leader 唤醒提示词、全景网页都只给摘要：
 * 标了「原则」的全列，再加最近 15 条，整段有字数上限；放不下的只给一行「另有 N 条」和查的命令。
 * 只挪信息、给摘要，不限制记多少。选取是纯函数（digestDecisions、nodeScope），读库在下半部分。
 */

export const DIGEST_LIMITS = {
  /** 最近几条（不含原则）。 */
  recent: 15,
  /** 整段决定（按一行人话算）的字数上限。 */
  chars: 3000,
  /** 原则至多取几条（再多也放不进字数上限）。 */
  principles: 100,
};

/**
 * 摘要选取（纯函数）：先原则、后最近的，各自新的在前；按顺序放，放到超出字数上限就停（不跳着塞短的、不截半条）。
 * total 是范围内有效决定的总数，omitted 是没放进来的条数。
 */
export function digestDecisions<T>(
  principles: readonly T[],
  recent: readonly T[],
  total: number,
  size: (d: T) => number,
  limits: { recent: number; chars: number } = DIGEST_LIMITS,
): { shown: T[]; omitted: number } {
  const shown: T[] = [];
  let used = 0;
  for (const d of [...principles, ...recent.slice(0, limits.recent)]) {
    const n = size(d);
    if (used + n > limits.chars) break;
    shown.push(d);
    used += n;
  }
  return { shown, omitted: Math.max(0, total - shown.length) };
}

/** 一条决定在摘要里占的字数：一行人话加列表前缀。 */
export const decisionSize = (d: Decision) =>
  Array.from(decisionLine(d)).length + 3;

/** 摘要末尾那一行（命令行、提示词共用）；都放下了为 null。 */
export function omittedLine(omitted: number): string | null {
  return omitted > 0
    ? `另有 ${omitted} 条，用 atrium decision ls --node 节点 / atrium decision search 关键词 查`
    : null;
}

/**
 * 节点范围（纯函数）：给定的节点及其全部上级；down 为真时再加全部下级。
 * 归档的节点照样算（挂在上面的决定仍然有效）；树里找不到的起点忽略。
 */
export function nodeScope(
  list: readonly Pick<NodeRow, "id" | "parent_id">[],
  starts: readonly number[],
  down = false,
): number[] {
  const byId = new Map(list.map((n) => [n.id, n]));
  const children = new Map<number, number[]>();
  for (const n of list)
    if (n.parent_id !== null)
      children.set(n.parent_id, [...(children.get(n.parent_id) ?? []), n.id]);
  const out = new Set<number>();
  for (const start of starts) {
    if (!byId.has(start)) continue;
    let current = byId.get(start);
    while (current && !out.has(current.id)) {
      out.add(current.id);
      current =
        current.parent_id === null ? undefined : byId.get(current.parent_id);
    }
    if (!down) continue;
    const stack = [...(children.get(start) ?? [])];
    while (stack.length) {
      const id = stack.pop()!;
      if (out.has(id)) continue;
      out.add(id);
      stack.push(...(children.get(id) ?? []));
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * 一位该看哪些决定（纯函数给范围）：用户看自己那份；秘书看自己的和用户的；
 * leader 看自己的，加挂在它负责的部分（含下级）及上级节点上的（谁记的都算）。
 */
export function ownerScope(
  owner: string,
  list: readonly Pick<NodeRow, "id" | "parent_id" | "leader" | "archived_at">[],
): DecisionScope {
  if (owner === LOCAL_USER) return { owners: [LOCAL_USER] };
  if (owner === SECRETARY) return { owners: [SECRETARY, LOCAL_USER] };
  const led = list
    .filter((n) => n.leader === owner && n.archived_at === null)
    .map((n) => n.id);
  return { owners: [owner], nodes: nodeScope(list, led, true) };
}

// ---- 读库 ----

export type DecisionDigest = {
  /** 摘要里的决定：先原则、后最近的。 */
  decisions: Decision[];
  /** 其中原则几条。 */
  principles: number;
  /** 范围内有效的决定共几条。 */
  total: number;
  /** 没放进摘要的条数。 */
  omitted: number;
};

export function decisionDigest(
  db: DatabaseSync,
  scope: DecisionScope,
  limits = DIGEST_LIMITS,
): DecisionDigest {
  const where = scopeWhere(scope);
  const pick = (principle: 0 | 1, limit: number) =>
    views(
      db,
      all<Row>(
        db,
        `SELECT * FROM decisions WHERE ${where.sql} AND ${ACTIVE_SQL} AND principle=? ORDER BY decided_on DESC,id DESC LIMIT ?`,
        ...where.args,
        principle,
        limit,
      ),
    );
  const principles = pick(1, limits.principles);
  const recent = pick(0, limits.recent);
  const total = one<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM decisions WHERE ${where.sql} AND ${ACTIVE_SQL}`,
    ...where.args,
  )!.n;
  const { shown, omitted } = digestDecisions(
    principles,
    recent,
    total,
    decisionSize,
    limits,
  );
  return {
    decisions: shown,
    principles: shown.filter((d) => d.principle).length,
    total,
    omitted,
  };
}

/** 一位的摘要（memo show、唤醒提示词、网页人物页）。 */
export function ownerDigest(db: DatabaseSync, owner: string) {
  return decisionDigest(db, ownerScope(owner, nodes(db)));
}

/** 节点的范围：本节点及其上级。 */
export function nodeChain(db: DatabaseSync, nodeId: number): DecisionScope {
  return { nodes: nodeScope(nodes(db), [nodeId]) };
}
