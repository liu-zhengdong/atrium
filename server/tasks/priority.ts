import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";

/**
 * 闲时（t136）：管方面的部分（安全、性能、体验…）开的任务默认排在功能任务后面，有空闲执行者才做；不是配额，也不是关卡。
 *
 * - 优先级只有两档：普通 normal 与闲时 idle，存 `tasks.priority`；紧急（`tasks.urgent`）另算、永远最前。
 * - 缺省按归属部分定：归属部分（没写时按干活的节点）是管方面的部分或在它下面，缺省闲时，其余普通；`--priority` 可覆盖。
 * - 派发先后：紧急 → 普通 → 闲时。闲时任务只有在没有普通任务在等同一类执行者时才派：
 *   同一工具的普通任务在排队，或别的普通任务只是在等本机空位（受并发上限或太忙卡着），闲时的都让它们先；
 *   普通任务在等的是自己那个工具（独占工具正忙、账号额度用尽），不挡别的工具上的闲时任务。已在跑的闲时任务不打断。
 *
 * 判定是纯函数，读库拼事实在 `aspectPart`（这里）与 `queue.ts`、`executors.ts`。
 */

export const PRIORITIES = ["normal", "idle"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_LABEL: Record<Priority, string> = {
  normal: "普通",
  idle: "闲时",
};

const ALIASES: Record<string, Priority> = {
  normal: "normal",
  idle: "idle",
  普通: "normal",
  闲时: "idle",
};

/** 接口与命令行都接受「闲时 / 普通」或 idle / normal；其余一律拒绝。 */
export function parsePriority(value: unknown): Priority {
  const found =
    typeof value === "string" ? ALIASES[value.trim().toLowerCase()] : undefined;
  if (!found) throw new Problem(400, "priority: 只能是 闲时 或 普通", "usage");
  return found;
}

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

/** 排在前面的档位：紧急 0、普通 1、闲时 2（紧急的闲时任务按紧急算）。 */
export const rank = (task: { urgent: boolean; idle: boolean }) =>
  task.urgent ? 0 : task.idle ? 2 : 1;

/** 真正按闲时排的：标了闲时且没标紧急。 */
export const isIdle = (task: {
  urgent: number | boolean;
  priority?: string | null;
}) => task.priority === "idle" && !task.urgent;

/** 在排队的普通（含紧急）任务：用哪个工具。 */
export type AheadEntry = { tool: string };

/**
 * 一件闲时任务前面还有几件普通任务在等同一类执行者（纯函数）：同一工具的都算；别的工具上的，
 * 除非它在等的是自己那个工具（ownWait：独占工具正忙、额度用尽），否则就是在等本机空位，也算。
 * 0 表示可以派。
 */
export function idleAhead(
  tool: string,
  normals: readonly AheadEntry[],
  ownWait: (tool: string) => boolean,
): number {
  return normals.filter((entry) => entry.tool === tool || !ownWait(entry.tool))
    .length;
}

/**
 * 队列里每件闲时任务前面的普通任务数（纯函数，线性）：按工具计数一次，再逐件查表，不嵌套遍历。
 * entries 是队列里全部任务；只给闲时任务出结果，其余不在表里。
 */
export function idleAheadAll(
  entries: readonly {
    task_id: number;
    tool: string;
    idle: boolean;
  }[],
  ownWait: (tool: string) => boolean,
): Map<number, number> {
  const sameTool = new Map<string, number>();
  const free = new Map<string, number>();
  let freeTotal = 0;
  for (const entry of entries) {
    if (entry.idle) continue;
    sameTool.set(entry.tool, (sameTool.get(entry.tool) ?? 0) + 1);
    if (!ownWait(entry.tool)) {
      free.set(entry.tool, (free.get(entry.tool) ?? 0) + 1);
      freeTotal++;
    }
  }
  const result = new Map<number, number>();
  for (const entry of entries)
    if (entry.idle)
      result.set(
        entry.task_id,
        (sameTool.get(entry.tool) ?? 0) +
          freeTotal -
          (free.get(entry.tool) ?? 0),
      );
  return result;
}

/** 闲时任务在等什么的说法。 */
export const idleWaitText = (ahead: number) =>
  `等空闲：前面还有 ${ahead} 件普通任务`;

/** 闲时任务的回执说清怎么排。 */
export const IDLE_NOTE = "闲时：排在普通任务后面，有空闲执行者才派";

/** 标题前的标记：紧急、闲时或不标（紧急的闲时任务只标紧急）。 */
export const priorityTag = (task: {
  urgent: number | boolean;
  priority?: string | null;
}) => (task.urgent ? "紧急" : isIdle(task) ? "闲时" : "");

/** 标题本身已以这个标记开头（「紧急：…」「紧急 …」）就不再加，免得写成「紧急 紧急：…」。 */
export const titleTag = (tag: string, title: string) =>
  tag && !title.trimStart().startsWith(tag) ? tag : "";

/** 标题前加上标记（紧急、闲时），已带的不重复。 */
export const tagTitle = (tag: string, title: string) => {
  const shown = titleTag(tag, title);
  return shown ? `${shown} ${title}` : title;
};
