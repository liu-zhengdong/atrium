import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { ref } from "../org/model.ts";
import { partRoute } from "../leaders/subscriber.ts";
import {
  advanceTask,
  atomically,
  createTask,
  type Task,
} from "../tasks/ledger.ts";
import { startPatrol } from "../tasks/patrol.ts";
import { clipBrief } from "../tasks/brief.ts";
import { productOfNode } from "../products/model.ts";
import { researchFacts } from "../products/facts.ts";
import { researchBrief } from "../products/brief.ts";
import type { EventInbox } from "../tasks/events.ts";
import { publishMaterialHints } from "../materials/hints.ts";
import { publishSecretHints } from "../secrets/hints.ts";
import { catchUp, dayLabel, decide, localOffset, type Offset } from "./plan.ts";
import {
  dueSchedules,
  insertSchedule,
  liveRow,
  openTask,
  recordRun,
  scheduleInput,
  scheduleRef,
  type ScheduleInput,
  type ScheduleRow,
} from "./model.ts";

/** 派发一件任务（TaskRunner.run），与 task run 同一条路：挑人、排队、闸门照旧。 */
export type Dispatch = {
  run: (reference: string, body: { worker?: string }) => Promise<unknown>;
  inbox: EventInbox;
};

type Round = { task: Task; scenario?: string };

/**
 * 建出本轮的任务（在调用方事务里）：patrol 与 `patrol run` 同一个入口，task / research 是节点下的普通任务，
 * research 只调研、不交 PR（挂在产品部上的按研究模板生成详述）。闲时 / 普通按节点缺省。
 */
export function createRound(
  db: DatabaseSync,
  row: Pick<
    ScheduleInput,
    "node_id" | "title" | "kind" | "brief" | "brief_path" | "by"
  >,
  now: number,
  offset: Offset = localOffset,
): Round {
  if (row.kind === "patrol") return startPatrol(db, ref(row.node_id));
  // 产品部的研究：详述按模板现取材料（全景、决定、选项单、巡检、失败与上线），登记时另写的详述附在后面。
  const product =
    row.kind === "research" ? productOfNode(db, row.node_id) : undefined;
  const brief = product
    ? clipBrief(
        [
          researchBrief(researchFacts(db, product, now, offset)),
          row.brief ? `\n## 补充\n${row.brief}` : "",
        ].join("\n"),
      )
    : row.brief;
  const task = createTask(
    db,
    {
      title: `${row.title} · ${dayLabel(now, offset)}`,
      part: ref(row.node_id),
      ...(brief === null ? {} : { brief }),
      ...(row.brief_path === null || product
        ? {}
        : { brief_path: row.brief_path }),
      ...(row.by === null ? {} : { by: row.by }),
      ...(row.kind === "research" ? { deliver: "none" } : {}),
    },
    now,
  );
  return { task };
}

