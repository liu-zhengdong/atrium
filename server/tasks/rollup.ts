import type { TaskRow } from "./ledger-model.ts";
import type { TaskStatus } from "./state.ts";

/**
 * 汇总型总任务（t190）的判定，纯函数、穷举测试；取数在 rollup-ledger.ts。
 *
 * 一个任务一旦有子任务（运行时自己建的审阅、上线验证这类「帮手」子任务不算），就是总任务：
 * 不再派给执行者，状态与进度由全部子孙里的叶子推出。中间层的子任务同样是总任务，只数叶子。
 */

export type LeafFacts = Pick<
  TaskRow,
  "id" | "status" | "delivery_stage" | "online_wait"
>;

/**
 * 叶子在总任务里算哪一类：
 * finished 已上线或完成且不需上线；landing 交付后在审阅、合入或等上线（运行时在办，算在做）；
 * stuck 失败或卡住；其余照账本状态。
 */
export type LeafPhase =
  "todo" | "running" | "landing" | "stuck" | "finished" | "cancelled";

export function leafPhase(leaf: LeafFacts): LeafPhase {
  switch (leaf.status) {
    case "cancelled":
      return "cancelled";
    case "running":
      return "running";
    case "failed":
    case "blocked":
      return "stuck";
    case "todo":
      return "todo";
    case "done":
      if (
        leaf.delivery_stage === "reviewing" ||
        leaf.delivery_stage === "merge_queued" ||
        leaf.delivery_stage === "merging" ||
        (leaf.delivery_stage === "merged" && leaf.online_wait === 1)
      )
        return "landing";
      return "finished";
  }
}

/** 总任务的汇总状态：在做、卡住、已上线（全部完成）、取消、待办。 */
export type RollupStatus =
  "running" | "blocked" | "online" | "cancelled" | "todo";

export type Rollup = {
  status: RollupStatus;
  /** 叶子总数（含已取消的）。 */
  leaves: number;
  /** 已上线或完成且不需上线的叶子。 */
  finished: number;
  /** 在做的叶子（执行者在跑，或交付后在审阅、合入、等上线）。 */
  running: number;
  /** 失败或卡住的叶子。 */
  stuck: number;
  todo: number;
  cancelled: number;
  /** 卡住的叶子短号（至多 REFS_MAX 个，短号升序）。 */
  stuck_refs: string[];
  /** 在做的叶子短号（至多 REFS_MAX 个，短号升序）。 */
  running_refs: string[];
  /** 子孙太多只数了前面一部分（ROLLUP_MAX）。 */
  truncated: boolean;
};

export const REFS_MAX = 5;

const ref = (id: number) => `t${id}`;

/** 叶子推出总任务的状态：有在做 → 在做；有卡住 → 卡住；全取消 → 取消；其余全部完成 → 已上线；否则待办。 */
export function rollupOf(
  leaves: readonly LeafFacts[],
  truncated = false,
): Rollup {
  const result: Rollup = {
    status: "todo",
    leaves: leaves.length,
    finished: 0,
    running: 0,
    stuck: 0,
    todo: 0,
    cancelled: 0,
    stuck_refs: [],
    running_refs: [],
    truncated,
  };
  const sorted = [...leaves].sort((a, b) => a.id - b.id);
  for (const leaf of sorted) {
    const phase = leafPhase(leaf);
    if (phase === "running" || phase === "landing") {
      result.running++;
      if (result.running_refs.length < REFS_MAX)
        result.running_refs.push(ref(leaf.id));
    } else if (phase === "stuck") {
      result.stuck++;
      if (result.stuck_refs.length < REFS_MAX)
        result.stuck_refs.push(ref(leaf.id));
    } else result[phase]++;
  }
  result.status =
    result.running > 0
      ? "running"
      : result.stuck > 0
        ? "blocked"
        : leaves.length > 0 && result.cancelled === leaves.length
          ? "cancelled"
          : result.finished > 0 && result.todo === 0
            ? "online"
            : "todo";
  return result;
}

/** 进度的分母不算已取消的叶子。 */
export const progressOf = (rollup: Rollup) =>
  `${rollup.finished}/${rollup.leaves - rollup.cancelled}`;

export function rollupLabel(rollup: Rollup): string {
  switch (rollup.status) {
    case "running":
      return "在做";
    case "blocked":
      return "卡住";
    case "online":
      return "已上线";
    case "cancelled":
      return "取消";
    case "todo":
      return rollup.finished > 0 ? "等待中" : "待办";
  }
}

