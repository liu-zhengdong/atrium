import type { DatabaseSync } from "node:sqlite";
import type { Active } from "./active.ts";
import { ADAPTERS } from "./adapters/index.ts";
import type { Executors } from "./executors.ts";
import { getTask, noteTask } from "./ledger.ts";
import { clock } from "./quota-holds.ts";
import {
  routeAfterTransient,
  transientAttempts,
  type TransientHit,
} from "./transient.ts";
import { chooseWorker, type Choice } from "./worker-choice.ts";
import type { LaunchOptions } from "./workspace.ts";
import { taskAvoidChain } from "../skills/task-skills.ts";

/**
 * 临时错误后的重派（#262）：任务按退出码记账后，同一执行者重试一次，再失败按档案换执行者重派一次。
 * 判定在 transient.ts 的纯函数里，这里只执行并落库。
 */

export type TransientContext = {
  db: DatabaseSync;
  launchOptions: LaunchOptions;
  held: () => ReadonlyMap<string, number>;
};

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * 换一个执行者：按现有挑选逻辑排除刚失败的工具。换过去还得排队或正忙的不换，返回原因（「没有可换的执行者……」）。
 */
export async function chooseAnother(
  x: Executors,
  ctx: TransientContext,
  active: Active,
): Promise<Choice | { note: string }> {
  let choice: Choice;
  try {
    choice = await chooseWorker(
      { risk: active.risk },
      ctx.launchOptions,
      ctx.held(),
      {
        busy: x.busyTools(active.id),
        exclude: new Set([active.tool]),
        chain: taskAvoidChain(ctx.db, getTask(ctx.db, active.id)),
      },
    );
  } catch (error) {
    return { note: `没有可换的执行者：${message(error)}` };
  }
  const tool = choice.worker.tool;
  // 换过去还得排队的不排：排队后的拉起算新一轮，重试次数会被清零。
  if (choice.waitUntil !== undefined)
    return {
      note: `可换的 ${choice.worker.id} 额度用尽至 ${clock(choice.waitUntil)}`,
    };
  if (ADAPTERS[tool].exclusive && x.busy(tool, active.id))
    return { note: `可换的 ${choice.worker.id} 正忙` };
  return choice;
}

/** reason 是任务的失败原因（含临时错误类别与退出码），放弃时原样投递。 */
export async function retryAfterTransient(
  x: Executors,
  ctx: TransientContext,
  active: Active,
  hit: TransientHit,
  reason: string,
) {
  const { db } = ctx;
  const route = routeAfterTransient({
    allowed: active.worker.profile.rules.retry_on_transient !== false,
    attempts: transientAttempts(getTask(db, active.id).events),
  });
  const base = { reason, evidence: hit.evidence };
  if (route.kind === "fail")
    return x.publish(active.id, "failed", { ...base, note: route.why });
  // 挑人期间占住「正在启动」，免得 task wait 在失败的一瞬间就返回。
  x.launching.set(active.id, null);
  try {
    let choice: Choice;
    if (route.kind === "same")
      choice = { worker: active.worker, risk: active.risk };
    else {
      const other = await chooseAnother(x, ctx, active);
      if (x.isClosed()) return;
      if ("note" in other)
        return x.publish(active.id, "failed", {
          ...base,
          note: `临时错误后${other.note}`,
        });
      choice = other;
    }
    const retry = {
      retry: route.kind,
      attempt: route.attempt,
      from: active.worker.id,
      to: choice.worker.id,
    };
    noteTask(db, active.id, "transient_retry", { ...base, ...retry });
    x.active.delete(active.id);
    // 同一执行者重试留在原来那台主机上（#358）；换执行者的按本机派。
    const host = route.kind === "same" ? active.host : undefined;
    x.claim(active.id, choice.worker.tool, host);
    try {
      await x.launch(active.id, { ...choice, host }, true);
    } catch (error) {
      if (x.isClosed()) return;
      const why = `临时错误后重派 ${choice.worker.id} 拉起失败：${message(error)}`;
      noteTask(db, active.id, "retry_failed", { reason: why });
      return x.publish(active.id, "failed", { ...base, note: why });
    }
    if (x.isClosed()) return;
    x.publish(active.id, "transient_retry", { ...base, ...retry });
  } finally {
    x.release(active.id);
  }
}