/** 登记：先试建一轮再回滚，节点、专员、剧本建不出任务的当场报错，不等到点才失败。 */
export function addSchedule(
  db: DatabaseSync,
  raw: unknown,
  now = Date.now(),
  offset: Offset = localOffset,
) {
  const input = scheduleInput(db, raw);
  return atomically(db, () => {
    db.exec("SAVEPOINT schedule_probe");
    try {
      createRound(db, input, now, offset);
    } finally {
      db.exec("ROLLBACK TO schedule_probe; RELEASE schedule_probe");
    }
    return insertSchedule(db, input, now, offset);
  });
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export class SchedulePump {
  private busy = false;
  private closed = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly offset: Offset;
  private readonly now: () => number;

  constructor(
    private readonly db: DatabaseSync,
    private readonly dispatch: Dispatch,
    private readonly options: {
      tickMs?: number;
      now?: () => number;
      offset?: Offset;
      /** 任务运行时接管完上次在跑的任务才开始（否则上一轮的状态还不准）。 */
      ready?: () => boolean;
      /** 一键停机（server/pause.ts）：这个节点（全局或所在部分）暂停着就不生成，恢复后到点的只补一轮。 */
      paused?: (node: number) => boolean;
    } = {},
  ) {
    this.offset = options.offset ?? localOffset;
    this.now = options.now ?? Date.now;
  }

  start() {
    this.timer = setInterval(() => {
      this.tick().catch((error) => console.error("周期任务：", error));
    }, this.options.tickMs ?? 30_000);
    this.timer.unref();
  }

  close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
  }

  /** 到点的逐条处理：一次一条索引查询，空闲时不碰任务表。 */
  async tick() {
    if (this.busy || this.closed || this.options.ready?.() === false) return;
    this.busy = true;
    try {
      const now = this.now();
      for (const row of dueSchedules(this.db, now)) {
        if (this.closed) return;
        if (this.options.paused?.(row.node_id)) continue;
        try {
          await this.fire(row, now);
        } catch (error) {
          // 单条坏记录不挡别的：挪到下一轮并记一笔。
          console.error(`周期任务 ${scheduleRef(row.id)}：`, error);
          this.failed(
            row,
            null,
            message(error),
            now,
            catchUp(row.next_at, row.every_ms, row.at_minute, now, this.offset)
              .next,
          );
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private async fire(row: ScheduleRow, now: number) {
    const decision = decide(
      { ...row, removed: false },
      openTask(this.db, row),
      now,
      this.offset,
    );
    if (decision.kind === "wait") return;
    const missed = decision.missed
      ? `服务停机错过 ${decision.missed} 轮，只补这一轮`
      : null;
    if (decision.kind === "skip") {
      atomically(this.db, () => {
        this.advance(row.id, decision.next_at, now);
        recordRun(
          this.db,
          row.id,
          "skipped",
          null,
          [`上一轮 ${decision.open} 还没结束，跳过本轮`, missed]
            .filter(Boolean)
            .join("；"),
          now,
        );
      });
      return;
    }
    await this.round(row, now, { next_at: decision.next_at, note: missed });
  }

  /** 登记与恢复用同一个时钟与时区（测试注入）。 */
  add(raw: unknown) {
    return addSchedule(this.db, raw, this.now(), this.offset);
  }

  /** 手动触发一轮（`schedule run`）：不动下一轮的时间；上一轮没结束就不起。 */
  async runNow(reference: unknown) {
    const row = liveRow(this.db, reference);
    const open = openTask(this.db, row);
    if (open)
      throw new Problem(
        409,
        `${scheduleRef(row.id)} 上一轮 ${open} 还没结束；等它：atrium task wait ${open}`,
        "conflict",
      );
    return this.round(row, this.now(), null);
  }

  private advance(id: number, next: number, now: number) {
    this.db
      .prepare("UPDATE schedules SET next_at=?,updated_at=? WHERE id=?")
      .run(next, now, id);
  }

  /** 建一轮并派发；scheduled 为空是手动触发，失败时把错误抛给调用方。 */
  private async round(
    row: ScheduleRow,
    now: number,
    scheduled: { next_at: number; note: string | null } | null,
  ) {
    let made: Round & { run: number };
    try {
      made = atomically(this.db, () => {
        const round = createRound(this.db, row, now, this.offset);
        this.db
          .prepare(
            "UPDATE schedules SET last_task_id=?,next_at=?,updated_at=? WHERE id=?",
          )
          .run(round.task.id, scheduled?.next_at ?? row.next_at, now, row.id);
        const run = recordRun(
          this.db,
          row.id,
          "created",
          round.task.id,
          scheduled ? scheduled.note : "手动触发",
          now,
        );
        return { ...round, run };
      });
    } catch (error) {
      this.failed(
        row,
        null,
        `建不出任务：${message(error)}`,
        now,
        scheduled?.next_at ?? null,
      );
      if (!scheduled) throw error;
      return undefined;
    }
    // 例行巡检顺带看这一块的资料（t192）：只给 leader 线索，出错不挡本轮。
    try {
      publishMaterialHints(this.db, this.dispatch.inbox, row.node_id, now);
    } catch (error) {
      console.error(`周期任务 ${scheduleRef(row.id)} 的资料清理线索：`, error);
    }
    try {
      publishSecretHints(this.db, this.dispatch.inbox, row.node_id, now);
    } catch (error) {
      console.error(`周期任务 ${scheduleRef(row.id)} 的凭据清理线索：`, error);
    }
    try {
      const launched = await this.dispatch.run(
        made.task.ref,
        row.worker ? { worker: row.worker } : {},
      );
      return {
        schedule: scheduleRef(row.id),
        task: made.task,
        ...(made.scenario ? { scenario: made.scenario } : {}),
        ...(launched && typeof launched === "object"
          ? { queued: !!(launched as { queued?: unknown }).queued }
          : {}),
      };
    } catch (error) {
      const reason = `周期派发失败：${message(error)}`;
      try {
        advanceTask(this.db, made.task.id, { kind: "block" }, {}, { reason });
      } catch {
        /* 已被别处启动或结束：只记账。 */
      }
      this.db
        .prepare("UPDATE schedule_runs SET outcome='failed',note=? WHERE id=?")
        .run(reason, made.run);
      this.publish(row, made.task.id, reason);
      if (!scheduled) throw error;
      return undefined;
    }
  }

  /** 没建出任务：到点的挪到下一轮，记一笔并告诉该部分的 leader。 */
  private failed(
    row: ScheduleRow,
    taskId: number | null,
    reason: string,
    now: number,
    /** 到点的挪到哪一轮；手动触发为 null，不动。 */
    next: number | null,
  ) {
    atomically(this.db, () => {
      if (next !== null) this.advance(row.id, next, now);
      recordRun(this.db, row.id, "failed", taskId, reason, now);
    });
    this.publish(row, taskId, reason);
  }

  private publish(row: ScheduleRow, taskId: number | null, reason: string) {
    const route = partRoute(this.db, row.node_id);
    this.dispatch.inbox.publish({
      subscriber: route.subscriber,
      ...(taskId === null ? {} : { taskId }),
      source: "schedule",
      kind: "schedule_failed",
      key: `schedule:${scheduleRef(row.id)}`,
      detail: {
        schedule: scheduleRef(row.id),
        node: ref(row.node_id),
        title: row.title,
        reason,
        routed: { to: route.subscriber, why: route.why },
      },
    });
  }
}
