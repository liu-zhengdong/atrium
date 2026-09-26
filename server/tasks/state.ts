/**
 * 任务状态转移只在这里判定（#262）：输入当前状态与事件，输出新状态或拒绝。
 * 纯函数，不碰数据库和时间；落库、时间戳和事件记录在 ledger.ts。
 */
export const TASK_STATUSES = [
  "todo",
  "running",
  "done",
  "failed",
  "blocked",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const isTaskStatus = (value: unknown): value is TaskStatus =>
  typeof value === "string" &&
  (TASK_STATUSES as readonly string[]).includes(value);

/** 进入这些状态即记结束时间。 */
export const FINISHED: ReadonlySet<TaskStatus> = new Set([
  "done",
  "failed",
  "cancelled",
]);

export type TaskEvent =
  /** 执行者进程已拉起。 */
  | { kind: "start" }
  /** 执行者退出码为 0。 */
  | { kind: "exit_ok" }
  /** 执行者退出码非 0、被杀或 pid 已消失。 */
  | { kind: "exit_fail" }
  /** 验收关卡全部通过（退出后直接通过，或受阻等 CI 后补通过）。 */
  | { kind: "accept" }
  /** 缺条件、等决策，暂不能推进。 */
  | { kind: "block" }
  /** 不再做。 */
  | { kind: "cancel" }
  /** 人工修正（task set / PATCH status）。 */
  | { kind: "manual_set"; to: TaskStatus };
export type TaskEventKind = TaskEvent["kind"];
export const TASK_EVENT_KINDS: readonly TaskEventKind[] = [
  "start",
  "exit_ok",
  "exit_fail",
  "accept",
  "block",
  "cancel",
  "manual_set",
];

export type Transition =
  | { ok: true; status: TaskStatus; changed: boolean }
  | { ok: false; reason: string };

const reject = (reason: string): Transition => ({ ok: false, reason });
const to = (from: TaskStatus, status: TaskStatus): Transition => ({
  ok: true,
  status,
  changed: from !== status,
});

export function transition(from: TaskStatus, event: TaskEvent): Transition {
  switch (event.kind) {
    case "start":
      // 失败或受阻后可以再派；已完成、已取消要先人工改回 todo，正在跑的不能重复派。
      if (from === "todo" || from === "failed" || from === "blocked")
        return to(from, "running");
      if (from === "running") return reject("任务正在运行，不能重复启动");
      return reject(`任务已${label[from]}，要重做先改回 todo`);
    case "exit_ok":
    case "exit_fail":
      if (from !== "running")
        return reject(`任务不在运行（当前 ${from}），忽略执行者退出`);
      return to(from, event.kind === "exit_ok" ? "done" : "failed");
    case "accept":
      if (from === "running" || from === "blocked") return to(from, "done");
      return reject(`任务当前 ${from}，不能按验收通过收尾`);
    case "block":
      if (from === "todo" || from === "running") return to(from, "blocked");
      if (from === "blocked") return reject("任务已经受阻");
      return reject(`任务已${label[from]}，不能再标受阻`);
    case "cancel":
      if (from === "done") return reject("任务已完成，不能取消");
      if (from === "cancelled") return reject("任务已经取消");
      return to(from, "cancelled");
    case "manual_set":
      if (!isTaskStatus(event.to)) return reject("未知的任务状态");
      // running 只能由真实拉起的执行者进入，人工标记不会带来进程。
      if (event.to === "running" && from !== "running")
        return reject("running 只能由执行者启动进入，请用 atrium task run");
      return to(from, event.to);
  }
}

const label: Record<TaskStatus, string> = {
  todo: "待办",
  running: "运行",
  done: "完成",
  failed: "失败",
  blocked: "受阻",
  cancelled: "取消",
};
