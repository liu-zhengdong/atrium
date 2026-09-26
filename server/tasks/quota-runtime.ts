import type { DatabaseSync } from "node:sqlite";
import type { Active } from "./active.ts";
import { ADAPTERS } from "./adapters/index.ts";
import type { EventInbox } from "./events.ts";
import type { Executors } from "./executors.ts";
import { DEFAULT_OWNER, getTask, noteTask } from "./ledger.ts";
import {
  clock,
  DEFAULT_UNKNOWN_HOLD_MS,
  ensureQuotaHoldTable,
  expiredHolds,
  heldProviders,
  holdUntil,
  listHolds,
  placeHold,
  releaseHold,
  routeAfterQuota,
} from "./quota-holds.ts";
import { enqueue } from "./queue.ts";
import type { QuotaHit } from "./settle.ts";
import { chooseWorker, type Choice } from "./worker-choice.ts";
import type { LaunchOptions } from "./workspace.ts";

/**
 * 额度用尽的运行时编排（#267 2）：记账号标记、按档案换执行者重派一次或排队、到点解除并重派。
 * 判定在 quota-holds.ts 的纯函数里，这里只执行并落库。
 */

export type QuotaContext = {
  db: DatabaseSync;
  inbox: EventInbox;
  launchOptions: LaunchOptions;
  /** 报文没给恢复时间时标记保留多久；缺省 1 小时。 */
  unknownMs?: number;
};

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export class QuotaGuard {
  private readonly unknownMs: number;

  constructor(private readonly ctx: QuotaContext) {
    ensureQuotaHoldTable(ctx.db);
    this.unknownMs = ctx.unknownMs ?? DEFAULT_UNKNOWN_HOLD_MS;
  }

  /** 还没到期的账号标记：provider → 到期时刻。 */
  held(now = Date.now()) {
    return heldProviders(listHolds(this.ctx.db), now, this.unknownMs);
  }

  /**
   * 任务已按额度用尽置为受阻之后：记账号标记，再按档案换执行者、排队或留在受阻。
   * 同一账号已有未到期标记时（并行的任务先报过），自动换人或排队不再发事件；留在受阻的照发。
   */
  async exhausted(x: Executors, active: Active, hit: QuotaHit) {
    const { db } = this.ctx;
    const now = Date.now();
    const until = holdUntil(hit.resetAt, now, this.unknownMs);
    const { fresh } = placeHold(
      db,
      { provider: hit.provider, until, reason: hit.reason },
      now,
      this.unknownMs,
    );
    const base = { reason: hit.reason, provider: hit.provider, until };
    noteTask(db, active.id, "quota_exhausted", {
      ...base,
      fresh,
      evidence: hit.evidence,
    });
    const route = routeAfterQuota({
      switchAllowed: active.worker.profile.rules.switch_on_quota !== false,
      switched: getTask(db, active.id).events.some(
        (event) => event.kind === "quota_switch",
      ),
    });
    if (route.kind === "blocked")
      return x.publish(active.id, "blocked", { ...base, note: route.why });
    // 挑人期间占住「正在启动」，免得 task wait 在受阻的一瞬间就返回。
    x.launching.set(active.id, null);
    try {
      let choice: Choice;
      try {
        choice = await chooseWorker(
          { risk: active.risk },
          this.ctx.launchOptions,
          this.held(),
          { busy: x.busyTools(active.id) },
        );
      } catch (error) {
        return x.publish(active.id, "blocked", {
          ...base,
          note: `没有可换的执行者：${message(error)}`,
        });
      }
      const tool = choice.worker.tool;
      if (
        choice.waitUntil !== undefined ||
        (ADAPTERS[tool].exclusive && x.busy(tool, active.id))
      )
        return this.park(x, active, choice, base, fresh);
      await this.switchTo(x, active, choice, base, fresh);
    } finally {
      x.launching.delete(active.id);
    }
  }

  /** 换到别的执行者重派一次；事件写明从谁换到谁。 */
  private async switchTo(
    x: Executors,
    active: Active,
    choice: Choice,
    base: Record<string, unknown>,
    fresh: boolean,
  ) {
    const switched = { from: active.worker.id, to: choice.worker.id };
    noteTask(this.ctx.db, active.id, "quota_switch", switched);
    x.active.delete(active.id);
    x.launching.set(active.id, choice.worker.tool);
    try {
      await x.launch(active.id, choice);
    } catch (error) {
      return x.publish(active.id, "blocked", {
        ...base,
        note: `换执行者 ${choice.worker.id} 拉起失败：${message(error)}`,
      });
    } finally {
      x.launching.delete(active.id);
    }
    if (fresh) x.publish(active.id, "quota_switched", { ...base, ...switched });
  }

  /** 没有可换的：留在排队（状态保持受阻），等账号恢复或独占工具空出来再派。 */
  private park(
    x: Executors,
    active: Active,
    choice: Choice,
    base: Record<string, unknown>,
    fresh: boolean,
  ) {
    const { db } = this.ctx;
    enqueue(db, {
      task_id: active.id,
      tool: choice.worker.tool,
      worker: choice.worker.id,
      risk: choice.risk,
      queued_at: Date.now(),
    });
    const wait =
      choice.waitUntil === undefined
        ? `${choice.worker.tool} 正忙，空出来后派给 ${choice.worker.id}`
        : `等到 ${clock(choice.waitUntil)} 额度恢复后派给 ${choice.worker.id}`;
    noteTask(db, active.id, "queued", {
      worker: choice.worker.id,
      reason: wait,
    });
    if (fresh)
      x.publish(active.id, "quota_queued", {
        ...base,
        waiting: wait,
        ...(choice.waitUntil === undefined
          ? {}
          : { wait_until: choice.waitUntil }),
      });
  }

  /** 定时 tick：解除到期标记、发「额度恢复」事件，再把排队的任务拉起来。 */
  async releaseExpired(x: Executors) {
    const { db, inbox } = this.ctx;
    const now = Date.now();
    let released = false;
    for (const hold of expiredHolds(listHolds(db), now, this.unknownMs)) {
      if (!releaseHold(db, hold.provider, now, this.unknownMs)) continue;
      released = true;
      inbox.publish({
        subscriber: DEFAULT_OWNER,
        source: "quota",
        kind: "quota_restored",
        key: `quota:${hold.provider}`,
        detail: {
          provider: hold.provider,
          reason: `额度恢复：${hold.provider}`,
          since: hold.since,
          until: hold.until,
        },
      });
    }
    // 非独占工具一次只出队队首：一直拉到没有可出队的为止（队列有界，每轮至少出一个）。
    if (released) while ((await x.drain()) > 0);
  }
}