/** 一句话：「在做 · 5/12 · 在做 2（t181、t183）· 卡住 1（t185）」。 */
export function rollupText(rollup: Rollup): string {
  const refs = (list: string[], count: number) =>
    list.length
      ? `（${list.join("、")}${count > list.length ? "…" : ""}）`
      : "";
  return [
    rollupLabel(rollup),
    `${progressOf(rollup)}${rollup.truncated ? "+" : ""}`,
    rollup.running
      ? `在做 ${rollup.running}${refs(rollup.running_refs, rollup.running)}`
      : "",
    rollup.stuck
      ? `卡住 ${rollup.stuck}${refs(rollup.stuck_refs, rollup.stuck)}`
      : "",
    rollup.cancelled ? `取消 ${rollup.cancelled}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * 总任务在账本里存的状态跟着汇总走，依赖、等待、列表筛选都照常认：
 * 全部完成 → done，全部取消 → cancelled，其余 → todo（从不写成 running 或 blocked，那两个状态属于真有执行者的任务）。
 * 自己正在跑（拆活的执行者还没退出）的不动；用户明确取消的总任务不再改回来。返回 null 表示不用改。
 */
export function storedStatusFor(
  current: TaskStatus,
  rollup: Rollup,
): TaskStatus | null {
  if (current === "running" || current === "cancelled") return null;
  if (rollup.truncated) return null;
  const target: TaskStatus =
    rollup.status === "online"
      ? "done"
      : rollup.status === "cancelled"
        ? "cancelled"
        : "todo";
  return target === current ? null : target;
}

/** 子孙一行：自己的叶子事实，加上父任务与有没有非帮手子任务。 */
export type SubtreeRow = LeafFacts & {
  parent_id: number | null;
  /** 1 表示它下面还有（非帮手）子任务，即中间层的总任务。 */
  has_children: number;
};

/**
 * 按子孙行给每个总任务算汇总（起点与其中间层都算）。rows 只含子孙、不含起点自己；
 * 有子任务的行不算叶子。一趟自下而上：先把每个叶子挂到全部祖先上，O(行数 × 深度)。
 */
export function rollupsOf(
  rows: readonly SubtreeRow[],
  truncated = false,
): Map<number, Rollup> {
  const parent = new Map<number, number | null>();
  for (const row of rows) parent.set(row.id, row.parent_id);
  const leavesOf = new Map<number, LeafFacts[]>();
  for (const row of rows) {
    if (row.has_children) continue;
    let up = row.parent_id;
    // 深度有上限，坏数据里的环也不会死循环。
    for (let depth = 0; up !== null && depth < 64; depth++) {
      const list = leavesOf.get(up) ?? [];
      list.push(row);
      leavesOf.set(up, list);
      // 一直走到取到的行之外（起点的父任务不在行里）：嵌套的起点不截断外层。
      up = parent.get(up) ?? null;
    }
  }
  const result = new Map<number, Rollup>();
  for (const [id, leaves] of leavesOf)
    result.set(id, rollupOf(leaves, truncated));
  return result;
}

/** 叶子的这些结局算「卡住要人」：没有 leader 管时，秘书收到的是总任务级的「tN 下的 tM 卡住」。 */
export const STUCK_KINDS: ReadonlySet<string> = new Set([
  "failed",
  "blocked",
  "stalled",
  "online_failed",
  "release_overdue",
  // 上线验证没通过、无法验证（t182）。
  "verify_failed",
  "verify_unverifiable",
]);

/**
 * 总任务下面的任务的事件怎么投（纯函数）：给 leader 的照旧；秘书（和用户）只收总任务级的——
 * 秘书本是它的负责人时，卡住类转成一条「tN 下的 tM 卡住」，其余（完成、上线、过程）不投；
 * 上线类原本另抄秘书的那份也不抄。
 */
export function leafDelivery(
  kind: string,
  targets: readonly string[],
  main: string,
  secretary: string,
): { to: string[]; stuck: boolean } {
  return {
    to: targets.filter((target) => target !== secretary),
    stuck: main === secretary && STUCK_KINDS.has(kind),
  };
}

/** 「t174 整体已上线（12/12）」 */
export const totalOnlineMessage = (ref: string, rollup: Rollup) =>
  `${ref} 整体已上线（${progressOf(rollup)}）`;
