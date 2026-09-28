import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clipBrief } from "./brief.ts";
import type { DatabaseSync } from "node:sqlite";
import { redact } from "../secret-redact.ts";
import { taskDir } from "./active.ts";
import { parseNumstat } from "./gate-parse.ts";
import { defaultBranch, type Exec } from "./git.ts";
import { originRepo, repoFlag } from "./gh-repo.ts";
import { ADOPTED_EXIT } from "./outcome.ts";
import {
  atomically,
  createTask,
  getTask,
  noteTask,
  type Task,
} from "./ledger.ts";
import {
  isRisk,
  resolveWorker,
  type ResolvedWorker,
  type Risk,
} from "./profiles.ts";
import {
  diffSummary,
  parseReviewVerdict,
  reviewBrief,
  reviewNeed,
  type DiffSummary,
} from "./review.ts";
import { openAfterReviews, type AfterReview } from "./urgent-ledger.ts";

/** 最近一次派活记下的风险；旧事件或坏记录按 low。 */
export function taskRisk(db: DatabaseSync, id: number): Risk {
  const start = db
    .prepare(
      "SELECT detail FROM task_events WHERE task_id=? AND kind='start' ORDER BY id DESC LIMIT 1",
    )
    .get(id) as { detail: string | null } | undefined;
  try {
    const risk = (
      JSON.parse(start?.detail ?? "{}") as { detail?: { risk?: unknown } }
    ).detail?.risk;
    return isRisk(risk) ? risk : "low";
  } catch {
    return "low";
  }
}

/**
 * 审阅者只因「服务重启后接管、退出码不可得」判失败（纯文本工具判不了收尾）：结论行本身证明它跑完了，照样读结论。
 */
function adoptedExit(db: DatabaseSync, id: number) {
  const row = db
    .prepare(
      "SELECT detail FROM task_events WHERE task_id=? AND kind='exit_fail' ORDER BY id DESC LIMIT 1",
    )
    .get(id) as { detail: string | null } | undefined;
  try {
    const reason = (
      JSON.parse(row?.detail ?? "{}") as { detail?: { reason?: unknown } }
    ).detail?.reason;
    return typeof reason === "string" && reason.startsWith(ADOPTED_EXIT);
  } catch {
    return false;
  }
}

export type Admitted = { kind: string; detail?: Record<string, unknown> };

/**
 * 审阅关卡（#325 设计 3）：过了交付关卡的 PR，高风险或低信任执行者的先派不同模型的审阅者，
 * 通过再进合入队列，打回按合入交回处理。进度落在 tasks.delivery_stage='reviewing' 与 review_task，
 * 每次巡检从账本续上，服务重启不丢。
 */
