import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../../problem.ts";
import { redact } from "../../secret-redact.ts";
import { taskDir } from "../dispatch/active.ts";
import { defaultBranch, firstLine, type Exec } from "../git.ts";
import { MergeGit, type PrView } from "./merge-git.ts";
import { originRepo, parsePrUrl, repoFlag } from "../gh-repo.ts";
import { atomically, getTask, noteTask, type Task } from "../ledger/ledger.ts";
import { checkDetail, runLocalCheck, type LocalCheck } from "./local-check.ts";
import {
  MAX_CHECK_RERUNS,
  notRunText,
  rerunDecision,
  rerunDelayMs,
  withOutcome,
} from "./check-outcome.ts";
import { timingSensitive } from "./check-rerun.ts";
import { DUE, overdueDetail } from "../watch/overdue.ts";
import { mergeFailure } from "./merge-decision.ts";
import {
  isRebaseConflict,
  markDeliveryFinal,
} from "../gates/delivery-records.ts";
import { MergeClaim } from "./merge-claim.ts";
import { lastRebased } from "./merge-ledger.ts";
import { addTell } from "../dispatch/tell-ledger.ts";
import { worktreePlan } from "../dispatch/prepare.ts";
import { rankSql } from "../ledger/priority.ts";

type Stage = NonNullable<Task["delivery_stage"]>;
class MergeHold extends Error {}

/** 下一个合入：与派活队列同一个优先级（priority.ts），同一档正在合入的（重启前没做完的）先做完，其余按入队先后。
 * 按 delivery_stage 各查一次，走 tasks_merge_prio / tasks_delivery_stage，不扫全部已完成。串行，不抢占。 */
export const NEXT_MERGE = `SELECT id FROM (
  SELECT id,prio,merge_queued_at,0 AS seq FROM tasks WHERE delivery_stage='merging' AND status='done'
  UNION ALL
  SELECT id,prio,merge_queued_at,1 AS seq FROM tasks WHERE delivery_stage='merge_queued' AND status='done'
) ORDER BY ${rankSql("prio")},seq,merge_queued_at,id LIMIT 50`;

/** 正在处理的合入。committed 表示已发出 gh 合入，用户停止不再中止它。 */
type Current = { id: number; committed: boolean; abort: AbortController };

/** PR 合入队列。状态先落库，单服务内只运行一个队首；重启后从账本续上。 */
export class MergeQueue {
  private draining = false;
  private closed = false;
  private retryAfter = 0;
  private readonly returning = new Set<number>();
  private readonly stopping = new Map<number, string | undefined>();
  private readonly claim: MergeClaim;
  private readonly abort = new AbortController();
  private active?: Promise<void>;
  private current: Current | null = null;
  private readonly git: MergeGit;

  isReturning(id: number) {
    return this.returning.has(id);
  }

  constructor(
    private readonly db: DatabaseSync,
    private readonly options: {
      data: string;
      env: NodeJS.ProcessEnv;
      run: Exec;
      returned: (task: Task) => Promise<void>;
      publish: (
        id: number,
        kind: string,
        detail: Record<string, unknown>,
        actor?: string,
      ) => void;
      changed: (id: number) => void;
      /** 一键停机（server/pause.ts）：这件被暂停挡着时跳过，别的照常合入。 */
      paused?: (id: number) => boolean;
      cleaned?: (id: number) => Promise<void>;
      /** 服务自身仓库的 `-R` 写法；合入它的 PR 才等发版自动上线。 */
      selfRepo?: string | null;
      /** 合入后通知上线观察者。 */
      onMerged?: (id: number) => void;
      /** GitHub PR 头视图追上推送的最长等待时间；测试可缩短。 */
      prHeadWaitMs?: number;
      /** 检查没跑成后第 attempt 次重跑前整条队列等多久（t204）；测试可缩短。 */
      rerunDelayMs?: (attempt: number) => number;
      /** 一次检查最多跑多久（ATRIUM_CHECK_TIMEOUT_MINUTES）。 */
      checkTimeoutMs?: number;
      /** 检查多久没输出就结束（overdue.ts 检查一行）；测试缩短。 */
      checkStallMs?: number;
      /** 检查进行中多久看一次日志有没有新输出（t260）；测试可缩短。 */
      quietPollMs?: number;
    },
  ) {
    this.claim = new MergeClaim(db);
    this.git = new MergeGit(options.run, () => this.closed);
  }

