import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import type { TaskRunner } from "../tasks/runner.ts";
import { noteTask } from "../tasks/ledger.ts";
import { publishTask } from "../tasks/notice.ts";
import { createPlanTask } from "./store.ts";

/**
 * 派规划任务（t275）：建好就按 task run 同一条路派出（执行者按候选挑）。
 * 手动（plan-for）派不出去时把原因交回调用方；运行时自动派的（选项单拍板、task add --plan）
 * 派不出去就记在规划任务上并投 plan_failed 给负责的 leader，免得没人知道。
 */

export type PlanStarted = {
  task: { ref: string; id: number };
  target: string;
  queued?: boolean;
  run_error?: string;
  next: string;
};

export async function startPlan(
  db: DatabaseSync,
  runner: TaskRunner,
  target: string,
  options: { worker?: string; by?: string; auto?: boolean } = {},
): Promise<PlanStarted> {
  const task = createPlanTask(db, target, options.by);
  try {
    const launched = (await runner.run(
      task.ref,
      options.worker ? { worker: options.worker } : {},
      options.by,
    )) as { queued?: boolean };
    return {
      task: { ref: task.ref, id: task.id },
      target,
      queued: !!launched.queued,
      next: `等清单：atrium task wait ${task.ref}，再 atrium task adopt-plan ${task.ref} --dry-run`,
    };
  } catch (error) {
    // 派不出去不删任务：原因给调用方，换个执行者再派。
    if (!(error instanceof Problem)) throw error;
    const next = `atrium task run ${task.ref} --worker 工具+模型`;
    if (options.auto) {
      noteTask(db, task.id, "plan_unsent", { reason: error.message });
      publishTask(runner.inbox, db, task.id, "plan_failed", {
        title: task.title,
        target,
        plan: task.ref,
        plan_error: `规划任务没派出去：${error.message}`,
        next,
      });
    }
    return {
      task: { ref: task.ref, id: task.id },
      target,
      run_error: error.message,
      next,
    };
  }
}

/**
 * 总任务建出来后是否自动派规划（选项单拍板、task add --plan）：`ATRIUM_AUTO_PLAN=0` 关、`=1` 开；
 * 缺省只在默认数据目录的服务上开（同 leader 唤醒）：隔离服务不自己拉起执行者、不耗额度，规划任务照样可以手动派。
 */
export function autoPlanEnabled(
  setting: string | undefined,
  service: { defaultData: boolean },
): boolean {
  if (setting === "0") return false;
  if (setting === "1") return true;
  return service.defaultData;
}
