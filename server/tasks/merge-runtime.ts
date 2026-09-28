import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { redact } from "../secret-redact.ts";
import { taskDir } from "./active.ts";
import { defaultBranch, firstLine, type Exec } from "./git.ts";
import { originRepo, parsePrUrl, repoFlag } from "./gh-repo.ts";
import { atomically, getTask, noteTask, type Task } from "./ledger.ts";
import { checkDetail, runLocalCheck, type LocalCheck } from "./local-check.ts";
import {
  hostIdOf,
  MAX_CHECK_RERUNS,
  notRunText,
  rerunDecision,
  rerunDelayMs,
  withOutcome,
} from "./check-outcome.ts";
import { timingSensitive } from "./check-rerun.ts";
import type { CheckDispatch } from "../hosts/check-runtime.ts";
import { mergeFailure } from "./merge-decision.ts";
import { isRebaseConflict, markDeliveryFinal } from "./delivery-records.ts";
import { MergeClaim } from "./merge-claim.ts";
import { addTell } from "./tell-ledger.ts";
import { worktreePlan } from "./prepare.ts";
import {
  mergeDecision,
  mergeHoldText,
  mergeYield,
  storedHosts,
} from "./urgent.ts";
import { urgentInMergeFlow, urgentMergeWaiting } from "./urgent-ledger.ts";

type Stage = NonNullable<Task["delivery_stage"]>;
type View = {
  state: string;
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  isCrossRepository: boolean;
  mergeCommit?: { oid?: string } | null;
};
class MergeHold extends Error {}

/** 下一个合入：紧急的在前（t113；t215 起连重启前没合完的普通任务也让它先），同一档正在合入的先做完，其余按入队先后。
 * 队列一次只跑一个，「正在合入」而此刻没在跑的只可能是重启前没做完或让路的，让紧急的插到它前面是安全的。
 * 按 delivery_stage 各查一次，走 tasks_merge_queue / tasks_delivery_stage，不扫全部已完成。 */
export const NEXT_MERGE = `SELECT id,urgent FROM (
  SELECT id,urgent,merge_queued_at,0 AS seq FROM tasks WHERE delivery_stage='merging' AND status='done'
  UNION ALL
  SELECT id,urgent,merge_queued_at,1 AS seq FROM tasks WHERE delivery_stage='merge_queued' AND status='done'
) ORDER BY urgent DESC,seq,merge_queued_at,id LIMIT 1`;

