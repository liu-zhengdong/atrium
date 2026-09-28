import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";

/**
 * 优先级：每件任务只有一个 priority——紧急 urgent、修复 fix、普通 normal、闲时 idle，存 `tasks.prio`
 * （旧库的 `priority` 列带着只收 normal / idle 的约束，不再读写）。
 *
 * - 想跑的任务一律进同一个队列（queue.ts），唯一的 drain 按「优先级、入队先后」取；合入队列按同一个优先级排。
 * - 紧急只多一条：跳过本机负载限制（host-load.ts hostGate 的 urgent）。
 * - 缺省按归属部分定：归属部分（没写时按干活的节点）是管方面的部分或在它下面为闲时，其余普通；`--priority` 可覆盖。
 *
 * 判定是纯函数，读库拼事实在 `aspectPart`（这里）与 `queue.ts`、`merge-runtime.ts`。
 */

export const PRIORITIES = ["urgent", "fix", "normal", "idle"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_LABEL: Record<Priority, string> = {
  urgent: "紧急",
  fix: "修复",
  normal: "普通",
  idle: "闲时",
};

const ALIASES: Record<string, Priority> = Object.fromEntries(
  PRIORITIES.flatMap((p) => [
    [p, p],
    [PRIORITY_LABEL[p], p],
  ]),
);

/** 接口与命令行都接受「紧急 / 修复 / 普通 / 闲时」或英文；其余一律拒绝。 */
export function parsePriority(value: unknown): Priority {
  const found =
    typeof value === "string" ? ALIASES[value.trim().toLowerCase()] : undefined;
  if (!found)
    throw new Problem(
      400,
      "priority: 只能是 紧急、修复、普通 或 闲时",
      "usage",
    );
  return found;
}

/** 账本里的值：认不出（旧库、写坏）按普通。 */
export const priorityOf = (value: unknown): Priority =>
  (PRIORITIES as readonly unknown[]).includes(value)
    ? (value as Priority)
    : "normal";

/** 排在前面的档位：紧急 0、修复 1、普通 2、闲时 3。 */
export const rank = (priority: Priority) => PRIORITIES.indexOf(priority);

/** SQL 里的同一个档位（排队、合入队列的 ORDER BY 用）。 */
export const rankSql = (column: string) =>
  `CASE ${column} WHEN 'urgent' THEN 0 WHEN 'fix' THEN 1 WHEN 'idle' THEN 3 ELSE 2 END`;

/** 缺省优先级：归属部分是管方面的（或在它下面）为闲时，其余普通。 */
export const defaultPriority = (aspect: boolean): Priority =>
  aspect ? "idle" : "normal";

/**
 * 改归属部分后的优先级：没被人改过（等于旧部分的缺省）就跟着新部分的缺省走，改过的保留。纯函数。
 */
export function priorityAfterMove(
  current: Priority,
  before: boolean,
  after: boolean,
): Priority {
  return current === defaultPriority(before) ? defaultPriority(after) : current;
}

type OrgNode = { id: number; parent_id: number | null; aspect?: number };

/** 某节点是不是管方面的部分或在它下面（沿父链往上找；环与断链当不是）。纯函数。 */
export function underAspect(
  nodes: ReadonlyMap<number, OrgNode>,
  id: number | null,
): boolean {
  const seen = new Set<number>();
  for (
    let node = id === null ? undefined : nodes.get(id);
    node && !seen.has(node.id);
    node = node.parent_id === null ? undefined : nodes.get(node.parent_id)
  ) {
    if (node.aspect === 1) return true;
    seen.add(node.id);
  }
  return false;
}

/** 读组织树判断节点是否在管方面的部分下；旧库没有组织表或 aspect 列时一律不是。 */
export function aspectPart(db: DatabaseSync, id: number | null): boolean {
  if (id === null) return false;
  const columns = db.prepare("PRAGMA table_info(org_nodes)").all() as {
    name: string;
  }[];
  if (!columns.some((column) => column.name === "aspect")) return false;
  // 一条递归查询取整条父链（至多 64 级），不在循环里逐级查。
  const chain = db
    .prepare(
      `WITH RECURSIVE up(id,parent_id,aspect,depth) AS (
        SELECT id,parent_id,aspect,0 FROM org_nodes WHERE id=?
        UNION ALL SELECT n.id,n.parent_id,n.aspect,up.depth+1 FROM org_nodes n JOIN up ON n.id=up.parent_id WHERE up.depth<64)
      SELECT id,parent_id,aspect FROM up LIMIT 65`,
    )
    .all(id) as OrgNode[];
  const nodes = new Map(chain.map((node) => [node.id, node]));
  return underAspect(nodes, id);
}

/** 标题前的标记：普通的不标。 */
export const priorityTag = (priority: Priority | undefined) =>
  priority && priority !== "normal" ? PRIORITY_LABEL[priority] : "";

/** 标题本身已以这个标记开头（「紧急：…」「紧急 …」）就不再加，免得写成「紧急 紧急：…」。 */
export const titleTag = (tag: string, title: string) =>
  tag && !title.trimStart().startsWith(tag) ? tag : "";

/** 标题前加上标记（紧急、修复、闲时），已带的不重复。 */
export const tagTitle = (tag: string, title: string) => {
  const shown = titleTag(tag, title);
  return shown ? `${shown} ${title}` : title;
};

export type PriorityCounts = Record<Priority, number>;

/** 头部计数「紧急 K · 修复 M · 普通 N · 闲时 I」：只写不为 0 的；全是 0 时为空串。 */
export function priorityCountsText(counts: PriorityCounts | null | undefined) {
  if (!counts) return "";
  return PRIORITIES.filter((p) => counts[p] > 0)
    .map((p) => `${PRIORITY_LABEL[p]} ${counts[p]}`)
    .join(" · ");
}