  async close() {
    this.closed = true;
    this.abort.abort();
    await this.active;
  }

  /** 用户停止排队或合入；已发出的 gh merge 仍以 PR 实际状态为准。 */
  stop(id: number, by?: string): { stopping: boolean } | null {
    const task = getTask(this.db, id);
    if (
      task.delivery_stage !== "merge_queued" &&
      task.delivery_stage !== "merging"
    )
      return null;
    if (task.delivery_stage === "merging") {
      this.stopping.set(id, by);
      // 还没发出 gh 合入：中止正在跑的检查等步骤，检查的进程树随之结束（t167）。
      if (this.current?.id === id && !this.current.committed)
        this.current.abort.abort();
      noteTask(this.db, id, "merge_stop_requested", { reason: "用户停止合入" });
      return { stopping: true };
    }
    this.finishStop(id, by);
    return { stopping: false };
  }

  private finishStop(id: number, by?: string) {
    this.stopping.delete(id);
    atomically(this.db, () => {
      this.db
        .prepare(
          "UPDATE tasks SET delivery_stage=NULL,merge_queued_at=NULL,status='blocked',ended_at=NULL,updated_at=? WHERE id=?",
        )
        .run(Date.now(), id);
      noteTask(this.db, id, "merge_stopped", { reason: "用户停止合入" });
    });
    this.options.changed(id);
    this.options.publish(id, "blocked", { reason: "用户停止合入" }, by);
  }

  private stopped(id: number) {
    if (!this.stopping.has(id)) return false;
    this.finishStop(id, this.stopping.get(id));
    return true;
  }

  /** 下一个做谁：按优先级排好的队首，跳过被暂停挡着的。 */
  private next(): number | null {
    const row = (this.db.prepare(NEXT_MERGE).all() as { id: number }[]).find(
      (candidate) => !this.options.paused?.(candidate.id),
    );
    return row?.id ?? null;
  }

  private stage(
    id: number,
    stage: Stage | null,
    kind: string,
    detail?: unknown,
    changed = true,
  ) {
    atomically(this.db, () => {
      this.db
        .prepare(
          "UPDATE tasks SET delivery_stage=?,merge_queued_at=CASE WHEN ?='merged' THEN NULL ELSE merge_queued_at END,updated_at=? WHERE id=?",
        )
        .run(stage, stage, Date.now(), id);
      noteTask(this.db, id, kind, detail);
    });
    if (changed) this.options.changed(id);
  }

  enqueue(id: number) {
    const task = getTask(this.db, id);
    if (task.deliver !== "pr" || !task.pr_url || !task.repo) return;
    atomically(this.db, () => {
      const now = Date.now();
      this.db
        .prepare(
          "UPDATE tasks SET delivery_stage='merge_queued',merge_queued_at=?,updated_at=? WHERE id=?",
        )
        .run(now, now, id);
      noteTask(this.db, id, "merge_queued", { pr_url: task.pr_url });
    });
    this.options.changed(id);
    this.options.publish(id, "merge_queued", { pr_url: task.pr_url });
    this.kick();
  }