/** 正在处理的合入：让路（t215）靠它。committed 表示已发出 gh 合入，不再让。 */
type Current = {
  id: number;
  urgent: boolean;
  committed: boolean;
  yielding: boolean;
  abort: AbortController;
};

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
  /** 因紧急任务暂停合入、已记过一笔的任务（t215）；暂停解除后清空。 */
  private readonly held = new Set<number>();

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
      cleaned?: (id: number) => Promise<void>;
      /** 服务自身仓库的 `-R` 写法；合入它的 PR 才等发版自动上线。 */
      selfRepo?: string | null;
      /** 合入后通知上线观察者。 */
      onMerged?: (id: number) => void;
      /** GitHub PR 头视图追上推送的最长等待时间；测试可缩短。 */
      prHeadWaitMs?: number;
      /** 重跑检查派到哪台（#358 第 2 步）；缺省在本机跑。合入本身仍在本机。 */
      checks?: CheckDispatch;
      /** 检查没跑成后第 attempt 次重跑前整条队列等多久（t204）；测试可缩短。 */
      rerunDelayMs?: (attempt: number) => number;
    },
  ) {
    this.claim = new MergeClaim(db);
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

  /** 用户停了，或要给紧急任务让路（t215）：让路的回到排队合入（保留入队时刻），紧急的上线后接着做。 */
  private halted(id: number) {
    if (this.stopped(id)) return true;
    const current = this.current;
    if (!current || current.id !== id || !current.yielding) return false;
    current.yielding = false;
    const reason = "给紧急任务让路：回到排队合入，紧急的合入上线后接着做";
    this.stage(id, "merge_queued", "merge_yielded", { reason });
    this.options.publish(id, "merge_yielded", { reason });
    return true;
  }

  /** 正在合入的普通任务要不要给排队中的紧急任务让路（还没发出 gh 合入才让）。 */
  private yieldIfUrgent() {
    const current = this.current;
    if (
      !current ||
      current.yielding ||
      !mergeYield({
        current,
        urgentWaiting: urgentMergeWaiting(this.db),
      })
    )
      return;
    current.yielding = true;
    noteTask(this.db, current.id, "merge_yield_requested", {
      reason: "有紧急任务在等合入",
    });
    current.abort.abort();
  }

  /** 下一个做谁：紧急的照做；不是紧急的，有紧急任务还在合入流程里就先暂停（t215）。 */
  private next(): number | null {
    const row = this.db.prepare(NEXT_MERGE).get() as
      { id: number; urgent: number } | undefined;
    const decision = mergeDecision({
      next: row ? { id: row.id, urgent: row.urgent === 1 } : null,
      urgentFlow: row && row.urgent !== 1 ? urgentInMergeFlow(this.db) : [],
    });
    if (decision.kind === "hold") {
      this.noteHeld(decision.by);
      return null;
    }
    this.held.clear();
    return decision.kind === "run" ? decision.id : null;
  }

  /** 暂停中的合入各记一笔、知会一次（同一段暂停不重复）。 */
  private noteHeld(by: readonly number[]) {
    const reason = mergeHoldText(by);
    const rows = this.db
      .prepare(
        "SELECT id FROM tasks WHERE delivery_stage IN ('merge_queued','merging') AND status='done' AND urgent=0 ORDER BY merge_queued_at,id LIMIT 50",
      )
      .all() as { id: number }[];
    for (const { id } of rows) {
      if (this.held.has(id)) continue;
      this.held.add(id);
      noteTask(this.db, id, "merge_paused", {
        reason,
        by: by.map((ref) => `t${ref}`),
      });
      this.options.changed(id);
      this.options.publish(id, "merge_paused", { reason });
    }
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

  /** 仅重新排入已通过交付关卡、曾进入合入队列的受阻 PR。 */
  requeue(id: number): Task {
    const task = getTask(this.db, id);
    const gate = this.db
      .prepare(
        "SELECT detail FROM task_events WHERE task_id=? AND kind='gates' ORDER BY id DESC LIMIT 1",
      )
      .get(id) as { detail: string | null } | undefined;
    let passed = false;
    try {
      passed =
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
      !task.worktree ||
      !task.branch
    )
      throw new Problem(
        409,
        `${task.ref} 没有可合入的 PR、仓库或工作树`,
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
    if (this.draining) return this.yieldIfUrgent();
    // 出错后的一分钟退避不挡紧急的（t215）。
    if (Date.now() < this.retryAfter && !urgentMergeWaiting(this.db)) return;
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
        const task = getTask(this.db, row.id);
        this.current = {
          id: row.id,
          urgent: task.urgent === 1,
          committed: false,
          yielding: false,
          abort: new AbortController(),
        };
        this.stage(row.id, "merging", "merge_started");
        // 开始合入普通任务时紧急的已经在等：立刻让。
        this.yieldIfUrgent();
        try {
          await this.process(getTask(this.db, row.id));
          // 检查没跑成、放回重跑的：整条队列先等一会儿。
          if (Date.now() < this.retryAfter) return;
        } catch (error) {
          if (this.closed) return;
          if (this.halted(row.id)) continue;
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

  private async command(command: string, args: string[], cwd?: string) {
    if (this.closed) throw new Error("服务正在关闭");
    const result = await this.options.run(command, args, {
      ...(cwd ? { cwd } : {}),
      timeoutMs: command === "git" && args.includes("fetch") ? 120_000 : 30_000,
    });
    if (this.closed) throw new Error("服务正在关闭");
    if (!result.ok)
      throw new Error(
        redact(
          `${command} ${args.filter((arg) => !arg.startsWith("--force-with-lease")).join(" ")}：${firstLine(result.stderr) || "执行失败"}`,
        ),
      );
    return result.stdout.trim();
  }

  private async pr(task: Task, repo: string): Promise<View> {
    const output = await this.command("gh", [
      "pr",
      "view",
      task.pr_url!,
      "-R",
      repo,
      "--json",
      "state,headRefOid,headRefName,baseRefName,isCrossRepository,mergeCommit",
    ]);
    const value: unknown = JSON.parse(output);
    if (!value || typeof value !== "object")
      throw new Error("gh pr view 没有返回 PR");
    const data = value as Partial<View>;
    if (
      ![data.state, data.headRefOid, data.headRefName, data.baseRefName].every(
        (item) => typeof item === "string" && !!item,
      ) ||
      typeof data.isCrossRepository !== "boolean"
    )
      throw new Error("gh pr view 缺少合入所需字段");
    return data as View;
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
    await this.command("git", [
      "-C",
      repo,
      "fetch",
      "origin",
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ]);
    if (!existsSync(plan.path)) {
      await this.command("git", [
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

  private async process(task: Task) {
    const { repo, branch, pr_url: url } = task;
    let worktree = task.worktree;
    if (!repo || !worktree || !branch || !url)
      throw new Error("合入任务缺少仓库、工作树、分支或 PR");
    const origin = await originRepo(repo, this.options.run);
    if ("error" in origin) throw new Error(redact(origin.error));
    const target = parsePrUrl(url);
    const flag = repoFlag(origin.repo);
    if (!target || repoFlag(target) !== flag)
      throw new MergeHold("PR 与仓库 origin 不一致，拒绝合入");
    const base = await defaultBranch(repo, this.options.run);
    const before = await this.pr(task, flag);
    if (before.state === "MERGED") return this.merged(task, flag, before);
    if (this.halted(task.id)) return;
    if (before.isCrossRepository)
      throw new MergeHold("PR 来源不是仓库 origin 的分支，拒绝合入");
    if (
      before.state !== "OPEN" ||
      before.headRefName !== branch ||
      before.baseRefName !== base
    )
      throw new MergeHold("PR 状态、源分支或目标分支与任务不符");
    const remote = task.host_id != null && task.host_id !== 1;
    if (remote)
      worktree = await this.localWorktree(
        task,
        repo,
        branch,
        before.headRefOid,
      );
    if (task.delivery_stage === "merging") {
      for (const kind of ["rebase-merge", "rebase-apply"]) {
        const path = await this.command("git", [
          "-C",
          worktree,
          "rev-parse",
          "--git-path",
          kind,
        ]);
        if (existsSync(path)) {
          await this.command("git", ["-C", worktree, "rebase", "--abort"]);
          break;
        }
      }
    }
    // 远程任务：本机这份只是合入用的副本，每次都对齐到 PR 头提交（上次没推成的 rebase 重做即可）。
    if (remote)
      await this.command("git", [
        "-C",
        worktree,
        "reset",
        "--hard",
        before.headRefOid,
      ]);
    const head = await this.command("git", [
      "-C",
      worktree,
      "rev-parse",
      "HEAD",
    ]);
    if (head !== before.headRefOid) {
      const last = this.db
        .prepare(
          "SELECT detail FROM task_events WHERE task_id=? AND kind='merge_rebased' AND id>(SELECT COALESCE(MAX(id),0) FROM task_events WHERE task_id=? AND kind='merge_queued') ORDER BY id DESC LIMIT 1",
        )
        .get(task.id, task.id) as { detail: string | null } | undefined;
      let rebased = "";
      try {
        rebased =
          (JSON.parse(last?.detail ?? "null") as { head?: string })?.head ?? "";
      } catch {
        /* 损坏记录不可信。 */
      }
      if (rebased !== head)
        throw new MergeHold("PR 头提交与任务工作树不一致，等待人工核对");
    }
    const dirty = await this.command("git", [
      "--no-optional-locks",
      "-C",
      worktree,
      "status",
      "--porcelain",
    ]);
    if (this.halted(task.id)) return;
    if (dirty) throw new MergeHold("任务工作树尚有未提交改动，拒绝合入");
    await this.command("git", ["-C", repo, "fetch", "origin", base]);
    const rebase = await this.options.run(
      "git",
      ["-C", worktree, "rebase", `origin/${base}`],
      { timeoutMs: 120_000 },
    );
    if (this.closed) return;
    if (!rebase.ok) {
      const files = await this.options.run("git", [
        "-C",
        worktree,
        "diff",
        "--name-only",
        "--diff-filter=U",
      ]);
      await this.options.run("git", ["-C", worktree, "rebase", "--abort"]);
      if (this.halted(task.id)) return;
      const conflict = files.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .slice(0, 30);
      return this.handBack(
        task,
        redact(
          `rebase 冲突：${conflict.join("、") || firstLine(rebase.stderr)}`,
        ),
      );
    }
    if (this.halted(task.id)) return;
    const checkedHead = await this.command("git", [
      "-C",
      worktree,
      "rev-parse",
      "HEAD",
    ]);
    noteTask(this.db, task.id, "merge_rebased", { head: checkedHead });
    this.options.publish(task.id, "merge_rebased", { head: checkedHead });
    this.options.publish(task.id, "local_check_started", {});
    const request = {
      worktree,
      taskDir: taskDir(this.options.data, task.id),
      env: this.options.env,
      signal: this.current
        ? AbortSignal.any([this.abort.signal, this.current.abort.signal])
        : this.abort.signal,
      urgent: task.urgent === 1,
      // 远程做的任务在本机另建的工作树没装过依赖；本机的锁文件没变就沿用（t251）。
      install: true,
    };
    const onStatus = (
      status: "queued" | "started",
      log: string,
      host?: string,
    ) => {
      if (!this.closed)
        noteTask(this.db, task.id, `merge_check_${status}`, {
          ...(host ? { host } : {}),
          log,
        });
    };
    const reruns = this.reruns(task.id);
    const checked = this.options.checks
      ? await this.options.checks.run({
          ...request,
          task: task.id,
          avoid: [...storedHosts(task.avoid_hosts), ...reruns.avoid],
          base,
          onStatus,
          onMoved: (from, reason) => {
            if (!this.closed)
              noteTask(this.db, task.id, "merge_check_moved", { from, reason });
          },
        })
      : await runLocalCheck({ ...request, onStatus });
    if (this.closed) return;
    if (this.halted(task.id)) return;
    const judged = withOutcome(
      checked,
      await timingSensitive(repo, base, this.options.run),
      reruns.count,
    );
    noteTask(this.db, task.id, "merge_check", checkDetail(judged));
    // 派到别的主机时检查的是 rebase 后的这个提交；对不上就不算数。
    if (checked.commit && checked.commit !== checkedHead)
      throw new MergeHold("检查回来的提交与 rebase 后的提交不一致，拒绝合入");
    // 没跑成（主机离线、超时且只挂时长敏感用例）不交回执行者：放回队尾等一会儿重跑，用尽才转卡住（t204）。
    if (judged.outcome === "not_run") {
      const next = rerunDecision({
        outcome: "not_run",
        reruns: reruns.count,
      });
      if (next === "final")
        throw new MergeHold(
          notRunText(judged.reason ?? judged.detail, reruns.count),
        );
      return this.rerunLater(task, reruns.count + 1, judged);
    }
    if (checked.status !== "passed")
      return this.handBack(
        task,
        `本地检查${checked.status}：${checked.failedTests.join("、") || checked.detail}；日志 ${checked.log}`,
      );
    const afterCheckHead = await this.command("git", [
      "-C",
      worktree,
      "rev-parse",
      "HEAD",
    ]);
    // 检查脚本不能悄悄修改提交或工作树。
    if (
      afterCheckHead !== checkedHead ||
      (await this.command("git", [
        "--no-optional-locks",
        "-C",
        worktree,
        "status",
        "--porcelain",
      ])) !== ""
    )
      throw new MergeHold("本地检查修改了工作树，拒绝合入");
    if (this.halted(task.id)) return;
    const remoteHead = async () =>
      (
        await this.command("git", [
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
      if (remoteBeforePush !== before.headRefOid)
        throw new MergeHold("检查后远端分支头提交发生变化，拒绝合入");
      const pushed = await this.options.run(
        "git",
        [
          "-C",
          worktree,
          "push",
          `--force-with-lease=refs/heads/${branch}:${before.headRefOid}`,
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
    let current = await this.pr(task, flag);
    while (
      current.state === "OPEN" &&
      current.headRefOid !== checkedHead &&
      Date.now() < deadline
    ) {
      if (this.halted(task.id) || this.closed) return;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(1000, deadline - Date.now())),
      );
      current = await this.pr(task, flag);
    }
    if (this.halted(task.id) || this.closed) return;
    if (current.state !== "OPEN" || current.headRefOid !== checkedHead)
      throw new MergeHold(
        `等待 PR 头提交更新超时或状态变化：检查过 ${checkedHead}，PR 头 ${current.headRefOid}（${current.state}），拒绝合入`,
      );
    // 发出 gh 合入之后不再让路（t215）。
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
      const state = await this.pr(task, flag);
      if (state.state === "MERGED") return this.merged(task, flag, state);
      if (this.halted(task.id)) return;
      return this.handBack(
        task,
        redact(`gh 合入失败：${firstLine(merge.stderr) || "未知原因"}`),
      );
    }
    const after = await this.pr(task, flag);
    if (after.state !== "MERGED")
      throw new Error("gh 合入后 PR 尚未显示 MERGED");
    await this.merged(task, flag, after);
  }

  private async merged(task: Task, flag: string, view: View) {
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

  /** 这次排队以来检查没跑成、放回重跑了几次，以及没跑成的那几台（重跑先换别的）。 */
  private reruns(id: number) {
    const rows = this.db
      .prepare(
        "SELECT detail FROM task_events WHERE task_id=? AND kind='merge_check_rerun' AND id>(SELECT COALESCE(MAX(id),0) FROM task_events WHERE task_id=? AND kind='merge_queued') ORDER BY id DESC LIMIT ?",
      )
      .all(id, id, MAX_CHECK_RERUNS + 1) as { detail: string | null }[];
    const avoid = new Set<number>();
    for (const row of rows) {
      try {
        const host = hostIdOf(
          (JSON.parse(row.detail ?? "null") as { host?: string })?.host,
        );
        if (host !== null && host !== 1) avoid.add(host);
      } catch {
        /* 损坏记录只少避开一台。 */
      }
    }
    return { count: rows.length, avoid };
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
