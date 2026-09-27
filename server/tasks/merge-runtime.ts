import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { redact } from "../secret-redact.ts";
import { taskDir } from "./active.ts";
import { defaultBranch, firstLine, type Exec } from "./git.ts";
import { originRepo, parsePrUrl, repoFlag } from "./gh-repo.ts";
import { atomically, getTask, noteTask, type Task } from "./ledger.ts";
import { runLocalCheck } from "./local-check.ts";
import { mergeFailure } from "./merge-decision.ts";
import { isRebaseConflict, markDeliveryFinal } from "./delivery-records.ts";
import { MergeClaim } from "./merge-claim.ts";
import { addTell } from "./tell-ledger.ts";

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
    if (this.closed || this.draining || Date.now() < this.retryAfter) return;
    const row = this.db
      .prepare(
        "SELECT id FROM tasks WHERE delivery_stage IN ('merge_queued','merging') AND status='done' ORDER BY merge_queued_at,id LIMIT 1",
      )
      .get() as { id: number } | undefined;
    if (!row || !this.claim.acquire(row.id)) return;
    this.active = this.drain().catch((error) =>
      console.error("合入队列失败：", redact(String(error))),
    );
  }

  private async drain() {
    this.draining = true;
    try {
      while (!this.closed) {
        const row = this.db
          .prepare(
            "SELECT id FROM tasks WHERE delivery_stage IN ('merge_queued','merging') AND status='done' ORDER BY merge_queued_at,id LIMIT 1",
          )
          .get() as { id: number } | undefined;
        if (!row) return;
        this.stage(row.id, "merging", "merge_started");
        try {
          await this.process(getTask(this.db, row.id));
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

  private async process(task: Task) {
    const { repo, worktree, branch, pr_url: url } = task;
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
    if (this.stopped(task.id)) return;
    if (before.isCrossRepository)
      throw new MergeHold("PR 来源不是仓库 origin 的分支，拒绝合入");
    if (
      before.state !== "OPEN" ||
      before.headRefName !== branch ||
      before.baseRefName !== base
    )
      throw new MergeHold("PR 状态、源分支或目标分支与任务不符");
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
    if (this.stopped(task.id)) return;
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
      if (this.stopped(task.id)) return;
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
    if (this.stopped(task.id)) return;
    const checkedHead = await this.command("git", [
      "-C",
      worktree,
      "rev-parse",
      "HEAD",
    ]);
    noteTask(this.db, task.id, "merge_rebased", { head: checkedHead });
    this.options.publish(task.id, "merge_rebased", { head: checkedHead });
    this.options.publish(task.id, "local_check_started", {});
    const checked = await runLocalCheck({
      worktree,
      taskDir: taskDir(this.options.data, task.id),
      env: this.options.env,
      signal: this.abort.signal,
      onStatus: (status, log) => {
        if (!this.closed)
          noteTask(this.db, task.id, `merge_check_${status}`, { log });
      },
    });
    if (this.closed) return;
    if (this.stopped(task.id)) return;
    noteTask(this.db, task.id, "merge_check", checked);
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
    if (this.stopped(task.id)) return;
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
      if (this.stopped(task.id) || this.closed) return;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(1000, deadline - Date.now())),
      );
      current = await this.pr(task, flag);
    }
    if (this.stopped(task.id) || this.closed) return;
    if (current.state !== "OPEN" || current.headRefOid !== checkedHead)
      throw new MergeHold(
        `等待 PR 头提交更新超时或状态变化：检查过 ${checkedHead}，PR 头 ${current.headRefOid}（${current.state}），拒绝合入`,
      );
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
      if (this.stopped(task.id)) return;
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
          by: "u1",
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