  /** 仅重新排入已通过交付关卡（或秘书、leader 登记交付的，t257）、曾进入合入队列的受阻 PR。 */
  requeue(id: number): Task {
    const task = getTask(this.db, id);
    const gate = this.db
      .prepare(
        "SELECT kind,detail FROM task_events WHERE task_id=? AND kind IN ('gates','delivery_registered') ORDER BY id DESC LIMIT 1",
      )
      .get(id) as { kind: string; detail: string | null } | undefined;
    // 登记交付的没有执行者关卡；工作树没给、合入队列还没来得及另建的，重新排队时再建。
    const registered = gate?.kind === "delivery_registered";
    let passed = registered;
    try {
      passed ||=
        (JSON.parse(gate?.detail ?? "null") as { passed?: unknown })?.passed ===
        true;
    } catch {
      // 损坏的关卡事件不能授权重新排队。
    }
    const admitted = this.db
      .prepare(
        "SELECT 1 FROM task_events WHERE task_id=? AND kind='merge_queued' LIMIT 1",
      )
      .get(id);
    if (
      task.deliver !== "pr" ||
      !task.pr_url ||
      !task.repo ||
      (!task.worktree && !registered) ||
      !task.branch
    )
      throw new Problem(
        409,
        `${task.ref} 没有可合入的 PR、仓库或工作树（不是执行者交付的，用 atrium task deliver ${task.ref} --pr 链接 登记）`,
        "conflict",
      );
    if (
      task.status !== "blocked" ||
      task.delivery_stage !== null ||
      !passed ||
      !admitted
    )
      throw new Problem(
        409,
        `${task.ref} 未通过交付关卡，或不在可重新排队的受阻状态`,
        "conflict",
      );
    const now = Date.now();
    atomically(this.db, () => {
      this.db
        .prepare(
          "UPDATE tasks SET status='done',delivery_stage='merge_queued',merge_queued_at=?,ended_at=?,updated_at=? WHERE id=?",
        )
        .run(now, now, now, id);
      noteTask(this.db, id, "merge_queued", { pr_url: task.pr_url });
    });
    this.options.changed(id);
    this.options.publish(id, "merge_queued", { pr_url: task.pr_url });
    this.kick();
    return getTask(this.db, id);
  }

  kick() {
    if (this.closed) return;
    this.start();
  }

  private start() {
    if (this.draining || Date.now() < this.retryAfter) return;
    const next = this.next();
    if (next === null || !this.claim.acquire(next)) return;
    this.active = this.drain().catch((error) =>
      console.error("合入队列失败：", redact(String(error))),
    );
  }

  private async drain() {
    this.draining = true;
    try {
      while (!this.closed) {
        const next = this.next();
        if (next === null) return;
        const row = { id: next };
        this.current = {
          id: row.id,
          committed: false,
          abort: new AbortController(),
        };
        this.stage(row.id, "merging", "merge_started");
        try {
          await this.process(getTask(this.db, row.id));
          // 检查没跑成、放回重跑的：整条队列先等一会儿。
          if (Date.now() < this.retryAfter) return;
        } catch (error) {
          if (this.closed) return;
          if (this.stopped(row.id)) continue;
          // 基础设施错误不能被误当作检查失败；停在队列并留事件，下轮重试。
          const reason = redact(
            error instanceof Error ? error.message : String(error),
          );
          if (error instanceof MergeHold) {
            atomically(this.db, () => {
              this.db
                .prepare(
                  "UPDATE tasks SET delivery_stage=NULL,merge_queued_at=NULL,status='blocked',ended_at=NULL,updated_at=? WHERE id=?",
                )
                .run(Date.now(), row.id);
              noteTask(this.db, row.id, "merge_blocked", { reason });
            });
            this.options.changed(row.id);
            this.options.publish(row.id, "blocked", { reason });
            continue;
          }
          noteTask(this.db, row.id, "merge_error", { reason });
          this.stage(row.id, "merge_queued", "merge_retry", { reason });
          this.options.publish(row.id, "merge_retry", { reason });
          this.retryAfter = Date.now() + 60_000;
          return;
        }
      }
    } finally {
      this.current = null;
      this.draining = false;
      this.claim.release();
    }
  }