export class ReviewGate {
  private closed = false;
  private sweeping = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly options: {
      data: string;
      run: Exec;
      /** 挑一个与原执行者不同模型的审阅者，返回执行者标识；挑不到抛出原因。 */
      pickReviewer: (original: ResolvedWorker | undefined) => Promise<string>;
      launch: (ref: string, worker: string) => Promise<unknown>;
      /** 审阅任务是否仍在跑、排队、启动或收尾。 */
      inFlight: (id: number) => boolean;
      stopTask: (ref: string, by?: string) => void;
      enqueue: (id: number) => void;
      handBack: (task: Task, reason: string) => Promise<void>;
      publish: (
        id: number,
        kind: string,
        detail: Record<string, unknown>,
        actor?: string,
      ) => void;
      changed: (id: number) => void;
    },
  ) {}

  close() {
    this.closed = true;
  }

  private async worker(task: Task) {
    if (!task.worker) return undefined;
    try {
      return await resolveWorker(task.worker, this.db);
    } catch {
      return undefined;
    }
  }

  /** 交付关卡通过后的去向：要审阅的进 reviewing，其余直接进合入队列；不走合入的返回 false。 */
  async admit(id: number): Promise<Admitted | false> {
    const task = getTask(this.db, id);
    if (task.deliver !== "pr" || !task.pr_url || !task.repo) return false;
    const risk = taskRisk(this.db, id);
    const original = await this.worker(task);
    const need = reviewNeed(risk, original?.profile.rules.trust);
    if (!need.needed) {
      this.options.enqueue(id);
      return { kind: "merge_queued" };
    }
    // 紧急任务（t215）：审阅不挡合入，先进合入队列，审阅并行；审出问题开跟进任务补。
    if (task.urgent === 1) {
      this.db
        .prepare(
          `INSERT INTO task_after_reviews(task_id,review_task,started_at,settled_at,verdict,followup_task)
            VALUES (?,NULL,?,NULL,NULL,NULL)
            ON CONFLICT(task_id) DO UPDATE SET review_task=NULL,started_at=excluded.started_at,settled_at=NULL,verdict=NULL,followup_task=NULL`,
        )
        .run(id, Date.now());
      noteTask(this.db, id, "review_parallel", { reason: need.reason, risk });
      this.options.enqueue(id);
      this.kick();
      return {
        kind: "merge_queued",
        detail: {
          reason: `紧急：审阅与合入并行（${need.reason}），审出问题开跟进任务补`,
          risk,
        },
      };
    }
    const diff = await this.diff(task);
    atomically(this.db, () => {
      this.db
        .prepare(
          "UPDATE tasks SET delivery_stage='reviewing',review_task=NULL,merge_queued_at=NULL,updated_at=? WHERE id=?",
        )
        .run(Date.now(), id);
      noteTask(this.db, id, "review_needed", {
        reason: need.reason,
        risk,
        ...(diff ? { diff } : {}),
      });
    });
    this.options.changed(id);
    this.kick();
    return {
      kind: "review_queued",
      detail: {
        reason: `合入前审阅：${need.reason}${diff ? `；${diff.text}` : ""}`,
        risk,
        next: `atrium task show ${task.ref}`,
      },
    };
  }

  /** 改动规模：任务分支相对 origin/<默认分支>；查不到返回 undefined，不挡审阅。 */
  private async diff(task: Task): Promise<DiffSummary | undefined> {
    if (!task.repo || !task.worktree) return undefined;
    try {
      const base = await defaultBranch(task.repo, this.options.run);
      const out = await this.options.run(
        "git",
        [
          "--no-optional-locks",
          "-C",
          task.worktree,
          "diff",
          "--numstat",
          `origin/${base}...HEAD`,
        ],
        { timeoutMs: 30_000 },
      );
      return out.ok ? diffSummary(parseNumstat(out.stdout)) : undefined;
    } catch {
      return undefined;
    }
  }

  kick() {
    if (this.closed || this.sweeping) return;
    void this.sweep().catch((error) =>
      console.error("审阅关卡巡检失败：", redact(String(error))),
    );
  }

  private async sweep() {
    this.sweeping = true;
    try {
      const rows = this.db
        .prepare(
          "SELECT id FROM tasks WHERE delivery_stage='reviewing' ORDER BY id LIMIT 50",
        )
        .all() as { id: number }[];
      for (const { id } of rows) {
        if (this.closed) return;
        try {
          await this.step(getTask(this.db, id));
        } catch (error) {
          // 单条出错不影响其他任务；下一轮巡检再试。
          noteTask(this.db, id, "review_error", {
            reason: redact(
              error instanceof Error ? error.message : String(error),
            ),
          });
        }
      }
      for (const row of openAfterReviews(this.db)) {
        if (this.closed) return;
        try {
          await this.stepAfter(row);
        } catch (error) {
          noteTask(this.db, row.task_id, "review_error", {
            reason: redact(
              error instanceof Error ? error.message : String(error),
            ),
          });
        }
      }
    } finally {
      this.sweeping = false;
    }
  }

  private async step(task: Task) {
    if (task.delivery_stage !== "reviewing") return;
    if (task.review_task === null) return this.startReview(task);
    const reviewer = getTask(this.db, task.review_task);
    if (this.options.inFlight(reviewer.id) || reviewer.status === "running")
      return;
    if (reviewer.status === "todo") return this.launch(task, reviewer);
    if (
      reviewer.status !== "done" &&
      !(reviewer.status === "failed" && adoptedExit(this.db, reviewer.id))
    )
      return this.block(
        task,
        `审阅任务 ${reviewer.ref} ${reviewer.status}，没有给出结论`,
        reviewer.ref,
      );
    const verdict = parseReviewVerdict(reviewer.result);
    if (!verdict)
      return this.block(
        task,
        `审阅任务 ${reviewer.ref} 没有写「审阅结论：通过/打回」`,
        reviewer.ref,
      );
    const notes = redact(verdict.notes);
    if (verdict.passed) {
      noteTask(this.db, task.id, "review_passed", {
        reviewer: reviewer.ref,
        worker: reviewer.worker,
        ...(notes ? { notes } : {}),
      });
      this.options.publish(task.id, "review_passed", {
        reviewer: reviewer.ref,
      });
      this.options.enqueue(task.id);
      return;
    }
    noteTask(this.db, task.id, "review_rejected", {
      reviewer: reviewer.ref,
      worker: reviewer.worker,
      notes,
    });
    await this.options.handBack(
      task,
      `审阅打回（${reviewer.ref}，${reviewer.worker ?? "审阅者"}）：${notes || "审阅者没写具体问题"}`,
    );
  }

  /** 审阅者与审阅详述：挑人、写详述文件；缺东西或挑不到人返回原因。 */
  private async prepareReview(task: Task): Promise<
    | {
        ok: true;
        worker: string;
        text: string;
        file: string;
        diff: DiffSummary;
      }
    | { ok: false; reason: string }
  > {
    const { repo, worktree, pr_url: url } = task;
    if (!repo || !worktree || !url)
      return { ok: false, reason: "审阅缺少仓库、工作树或 PR" };
    const original = await this.worker(task);
    let worker: string;
    try {
      worker = await this.options.pickReviewer(original);
    } catch (error) {
      return {
        ok: false,
        reason: `找不到合格的审阅者：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const origin = await originRepo(repo, this.options.run);
    if ("error" in origin) return { ok: false, reason: origin.error };
    const base = await defaultBranch(repo, this.options.run);
    const diff = (await this.diff(task)) ?? diffSummary([]);
    const risk = taskRisk(this.db, task.id);
    const need = reviewNeed(risk, original?.profile.rules.trust);
    const dir = taskDir(this.options.data, task.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `review-${Date.now()}.md`);
    const text = clipBrief(
      reviewBrief({
        ref: task.ref,
        title: task.title,
        prUrl: url,
        repoFlag: repoFlag(origin.repo),
        worktree,
        base,
        risk,
        reason: need.needed ? need.reason : "按规则需审阅",
        diff,
        brief: task.brief ?? null,
      }),
    );
    writeFileSync(file, text, { mode: 0o600 });
    return { ok: true, worker, text, file, diff };
  }

  private async startReview(task: Task) {
    const prepared = await this.prepareReview(task);
    if (!prepared.ok) return this.block(task, prepared.reason);
    const { worker, text, file, diff } = prepared;
    const reviewer = atomically(this.db, () => {
      const current = getTask(this.db, task.id);
      if (current.delivery_stage !== "reviewing" || current.review_task)
        return null;
      const created = createTask(this.db, {
        title: `审阅 ${task.ref}：${task.title}`.slice(0, 200),
        brief: text,
        brief_path: file,
        deliver: "none",
        ...(task.owner ? { owner: task.owner } : {}),
      });
      noteTask(this.db, created.id, "review_of", { task: task.ref });
      this.db
        .prepare("UPDATE tasks SET review_task=?,updated_at=? WHERE id=?")
        .run(created.id, Date.now(), task.id);
      noteTask(this.db, task.id, "review_started", {
        reviewer: created.ref,
        worker,
        diff: diff.text,
      });
      return created;
    });
    if (!reviewer) return;
    this.options.changed(task.id);
    await this.launch(task, reviewer, worker);
  }

  private async launch(task: Task, reviewer: Task, worker?: string) {
    const chosen = worker ?? reviewer.worker;
    try {
      if (!chosen) {
        const original = await this.worker(task);
        await this.options.launch(
          reviewer.ref,
          await this.options.pickReviewer(original),
        );
      } else await this.options.launch(reviewer.ref, chosen);
    } catch (error) {
      this.block(
        task,
        `审阅任务 ${reviewer.ref} 派不出去：${error instanceof Error ? error.message : String(error)}`,
        reviewer.ref,
      );
    }
  }

  /**
   * 紧急任务合入后并行的审阅（t215）：没开审阅任务的先开并派出；审阅者结束后按结论收尾——
   * 通过记一笔；打回开一件跟进任务（附审阅意见）并投给负责人；没给结论也投给负责人。原任务的合入不受影响。
   */
  private async stepAfter(row: AfterReview) {
    const task = getTask(this.db, row.task_id);
    if (row.review_task === null) {
      const prepared = await this.prepareReview(task);
      if (!prepared.ok)
        return this.settleAfter(task, "error", null, prepared.reason);
      const reviewer = atomically(this.db, () => {
        const created = createTask(this.db, {
          title: `审阅 ${task.ref}（合入后）：${task.title}`.slice(0, 200),
          brief: prepared.text,
          brief_path: prepared.file,
          deliver: "none",
          ...(task.owner ? { owner: task.owner } : {}),
        });
        noteTask(this.db, created.id, "review_of", {
          task: task.ref,
          after_merge: true,
        });
        this.db
          .prepare(
            "UPDATE task_after_reviews SET review_task=? WHERE task_id=?",
          )
          .run(created.id, task.id);
        noteTask(this.db, task.id, "review_started", {
          reviewer: created.ref,
          worker: prepared.worker,
          diff: prepared.diff.text,
          parallel: true,
        });
        return created;
      });
      this.options.changed(task.id);
      try {
        await this.options.launch(reviewer.ref, prepared.worker);
      } catch (error) {
        this.settleAfter(
          task,
          "error",
          null,
          `审阅任务 ${reviewer.ref} 派不出去：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return;
    }
    const reviewer = getTask(this.db, row.review_task);
    if (this.options.inFlight(reviewer.id) || reviewer.status === "running")
      return;
    if (
      reviewer.status !== "done" &&
      !(reviewer.status === "failed" && adoptedExit(this.db, reviewer.id))
    )
      return this.settleAfter(
        task,
        "error",
        null,
        `合入后审阅 ${reviewer.ref} ${reviewer.status}，没有给出结论`,
      );
    const verdict = parseReviewVerdict(reviewer.result);
    if (!verdict)
      return this.settleAfter(
        task,
        "error",
        null,
        `合入后审阅 ${reviewer.ref} 没有写「审阅结论：通过/打回」`,
      );
    const notes = redact(verdict.notes);
    if (verdict.passed) {
      noteTask(this.db, task.id, "review_passed", {
        reviewer: reviewer.ref,
        worker: reviewer.worker,
        after_merge: true,
        ...(notes ? { notes } : {}),
      });
      this.settleAfter(task, "passed", null, null);
      this.options.publish(task.id, "review_passed", {
        reviewer: reviewer.ref,
        after_merge: true,
      });
      return;
    }
    const followup = atomically(this.db, () => {
      const created = createTask(this.db, {
        title: `跟进 ${task.ref} 的审阅意见：${task.title}`.slice(0, 200),
        brief: clipBrief(
          `紧急任务 ${task.ref}「${task.title}」为了尽快上线，审阅与合入并行，已合入（PR ${task.pr_url ?? "无"}）。\n` +
            `审阅者 ${reviewer.ref}（${reviewer.worker ?? "审阅者"}）打回，意见如下；请在新分支上逐条修复并开 PR。\n\n${notes || "审阅者没写具体问题，先看审阅任务的结果"}`,
        ),
        ...(task.repo ? { repo: task.repo } : {}),
        ...(task.owner ? { owner: task.owner } : {}),
        ...(task.part_id !== null ? { part: `o${task.part_id}` } : {}),
      });
      noteTask(this.db, task.id, "review_rejected", {
        reviewer: reviewer.ref,
        worker: reviewer.worker,
        notes,
        after_merge: true,
        followup: created.ref,
      });
      this.settleAfter(task, "rejected", created.id, null);
      return created;
    });
    this.options.publish(task.id, "review_followup", {
      reason: `合入后审阅打回（${reviewer.ref}）：${notes || "没写具体问题"}；已开跟进任务 ${followup.ref}`,
      reviewer: reviewer.ref,
      followup: followup.ref,
      next: `atrium task run ${followup.ref}`,
    });
  }

  /** 合入后审阅收尾：记结论；没给出结论的投给负责人看。 */
  private settleAfter(
    task: Task,
    verdict: "passed" | "rejected" | "error",
    followup: number | null,
    reason: string | null,
  ) {
    this.db
      .prepare(
        "UPDATE task_after_reviews SET settled_at=?,verdict=?,followup_task=? WHERE task_id=? AND settled_at IS NULL",
      )
      .run(Date.now(), verdict, followup, task.id);
    this.options.changed(task.id);
    if (verdict !== "error" || !reason) return;
    const safe = redact(reason);
    noteTask(this.db, task.id, "review_error", {
      reason: safe,
      after_merge: true,
    });
    this.options.publish(task.id, "review_followup", {
      reason: `${safe}；合入不受影响，要补审阅请另开任务`,
      next: `atrium task show ${task.ref}`,
    });
  }

  private block(task: Task, reason: string, reviewer?: string, by?: string) {
    const safe = redact(reason);
    const moved = atomically(this.db, () => {
      const current = getTask(this.db, task.id);
      if (current.delivery_stage !== "reviewing") return false;
      this.db
        .prepare(
          "UPDATE tasks SET delivery_stage=NULL,status='blocked',ended_at=NULL,updated_at=? WHERE id=?",
        )
        .run(Date.now(), task.id);
      noteTask(this.db, task.id, "review_blocked", { reason: safe });
      return true;
    });
    if (!moved) return;
    this.options.changed(task.id);
    this.options.publish(
      task.id,
      "blocked",
      {
        reason: safe,
        source: "review",
        next: `atrium task show ${reviewer ?? task.ref}`,
      },
      by,
    );
  }

  /** 用户停止审阅：停掉在跑的审阅者，原任务转卡住。不在审阅返回 null。 */
  stop(id: number, by?: string): { stopping: boolean } | null {
    const task = getTask(this.db, id);
    if (task.delivery_stage !== "reviewing") return null;
    if (task.review_task !== null && this.options.inFlight(task.review_task))
      try {
        this.options.stopTask(`t${task.review_task}`, by);
      } catch (error) {
        noteTask(this.db, id, "review_error", {
          reason: redact(
            error instanceof Error ? error.message : String(error),
          ),
        });
      }
    this.block(task, "用户停止审阅", undefined, by);
    return { stopping: false };
  }
}
