import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { redact } from "../secret-redact.ts";
import type { CheckDispatch } from "../hosts/check-runtime.ts";
import { taskDir } from "./active.ts";
import { withOutcome } from "./check-outcome.ts";
import { timingSensitive } from "./check-rerun.ts";
import { originRepo, parsePrUrl, repoFlag } from "./gh-repo.ts";
import { defaultBranch, type Exec } from "./git.ts";
import { getTask, noteTask } from "./ledger.ts";
import { checkDetail, runLocalCheck } from "./local-check.ts";
import type { MergeGit } from "./merge-git.ts";
import {
  latestPrecheck,
  lastRebased,
  prechecked,
  type PrecheckRecord,
} from "./merge-ledger.ts";
import {
  pickPrechecks,
  reuseDecision,
  type ReuseDecision,
} from "./merge-precheck-plan.ts";
import { storedHosts } from "./urgent.ts";

/**
 * 合入队列的提前检查（t254，判定在 merge-precheck-plan.ts）：队首在合入时，排在后面的几件先在各自工作树里
 * rebase 到本机已取到的 origin/<基础分支>、跑检查，结果记成 merge_prechecked（带检查的提交 head 与基于的 main 提交 base）。
 * 只提前做检查，不推送、不合入；轮到它时由合入队列按 `reuse` 的结论决定用这次结果还是重跑。
 *
 * 与队首不碰同一个工作树：队首轮到某件时先 `settle`——还在做 git 的等它做完，检查排着队还没开始的撤掉，
 * 检查已经在跑的接着等它跑完（结果直接拿来用），队首的停止与让路会一并中止它。
 * 不 fetch（fetch 只由队首做，免得并发抢 refs 锁）；不投递事件，只记进任务事件。
 */

type Phase = "prepare" | "queued" | "checking";
type Entry = { abort: AbortController; phase: Phase; done: Promise<void> };