  /**
   * 在远程主机上做的任务（#358）：那边的工作树不在本机。合入在本机按任务的工作树规则另建一个，
   * 对齐到 PR 头提交后照常 rebase、检查、推送；清理时一起删（worktree-cleanup.ts）。
   */
  private async localWorktree(
    task: Task,
    repo: string,
    branch: string,
    head: string,
  ) {
    const plan = worktreePlan(
      repo,
      task.id,
      task.title,
      task.role ?? undefined,
    );
    await this.git.command("git", [
      "-C",
      repo,
      "fetch",
      "origin",
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ]);
    if (!existsSync(plan.path)) {
      await this.git.command("git", [
        "-C",
        repo,
        "worktree",
        "add",
        "--no-track",
        "-B",
        branch,
        plan.path,
        head,
      ]);
      return plan.path;
    }
    const current = await this.options.run("git", [
      "-C",
      plan.path,
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]);
    if (!current.ok || current.stdout.trim() !== branch)
      throw new MergeHold(
        `本机合入用的工作树 ${plan.path} 不在分支 ${branch} 上，等待人工核对`,
      );
    return plan.path;
  }

  /**
   * 合入队首：核对 PR 与工作树、fetch 最新 main，rebase 重跑检查，再推送、按检查过的提交合入。
   */
  private async process(task: Task): Promise<void> {
    const { repo, branch, pr_url: url } = task;
    if (!repo || !branch || !url)
      throw new Error("合入任务缺少仓库、分支或 PR");
    const origin = await originRepo(repo, this.options.run);
    if ("error" in origin) throw new Error(redact(origin.error));
    const target = parsePrUrl(url);
    const flag = repoFlag(origin.repo);
    if (!target || repoFlag(target) !== flag)
      throw new MergeHold("PR 与仓库 origin 不一致，拒绝合入");
    const base = await defaultBranch(repo, this.options.run);
    const before = await this.git.pr(task, flag);
    if (before.state === "MERGED") return this.merged(task, flag, before);
    if (this.stopped(task.id)) return;
    if (before.isCrossRepository)
      throw new MergeHold("PR 来源不是仓库 origin 的分支，拒绝合入");
    if (
      before.state !== "OPEN" ||
      before.headRefName !== branch ||
      before.baseRefName !== base
    )
      throw new MergeHold("PR 状态、源分支或目标分支与任务不符");
    // 本机没有现成的工作树：远程主机上做的（#358），或秘书、leader 登记交付时没给的（t257），都在本机另建一个。
    const remote = task.host_id != null && task.host_id !== 1;
    const copy = remote || !task.worktree;
    const worktree =
      !remote && task.worktree
        ? task.worktree
        : await this.localWorktree(task, repo, branch, before.headRefOid);
    if (copy && !remote) {
      // 登记交付另建的记进账本：之后照本机任务核对、重新排队，合入后照常清理。
      this.db
        .prepare(
          "UPDATE tasks SET worktree=?,updated_at=? WHERE id=? AND worktree IS NULL",
        )
        .run(worktree, Date.now(), task.id);
    }
    if (task.delivery_stage === "merging")
      await this.git.abortStaleRebase(worktree);
    // 另建的副本每次都对齐到 PR 头提交（上次没推成的 rebase 重做即可）。
    if (copy)
      await this.git.command("git", [
        "-C",
        worktree,
        "reset",
        "--hard",
        before.headRefOid,
      ]);
    const head = await this.git.head(worktree);
    // 与 PR 头不一致时，只认合入队列自己 rebase 出的提交。
    if (head !== before.headRefOid && lastRebased(this.db, task.id) !== head)
      throw new MergeHold("PR 头提交与任务工作树不一致，等待人工核对");
    const dirty = await this.git.status(worktree);
    if (this.stopped(task.id)) return;
    if (dirty) throw new MergeHold("任务工作树尚有未提交改动，拒绝合入");
    await this.git.command("git", ["-C", repo, "fetch", "origin", base]);
    const checkedHead = await this.rebaseAndCheck(task, worktree, repo, base);
    if (checkedHead === null) return;
    await this.pushAndMerge(task, {
      worktree,
      repo,
      branch,
      flag,
      prHead: before.headRefOid,
      checkedHead,
    });
  }

