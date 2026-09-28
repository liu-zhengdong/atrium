/**
 * leader 分身（t275）的判定，纯函数、穷举测试；读库在 clone-facts.ts，拉进程在 runtime.ts。
 *
 * 同一位 leader 可以同时有几个唤醒（分身），每个分身认领一件事或一棵任务树：
 * - 事件按「组」认领：任务事件的组是它所属的最近总任务（自己是总任务就是自己，否则是父任务；
 *   运行时建的帮手子任务跟父任务走），没有任务的事件不属于任何组。
 * - 同一组同一时刻只归一个分身：组被在跑的分身占着时，这组的新事件等它结束再送。
 * - 日常事件（上线、交回、卡住……）与大事（规划结果待采纳、会审结论）分开认领：日常事件合成一个分身，
 *   大事一组一个分身；并发上限至少 2 时各给对方留一个位置，日常事件不再被大事挡住。
 * - 并发上限按 leader 可配（缺省 3）；上限为 1 时退回「同一 leader 同时只起一个、一次送全部」。
 */

export const CLONES_DEFAULT = 3;
export const CLONES_MAX = 8;

export type Lane = "routine" | "big";

/** 大事：规划结果交来要采纳（总任务拆解）、会审有了结论要按结论接着办。 */
export const BIG_KINDS: ReadonlySet<string> = new Set([
  "plan_ready",
  "plan_failed",
  "council_decided",
  "council_escalated",
]);

export const laneOf = (kind: string): Lane =>
  BIG_KINDS.has(kind) ? "big" : "routine";

/** 日常分身的名字；大事分身用它认领的组（如 t197）。也是备忘分段的名字。 */
export const ROUTINE_LABEL = "日常";

/** 分身并发上限：没配为缺省，配了夹在 1～CLONES_MAX。 */
export function cloneLimit(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value))
    return CLONES_DEFAULT;
  return Math.min(CLONES_MAX, Math.max(1, Math.trunc(value)));
}

/** 校验 --clones：1～CLONES_MAX 的整数；不对返回说明。 */
export function clonesProblem(value: unknown): string | null {
  const text = typeof value === "number" ? String(value) : value;
  if (
    typeof text !== "string" ||
    !/^[1-9][0-9]*$/.test(text.trim()) ||
    Number(text) > CLONES_MAX
  )
    return `clones: 分身并发上限应为 1～${CLONES_MAX} 的整数`;
  return null;
}

/**
 * 一件任务的组：自己有（非帮手）子任务就是总任务，组是自己；否则有父任务就归父任务（父任务必是总任务）；
 * 都没有就是自己。帮手子任务（专员审查、会审意见、规划）先换成它的父任务再判，由读库那边做。
 */
export function groupOf(task: {
  id: number;
  parent_id: number | null;
  total: boolean;
}): string {
  if (task.total || task.parent_id === null) return `t${task.id}`;
  return `t${task.parent_id}`;
}

export type CloneEvent = {
  id: number;
  kind: string;
  /** 事件进收件箱（或最近一次合并）的时间，攒批从这里算。 */
  queuedAt: number;
  /** 所属组；没有任务的事件为 null。 */
  group: string | null;
};

export type RunningClone = {
  slot: number;
  lane: Lane;
  label: string;
  groups: readonly string[];
};

export type CloneStart = {
  slot: number;
  lane: Lane;
  label: string;
  groups: string[];
  eventIds: number[];
};

export type ClonePlan = {
  start: CloneStart[];
  /** 组被在跑的分身占着、这一轮不送的事件。 */
  held: number[];
};

const earliest = (events: readonly CloneEvent[]) =>
  events.reduce((min, e) => Math.min(min, e.queuedAt), Infinity);

const groupsOf = (events: readonly CloneEvent[]) => [
  ...new Set(events.flatMap((e) => (e.group === null ? [] : [e.group]))),
];

const idsOf = (events: readonly CloneEvent[]) =>
  [...new Set(events.map((e) => e.id))].sort((a, b) => a - b);

/**
 * 这一轮给某位 leader 起哪些分身。攒批按候选各自最早的一条算（缺省 30 秒）；
 * 分身号取 1～上限里没占用的最小号（1 号用原来的目录与令牌位置）。
 */