export class MergePrechecks {
  private readonly running = new Map<number, Entry>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly deps: {
      data: string;
      env: NodeJS.ProcessEnv;
      run: Exec;
      git: MergeGit;
      /** 服务关闭时中止全部。 */
      signal: AbortSignal;
      closed: () => boolean;
      /** 同时最多提前检查几件（merge-precheck-plan.ts precheckSlots，本机太忙时为 0）。 */
      slots: () => number;
      /** 紧急任务在合入流程里、检查没跑成正在等重跑：不开新的。 */
      paused: () => boolean;
      checks?: Pick<CheckDispatch, "run">;
      changed: (id: number) => void;
    },
  ) {}

  /** 看看要不要再开几件（入队、队首换人、提前检查做完、巡检时调）。 */
  kick() {
    if (this.deps.closed()) return;
    const slots = this.deps.slots();
    if (slots <= 0 && !this.running.size) return;
    const rows = this.db
      .prepare(
        "SELECT id,host_id FROM tasks WHERE delivery_stage='merge_queued' AND status='done' ORDER BY urgent DESC,merge_queued_at,id LIMIT ?",
      )
      .all(Math.max(slots, 1)) as { id: number; host_id: number | null }[];
    // 正在合入的队首已是 merging，不在这里；合入队列先开始队首再调这里。
    const queued = rows;
    const done = prechecked(
      this.db,
      queued.map((row) => row.id),
    );
    const picked = pickPrechecks({
      queued: queued.map((row) => ({
        id: row.id,
        local: row.host_id == null || row.host_id === 1,
        done: done.has(row.id),
        running: this.running.has(row.id),
      })),
      slots,
      running: this.running.size,
      paused: this.deps.paused(),
    });
    for (const id of picked) this.start(id);
  }

  /** 用户停止排队中的任务：中止它的提前检查。 */
  stop(id: number) {
    this.running.get(id)?.abort.abort();
  }

  /**
   * 队首轮到这件：提前检查还在做 git 的等它做完；检查排着队的撤掉（不等，排队时不碰工作树）；
   * 检查在跑的等它跑完，signal（队首的停止与让路）中止时一并中止。
   */
  async settle(id: number, signal: AbortSignal) {
    const entry = this.running.get(id);
    if (!entry) return;
    if (entry.phase === "queued") {
      entry.abort.abort();
      return;
    }
    const abort = () => entry.abort.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      await entry.done;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  async close() {
    for (const entry of this.running.values()) entry.abort.abort();
    await Promise.all([...this.running.values()].map((entry) => entry.done));
  }

  /** 正在提前检查的件数（看板与测试用）。 */
  get size() {
    return this.running.size;
  }

  private start(id: number) {
    const abort = new AbortController();
    const entry: Entry = {
      abort,
      phase: "prepare",
      done: Promise.resolve(),
    };
    this.running.set(id, entry);
    entry.done = this.precheck(id, entry)
      .catch((error) => {
        if (this.deps.closed() || abort.signal.aborted) return;
        const reason = redact(
          error instanceof Error ? error.message : String(error),
        );
        try {
          noteTask(this.db, id, "merge_precheck_skipped", { reason });
        } catch {
          // 任务被删了：没什么可记的。
        }
      })
      .finally(() => {
        this.running.delete(id);
        if (!this.deps.closed()) {
          this.deps.changed(id);
          this.kick();
        }
      });
  }

  private skip(id: number, reason: string) {
    noteTask(this.db, id, "merge_precheck_skipped", { reason });
  }

  private async precheck(id: number, entry: Entry) {
    const signal = AbortSignal.any([this.deps.signal, entry.abort.signal]);
    const { git, run } = this.deps;
    const task = getTask(this.db, id);
    const { repo, worktree, branch, pr_url: url } = task;
    if (!repo || !worktree || !branch || !url || !existsSync(worktree))
      return this.skip(id, "没有本机工作树、分支或 PR");
    // 与合入同样的核对：对不上的不提前检查，留给队首按原规则拦下。
    const origin = await originRepo(repo, run);
    if ("error" in origin) return this.skip(id, redact(origin.error));
    const target = parsePrUrl(url);
    const flag = repoFlag(origin.repo);
    if (!target || repoFlag(target) !== flag)
      return this.skip(id, "PR 与仓库 origin 不一致");
    const base = await defaultBranch(repo, run);
    const view = await git.pr(task, flag);
    if (
      view.state !== "OPEN" ||
      view.isCrossRepository ||
      view.headRefName !== branch ||
      view.baseRefName !== base
    )
      return this.skip(id, "PR 状态、源分支或目标分支与任务不符");
    if (signal.aborted) return;
    await git.abortStaleRebase(worktree);
    const head = await git.head(worktree);
    if (head !== view.headRefOid && lastRebased(this.db, id) !== head)
      return this.skip(id, "PR 头提交与任务工作树不一致");
    if (await git.status(worktree))
      return this.skip(id, "任务工作树有未提交改动");
    if (signal.aborted) return;
    const main = await git.command("git", [
      "-C",
      repo,
      "rev-parse",
      `origin/${base}`,
    ]);
    const rebase = await git.rebase(worktree, base);
    if (!rebase.ok) return this.skip(id, rebase.conflict);
    const checkedHead = await git.head(worktree);
    if (checkedHead !== head)
      noteTask(this.db, id, "merge_rebased", {
        head: checkedHead,
        precheck: true,
      });
    if (signal.aborted) return;
    entry.phase = "queued";
    const request = {
      worktree,
      taskDir: taskDir(this.deps.data, id),
      env: this.deps.env,
      signal,
      urgent: false,
    };
    const onStatus = (
      status: "queued" | "started",
      _log: string,
      host?: string,
    ) => {
      if (status !== "started" || signal.aborted) return;
      entry.phase = "checking";
      noteTask(this.db, id, "merge_precheck_started", {
        head: checkedHead,
        base: main,
        ...(host ? { host } : {}),
      });
      this.deps.changed(id);
    };
    const checked = this.deps.checks
      ? await this.deps.checks.run({
          ...request,
          task: id,
          avoid: storedHosts(task.avoid_hosts),
          base,
          onStatus,
        })
      : await runLocalCheck({ ...request, onStatus });
    // 被撤掉（队首接手、用户停止、服务关闭）：结果不算，也不再碰工作树。
    if (signal.aborted || this.deps.closed()) return;
    if (checked.commit && checked.commit !== checkedHead)
      return this.skip(id, "检查回来的提交与 rebase 后的提交不一致");
    if (
      (await git.head(worktree)) !== checkedHead ||
      (await git.status(worktree)) !== ""
    )
      return this.skip(id, "检查修改了工作树");
    const judged = withOutcome(checked, await timingSensitive(repo, base, run));
    noteTask(this.db, id, "merge_prechecked", {
      head: checkedHead,
      base: main,
      ...checkDetail(judged),
    });
  }

  /**
   * 轮到它合入、已 fetch 到最新 main 之后：提前检查的结果还能不能用（merge-precheck-plan.ts reuseDecision）。
   * 没有提前检查时不跑 git；有的话看 base 还在不在 main 上、两边各改了哪些文件。
   */
  async reuse(input: {
    id: number;
    repo: string;
    worktree: string;
    head: string;
    main: string;
  }): Promise<{
    decision: ReuseDecision;
    precheck: PrecheckRecord | null;
  }> {
    const precheck = latestPrecheck(this.db, input.id);
    const decide = (facts: {
      ancestor: boolean;
      taskFiles: string[] | null;
      mainFiles: string[] | null;
    }) =>
      reuseDecision({
        precheck,
        head: input.head,
        main: input.main,
        ...facts,
      });
    const trivial = decide({ ancestor: false, taskFiles: [], mainFiles: [] });
    // 没提前检查、提交变了、没跑成、main 没动：不必看文件。
    if (
      !precheck ||
      precheck.head !== input.head ||
      precheck.outcome === "not_run" ||
      precheck.base === input.main ||
      precheck.outcome === "failed"
    )
      return { decision: trivial, precheck };
    const { run } = this.deps;
    const ancestor = await run("git", [
      "-C",
      input.repo,
      "merge-base",
      "--is-ancestor",
      precheck.base,
      input.main,
    ]);
    const files = async (from: string, to: string) => {
      const result = await run(
        "git",
        ["-C", input.worktree, "diff", "--name-only", "--no-renames", from, to],
        { timeoutMs: 30_000 },
      );
      return result.ok
        ? result.stdout
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
        : null;
    };
    return {
      decision: decide({
        ancestor: ancestor.ok,
        taskFiles: await files(precheck.base, input.head),
        mainFiles: await files(precheck.base, input.main),
      }),
      precheck,
    };
  }
}