  /** 队首的取消信号：服务关闭或用户停止。 */
  private signal() {
    return this.current
      ? AbortSignal.any([this.abort.signal, this.current.abort.signal])
      : this.abort.signal;
  }

  /** rebase 到最新 main 并跑检查；过了返回检查过的提交，交回、放回重跑、被停时返回 null。 */
  private async rebaseAndCheck(
    task: Task,
    worktree: string,
    repo: string,
    base: string,
  ): Promise<string | null> {
    const rebase = await this.git.rebase(worktree, base);
    if (this.closed) return null;
    if (this.stopped(task.id)) return null;
    if (!rebase.ok) {
      await this.handBack(task, rebase.conflict);
      return null;
    }
    const checkedHead = await this.git.head(worktree);
    noteTask(this.db, task.id, "merge_rebased", { head: checkedHead });
    this.options.publish(task.id, "merge_rebased", { head: checkedHead });
    this.options.publish(task.id, "local_check_started", {});
    const request = {
      worktree,
      taskDir: taskDir(this.options.data, task.id),
      env: this.options.env,
      signal: this.signal(),
    };
    const onStatus = (status: "started", log: string) => {
      if (!this.closed)
        noteTask(this.db, task.id, `merge_check_${status}`, { log });
    };
    const reruns = this.reruns(task.id);
    const checked = await runLocalCheck({
      ...request,
      timeoutMs: this.options.checkTimeoutMs,
      stallMs: this.options.checkStallMs,
      onStatus,
      quietPollMs: this.options.quietPollMs,
    });
    if (this.closed) return null;
    if (this.stopped(task.id)) return null;
    // 到期被结束的检查（overdue.ts 检查一行）：发同一种到期事件，下面照常按已查出的失败分类。
    if (checked.stalled)
      this.options.publish(
        task.id,
        "overdue",
        overdueDetail({
          kind: "check",
          step: "wake",
          who: null,
          heldMs: this.options.checkStallMs ?? DUE.check.ms,
          next: checked.stalled.at ? `卡在 ${checked.stalled.at}` : undefined,
        }),
      );
    const judged = withOutcome(
      checked,
      await timingSensitive(repo, base, this.options.run),
      reruns.count,
    );
    noteTask(this.db, task.id, "merge_check", checkDetail(judged));
    // 没跑成（主机离线、超时且只挂时长敏感用例）不交回执行者：放回队尾等一会儿重跑，用尽才转卡住（t204）。
    if (judged.outcome === "not_run") {
      const next = rerunDecision({
        outcome: "not_run",
        reruns: reruns.count,
        stalled: !!judged.stalled,
        stalledReruns: reruns.stalled,
      });
      if (next === "final")
        throw new MergeHold(
          notRunText(judged.reason ?? judged.detail, reruns.count),
        );
      this.rerunLater(task, reruns.count + 1, judged);
      return null;
    }
    if (checked.status !== "passed") {
      await this.handBack(
        task,
        `本地检查${checked.status}：${checked.failedTests.join("、") || checked.detail}；日志 ${checked.log}`,
      );
      return null;
    }
    // 检查脚本不能悄悄修改提交或工作树。
    if (
      (await this.git.head(worktree)) !== checkedHead ||
      (await this.git.status(worktree)) !== ""
    )
      throw new MergeHold("本地检查修改了工作树，拒绝合入");
    return checkedHead;
  }