export function planClones(input: {
  events: readonly CloneEvent[];
  running: readonly RunningClone[];
  max: number;
  now: number;
  batchMs: number;
}): ClonePlan {
  const max = cloneLimit(input.max);
  const heldGroups = new Set(input.running.flatMap((c) => c.groups));
  const held = input.events.filter(
    (e) => e.group !== null && heldGroups.has(e.group),
  );
  const open = input.events.filter((e) => !held.includes(e));
  const used = new Set(input.running.map((c) => c.slot));
  const slots: number[] = [];
  for (let slot = 1; slot <= max; slot++) if (!used.has(slot)) slots.push(slot);
  const plan: ClonePlan = { start: [], held: idsOf(held) };
  if (!open.length || !slots.length) return plan;
  const ready = (events: readonly CloneEvent[]) =>
    events.length > 0 && earliest(events) + input.batchMs <= input.now;

  // 上限为 1：和从前一样，一个唤醒送全部。
  if (max === 1) {
    if (!ready(open)) return plan;
    const big = open.some((e) => laneOf(e.kind) === "big");
    const groups = groupsOf(open);
    plan.start.push({
      slot: slots[0]!,
      lane: big ? "big" : "routine",
      label: big && groups.length === 1 ? groups[0]! : ROUTINE_LABEL,
      groups,
      eventIds: idsOf(open),
    });
    return plan;
  }

  // 有大事的组整组交给大事分身（同一组只归一个分身），其余都是日常。
  const bigGroups = new Map<string, CloneEvent[]>();
  for (const e of open)
    if (laneOf(e.kind) === "big" && e.group !== null)
      bigGroups.set(e.group, []);
  for (const e of open)
    if (e.group !== null && bigGroups.has(e.group))
      bigGroups.get(e.group)!.push(e);
  // 没有任务的大事（少见）当日常处理：没有组可认领。
  const routine = open.filter(
    (e) => e.group === null || !bigGroups.has(e.group),
  );

  const free = slots.slice();
  const routineRunning = input.running.filter(
    (c) => c.lane === "routine",
  ).length;
  if (!routineRunning && ready(routine)) {
    plan.start.push({
      slot: free.shift()!,
      lane: "routine",
      label: ROUTINE_LABEL,
      groups: groupsOf(routine),
      eventIds: idsOf(routine),
    });
  }
  let bigRunning = input.running.length - routineRunning;
  const candidates = [...bigGroups]
    .map(([group, events]) => ({ group, events }))
    .filter((c) => ready(c.events))
    .sort((a, b) => earliest(a.events) - earliest(b.events));
  for (const candidate of candidates) {
    // 给日常留一个位置：大事至多占 上限-1 个分身。
    if (!free.length || bigRunning >= max - 1) break;
    plan.start.push({
      slot: free.shift()!,
      lane: "big",
      label: candidate.group,
      groups: [candidate.group],
      eventIds: idsOf(candidate.events),
    });
    bigRunning++;
  }
  return plan;
}

/**
 * leader 令牌来自某个分身时，动一件任务前看它的组是不是被别的分身占着（同一任务同一时刻只归一个分身）。
 * 没占着返回 null。
 */
export function claimVerdict(input: {
  leader: string;
  task: string;
  group: string;
  mine: readonly string[];
  siblings: readonly Pick<RunningClone, "label" | "groups">[];
}): string | null {
  if (input.mine.includes(input.group)) return null;
  const owner = input.siblings.find((s) => s.groups.includes(input.group));
  if (!owner) return null;
  return `${input.task} 属于 ${input.group}，正由 ${input.leader} 的另一个分身（${owner.label}）处理；这件留给它，你只处理自己认领的事，要交代的写进备忘`;
}

/** 状态栏与 leader 详情的「在处理什么」：一个分身给它的摘要，几个分身给「N 件：…；…」。 */
export function busyLine(
  clones: readonly { label: string; summary: string }[],
): string {
  if (clones.length <= 1) return clones[0]?.summary ?? "";
  return `${clones.length} 件：${clones
    .map((c) =>
      c.label === ROUTINE_LABEL || c.summary.startsWith(c.label)
        ? c.summary
        : `${c.label} ${c.summary}`,
    )
    .join("；")}`;
}

export type MemoTarget =
  | { kind: "part"; part: string }
  | { kind: "merge"; before: number; part: string | null }
  | { kind: "main" };

/**
 * leader 写备忘写到哪（多分身共用一份备忘，不互相覆盖）：
 * 有别的分身在跑时只写自己这一段（按认领的事分段）；只剩自己时合并——覆盖主备忘，
 * 并清掉自己这段与唤醒开始时已经看到的各段（之后别的分身新写的段留着）。用户与秘书改的是主备忘。
 */
export function memoTarget(
  clone: { label: string; started: number; siblings: number } | undefined,
): MemoTarget {
  if (!clone) return { kind: "main" };
  if (clone.siblings > 0) return { kind: "part", part: clone.label };
  return { kind: "merge", before: clone.started, part: clone.label };
}
