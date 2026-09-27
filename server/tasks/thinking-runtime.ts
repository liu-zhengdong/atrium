import type { Active } from "./active.ts";
import type { Executors } from "./executors.ts";
import { getTask, noteTask } from "./ledger.ts";
import type { ExitDecision } from "./outcome.ts";
import { thinkingAttempts, type ThinkingRoute } from "./thinking.ts";
import { chooseAnother, type TransientContext } from "./transient-runtime.ts";

/**
 * 思考耗尽单次输出后的换人重跑（#262）：任务已按关卡转为受阻之后，换一个执行者重跑一次；
 * 再耗尽或没得换就留在受阻，按原来的方式投递。判定在 thinking.ts 的纯函数里，这里只执行并落库。
 */

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const attemptsOf = (ctx: TransientContext, id: number) =>
  thinkingAttempts(getTask(ctx.db, id).events);

/** detail 是不重跑时原样投递的内容（原因、关卡）；reason 为任务受阻原因，写明思考耗尽。 */
export async function retryAfterThinking(
  x: Executors,
  ctx: TransientContext,
  active: Active,
  route: Exclude<ThinkingRoute, { kind: "none" }>,
  decision: ExitDecision,
  detail: Record<string, unknown>,
) {
  const { db } = ctx;
  const giveUp = (note: string) =>
    x.publish(active.id, decision.publish, { ...detail, note });
  if (route.kind === "give_up") return giveUp(route.why);
  // 挑人期间占住「正在启动」，免得 task wait 在受阻的一瞬间就返回。
  x.launching.set(active.id, null);
  try {
    const choice = await chooseAnother(x, ctx, active);
    if (x.isClosed()) return;
    if ("note" in choice) return giveUp(`思考耗尽后${choice.note}`);
    const retry = {
      reason: decision.reason,
      retry: "switch",
      attempt: 1,
      from: active.worker.id,
      to: choice.worker.id,
    };
    noteTask(db, active.id, "thinking_retry", retry);
    x.active.delete(active.id);
    x.launching.set(active.id, choice.worker.tool);
    try {
      await x.launch(active.id, choice, true);
    } catch (error) {
      if (x.isClosed()) return;
      const why = `思考耗尽后换 ${choice.worker.id} 拉起失败：${message(error)}`;
      noteTask(db, active.id, "retry_failed", { reason: why });
      return giveUp(why);
    }
    if (x.isClosed()) return;
    x.publish(active.id, "thinking_retry", retry);
  } finally {
    x.launching.delete(active.id);
  }
}