  /** 把检查过的提交推到 PR 分支、等 PR 头追上、按这个提交 squash 合入。 */
  private async pushAndMerge(
    task: Task,
    at: {
      worktree: string;
      repo: string;
      branch: string;
      flag: string;
      /** 这一轮开始时的 PR 头：推送时的 lease。 */
      prHead: string;
      checkedHead: string;
    },
  ): Promise<void> {
    const { worktree, repo, branch, flag, checkedHead } = at;
    const url = task.pr_url!;
    if (this.stopped(task.id)) return;
    const remoteHead = async () =>
      (
        await this.git.command("git", [
          "-C",
          repo,
          "ls-remote",
          "--heads",
          "origin",
          branch,
        ])
      ).split(/\s+/)[0];
    const remoteBeforePush = await remoteHead();
    if (remoteBeforePush !== checkedHead) {
      if (remoteBeforePush !== at.prHead)
        throw new MergeHold("检查后远端分支头提交发生变化，拒绝合入");
      const pushed = await this.options.run(
        "git",
        [
          "-C",
          worktree,
          "push",
          `--force-with-lease=refs/heads/${branch}:${at.prHead}`,
          "origin",
          `HEAD:refs/heads/${branch}`,
        ],
        { timeoutMs: 120_000 },
      );
      if (!pushed.ok)
        return this.handBack(
          task,
          `检查后推送失败：${firstLine(pushed.stderr) || "未知原因"}`,
        );
    }
    if (this.closed) return;
    // 推送成功后 gh 的 PR 视图可能仍返回旧头；在时限内等它追上本轮检查的提交。
    const deadline = Date.now() + (this.options.prHeadWaitMs ?? 60_000);
    let current = await this.git.pr(task, flag);
    while (
      current.state === "OPEN" &&
      current.headRefOid !== checkedHead &&
      Date.now() < deadline
    ) {
      if (this.stopped(task.id) || this.closed) return;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(1000, deadline - Date.now())),
      );
      current = await this.git.pr(task, flag);
    }
    if (this.stopped(task.id) || this.closed) return;
    if (current.state !== "OPEN" || current.headRefOid !== checkedHead)
      throw new MergeHold(
        `等待 PR 头提交更新超时或状态变化：检查过 ${checkedHead}，PR 头 ${current.headRefOid}（${current.state}），拒绝合入`,
      );
    // 发出 gh 合入之后用户停止也不再中止。
    if (this.current?.id === task.id) this.current.committed = true;
    const merge = await this.options.run(
      "gh",
      [
        "pr",
        "merge",
        url,
        "-R",
        flag,
        "--squash",
        "--match-head-commit",
        checkedHead,
      ],
      { timeoutMs: 120_000 },
    );
    if (!merge.ok) {
      const state = await this.git.pr(task, flag);
      if (state.state === "MERGED") return this.merged(task, flag, state);
      if (this.stopped(task.id)) return;
      const reason = redact(
        `gh 合入失败：${firstLine(merge.stderr) || "未知原因"}`,
      );
      return this.handBack(task, reason);
    }
    const after = await this.git.pr(task, flag);
    if (after.state !== "MERGED")
      throw new Error("gh 合入后 PR 尚未显示 MERGED");
    await this.merged(task, flag, after);
  }

  private async merged(task: Task, flag: string, view: PrView) {
    if (this.closed) return;
    const commit =
      typeof view.mergeCommit?.oid === "string" &&
      /^[0-9a-f]{7,64}$/i.test(view.mergeCommit.oid)
        ? view.mergeCommit.oid
        : null;
    const online = !!this.options.selfRepo && this.options.selfRepo === flag;
    this.db
      .prepare("UPDATE tasks SET merge_commit=?,online_wait=? WHERE id=?")
      .run(commit, online ? 1 : 0, task.id);
    this.stage(
      task.id,
      "merged",
      "merged",
      {
        pr_url: task.pr_url,
        ...(commit ? { commit } : {}),
        ...(online ? { online: "等发版后自动上线" } : {}),
      },
      false,
    );
    markDeliveryFinal(this.db, task.id, "merged");
    try {
      await this.options.cleaned?.(task.id);
    } catch (error) {
      console.error(`t${task.id} 工作树清理失败：${redact(String(error))}`);
    }
    this.options.changed(task.id);
    this.options.publish(task.id, "merged", { pr_url: task.pr_url });
    if (online) this.options.onMerged?.(task.id);
  }

  /** 这次排队以来检查没跑成、放回重跑了几次（其中几次是卡住）。 */
  private reruns(id: number) {
    const rows = this.db
      .prepare(
        "SELECT detail FROM task_events WHERE task_id=? AND kind='merge_check_rerun' AND id>(SELECT COALESCE(MAX(id),0) FROM task_events WHERE task_id=? AND kind='merge_queued') ORDER BY id DESC LIMIT ?",
      )
      .all(id, id, MAX_CHECK_RERUNS + 1) as { detail: string | null }[];
    let stalled = 0;
    for (const row of rows) {
      try {
        const detail = JSON.parse(row.detail ?? "null") as {
          stalled?: unknown;
        } | null;
        if (detail?.stalled) stalled++;
      } catch {
        /* 损坏记录不算卡住。 */
      }
    }
    return { count: rows.length, stalled };
  }

  /** 检查没跑成：放回队尾，整条队列等一会儿（负载降下来、离线主机连回来）再接着合入。 */
  private rerunLater(task: Task, attempt: number, check: LocalCheck) {
    const now = Date.now();
    atomically(this.db, () => {
      this.db
        .prepare(
          "UPDATE tasks SET delivery_stage='merge_queued',merge_queued_at=?,updated_at=? WHERE id=?",
        )
        .run(now, now, task.id);
      noteTask(this.db, task.id, "merge_check_rerun", {
        attempt,
        max: MAX_CHECK_RERUNS,
        reason: check.reason ?? check.detail,
        ...checkDetail(check),
      });
    });
    this.options.changed(task.id);
    this.retryAfter =
      now + (this.options.rerunDelayMs ?? rerunDelayMs)(attempt);
  }

  /** 交回原执行者在原分支续做；超过次数转卡住。审阅打回也走这里。 */
  async handBack(task: Task, reason: string) {
    if (this.closed) return;
    const safeReason = redact(reason);
    const decision = mergeFailure(task.merge_returns, safeReason);
    if (!decision.blocked) this.returning.add(task.id);
    atomically(this.db, () => {
      this.db
        .prepare(
          "UPDATE tasks SET delivery_stage=NULL,merge_queued_at=NULL,merge_returns=?,status='blocked',ended_at=NULL,updated_at=? WHERE id=?",
        )
        .run(decision.returns, Date.now(), task.id);
      noteTask(
        this.db,
        task.id,
        decision.blocked ? "merge_blocked" : "merge_returned",
        decision,
      );
      markDeliveryFinal(
        this.db,
        task.id,
        isRebaseConflict(safeReason) ? "rebase_conflict" : "returned",
      );
      if (!decision.blocked)
        addTell(this.db, task.id, {
          text: `合入队列交回（第 ${decision.returns} 次）：${safeReason}\n请在原工作树和原分支修复、重新跑检查、推送原 PR。若分支已变基，请使用 --force-with-lease 推送。`,
          by: "runtime",
          uuid: randomUUID(),
          route: "next_run",
        });
    });
    this.options.changed(task.id);
    if (decision.blocked)
      this.options.publish(task.id, "blocked", {
        reason: safeReason,
        merge_returns: decision.returns,
      });
    else {
      this.options.publish(task.id, "merge_returned", {
        reason: safeReason,
        merge_returns: decision.returns,
      });
      try {
        await this.options.returned(getTask(this.db, task.id));
      } catch (error) {
        const why = redact(
          `交回后重派原执行者失败：${error instanceof Error ? error.message : String(error)}`,
        );
        noteTask(this.db, task.id, "merge_return_launch_failed", {
          reason: why,
        });
        this.options.publish(task.id, "blocked", { reason: why });
      } finally {
        this.returning.delete(task.id);
        this.options.changed(task.id);
      }
    }
  }
}
