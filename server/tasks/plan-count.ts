/**
 * 排期计数（t190 / 巡检 f4）：就绪、等待中、因排期卡住各几件。`task plan`、`atrium top` 的排期段、
 * `atrium statusline` 都用这一个函数，口径一致。总任务不派、不进排期，服务端已排除（schedule.ts taskPlan）。
 * 纯函数，命令行也用：不引入服务端模块。
 */

type Entry = {
  task: { schedule_state?: string | null };
  reason: string | null;
};

export type PlanCounts = {
  ready: number;
  waiting: number;
  /** 因排期卡住（上游失败、取消或 PR 关闭）；执行失败、关卡不过的不算，它们在任务列表里。 */
  schedule_blocked: number;
};

/** 因排期卡住：排期器标的受阻，或原因是「上游 …」。 */
export const scheduleBlocked = (item: Entry) =>
  item.task.schedule_state === "blocked" ||
  (item.reason ?? "").startsWith("上游 ");

export function planCounts(groups: {
  ready?: readonly Entry[];
  waiting?: readonly Entry[];
  blocked?: readonly Entry[];
}): PlanCounts {
  return {
    ready: groups.ready?.length ?? 0,
    waiting: groups.waiting?.length ?? 0,
    schedule_blocked: (groups.blocked ?? []).filter(scheduleBlocked).length,
  };
}
