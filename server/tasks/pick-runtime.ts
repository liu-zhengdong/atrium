import type { DatabaseSync } from "node:sqlite";
import { detectInstalled, type Tool } from "./adapters/index.ts";
import { readQuotaReservePercent } from "./budget.ts";
import { workerStats, type WorkerStat } from "./delivery-records.ts";
import { getJobRole } from "./job-roles.ts";
import type { Task } from "./ledger.ts";
import { pickView, type PickCandidateFact, type PickRecord } from "./pick.ts";
import { FALLBACK_ORDER, type PaceEntry } from "./prepare.ts";
import { resolveWorker, type Risk } from "./profiles.ts";
import { rankRoleWorkers } from "./role-ranking.ts";
import { quotaHeadroom } from "./usage-budget.ts";
import type { LaunchOptions } from "./workspace.ts";
import { taskAvoidChain } from "../skills/task-skills.ts";

/**
 * 收集派活候选的事实（task pick 与 task run 自动挑人共用）：干活的专员与交付记录、已装工具、档案、
 * 额度与保留份额、正忙的独占工具；判定与排序在 pick.ts。
 */

export type PickContext = {
  db: DatabaseSync;
  launchOptions: LaunchOptions;
  /** 已读好的 OpenQuota 数据；undefined 表示读不到。 */
  pace: readonly PaceEntry[] | undefined;
  held: ReadonlyMap<string, number>;
  busy: ReadonlySet<Tool>;
};

const recordOf = (
  stats: readonly WorkerStat[],
  worker: string,
  role: string | null,
): PickRecord | undefined => {
  const stat = stats.find(
    (s) => s.scope === "combination" && s.worker === worker && s.role === role,
  );
  return stat
    ? {
        deliveries: stat.deliveries,
        first_pass_rate: stat.first_pass_rate,
        low_data: stat.low_data,
      }
    : undefined;
};

export async function pickFacts(task: Task, risk: Risk, ctx: PickContext) {
  const { db, launchOptions: options } = ctx;
  const chain = taskAvoidChain(db, task);
  const nodeId = chain.at(-1)?.id;
  const reservePercent = readQuotaReservePercent(db, nodeId);
  const pace = ctx.pace ? [...ctx.pace] : undefined;
  const headroom = quotaHeadroom(db, nodeId ?? null, pace, reservePercent);
  const installed = detectInstalled(options.env.PATH ?? "");
  const job = task.job_id ? getJobRole(db, `r${task.job_id}`) : null;
  const jobStats = job ? workerStats(db, { job: job.id }) : [];
  const names: { name: string; preferred: number | null }[] = [
    ...(job ? rankRoleWorkers(job.preferred, jobStats, job.name) : []).map(
      (name, index) => ({ name, preferred: index }),
    ),
    ...FALLBACK_ORDER.filter((tool) => installed[tool]).map((tool) => ({
      name: tool,
      preferred: null,
    })),
  ];
  const candidates: PickCandidateFact[] = [];
  for (const { name, preferred } of names) {
    let worker;
    try {
      worker = await resolveWorker(name, db);
    } catch {
      // 档案读不了或标识不合法（旧记录）：不当候选，其余照常。
      continue;
    }
    const seen = candidates.find((c) => c.worker === worker.id);
    if (seen) {
      if (seen.preferred === null) seen.preferred = preferred;
      continue;
    }
    candidates.push({
      worker: worker.id,
      tool: worker.tool,
      installed: !!installed[worker.tool],
      rules: worker.profile.rules,
      preferred,
    });
  }
  const records = new Map<string, PickRecord>();
  for (const candidate of candidates) {
    const record = job
      ? recordOf(jobStats, candidate.worker, job.name)
      : // 没有专员时只按执行者看最近一千条，不区分专员（与旧行为一致）。
        recordOf(
          workerStats(
            db,
            { worker: candidate.worker },
            { limitPerWorker: 1000, roleNull: true },
          ),
          candidate.worker,
          null,
        );
    if (record) records.set(candidate.worker, record);
  }
  return {
    risk,
    job: job ? { ref: job.ref, name: job.name } : null,
    candidates,
    pace,
    held: ctx.held,
    reservePercent,
    headroom,
    busy: ctx.busy,
    chain,
    records,
  };
}

/** 收集事实并给出候选一览。 */
export async function pickFor(task: Task, risk: Risk, ctx: PickContext) {
  return pickView(await pickFacts(task, risk, ctx));
}
