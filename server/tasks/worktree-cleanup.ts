import type { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { samePath } from "../platform/plan.ts";
import { redact } from "../secret-redact.ts";
import { exec, type Exec } from "./git.ts";
import { all, one } from "./ledger-model.ts";
import { noteTask } from "./ledger.ts";

type Finished = {
  id: number;
  repo: string;
  worktree: string;
  branch: string | null;
  status: string;
  delivery_stage: string | null;
};

const BACKOFF_MIN_MS = 60_000;
const BACKOFF_MAX_MS = 24 * 60 * 60_000;

/** 清理失败退避：一次 1 分钟起，逐次翻倍，封顶一天。 */
export function cleanupBackoffMs(attempts: number): number {
  const step = Math.min(Math.max(attempts, 1) - 1, 16);
  return Math.min(BACKOFF_MIN_MS * 2 ** step, BACKOFF_MAX_MS);
}

/** 有界分页；INDEXED BY 部分索引，避免优化器走 tasks_status 扫全部已完成。 */
export const CLEANUP_PAGE_SQL = `SELECT id FROM (
  SELECT id FROM tasks INDEXED BY tasks_cleanup_cancelled
   WHERE id>? AND repo IS NOT NULL AND worktree IS NOT NULL AND status='cancelled'
  UNION ALL
  SELECT id FROM tasks INDEXED BY tasks_cleanup_done
   WHERE id>? AND repo IS NOT NULL AND worktree IS NOT NULL
     AND status='done' AND delivery_stage IN ('merged','online')
) ORDER BY id LIMIT 100`;

/** 只清账本中已合入或已取消的 Git 工作树；失败与待合入任务可继续使用原树。 */
export class WorktreeCleanup {
  private readonly cleaning = new Map<number, Promise<void>>();
  private readonly retryAt = new Map<number, number>();
  private readonly attempts = new Map<number, number>();
  constructor(
    private readonly db: DatabaseSync,
    private readonly run: Exec = exec,
    private readonly active: (id: number) => boolean = () => false,
    private readonly now: () => number = Date.now,
  ) {}

  private candidate(id: number) {
    return one<Finished>(
      this.db,
      `SELECT id,repo,worktree,branch,status,delivery_stage FROM tasks
       WHERE id=? AND repo IS NOT NULL AND worktree IS NOT NULL
         AND (status='cancelled' OR (status='done' AND delivery_stage IN ('merged','online')))`,
      id,
    );
  }

  async cleanup(id: number): Promise<boolean> {
    const pending = this.cleaning.get(id);
    if (pending) {
      await pending;
      return false;
    }
    const task = this.candidate(id);
    if (!task || this.active(id)) return false;
    let finished!: () => void;
    this.cleaning.set(
      id,
      new Promise<void>((resolve) => {
        finished = resolve;
      }),
    );
    try {
      const listed = await this.run("git", [
        "-C",
        task.repo,
        "worktree",
        "list",
        "--porcelain",
      ]);
      if (!listed.ok) throw new Error(redact(listed.stderr));
      const path = existsSync(task.worktree)
        ? await realpath(task.worktree)
        : task.worktree;
      const registered = listed.stdout
        .split("\n")
        .some(
          (line) =>
            line.startsWith("worktree ") &&
            samePath(process.platform, line.slice("worktree ".length), path),
        );
      if (!registered && existsSync(task.worktree))
        throw new Error(`t${id} 工作树路径存在但未登记在 Git，保留待核对`);
      if (registered) {
        const branch = await this.run("git", [
          "-C",
          task.worktree,
          "symbolic-ref",
          "--quiet",
          "--short",
          "HEAD",
        ]);
        if (!branch.ok || branch.stdout.trim() !== task.branch)
          throw new Error(`t${id} 工作树分支与账本不一致，保留待核对`);
        const removed = await this.run(
          "git",
          [
            "-C",
            task.repo,
            "worktree",
            "remove",
            ...(task.status === "cancelled" ? ["--force"] : []),
            task.worktree,
          ],
          { timeoutMs: 120_000 },
        );
        if (!removed.ok) throw new Error(redact(removed.stderr));
      }
      if (task.status === "done" && task.branch) {
        const found = await this.run("git", [
          "-C",
          task.repo,
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/${task.branch}`,
        ]);
        if (found.ok) {
          const deleted = await this.run("git", [
            "-C",
            task.repo,
            "branch",
            "-D",
            task.branch,
          ]);
          if (!deleted.ok) throw new Error(redact(deleted.stderr));
        }
      }
      this.db
        .prepare(
          "UPDATE tasks SET worktree=NULL,updated_at=? WHERE id=? AND worktree=?",
        )
        .run(Date.now(), id, task.worktree);
      noteTask(this.db, id, "worktree_cleaned", { path: task.worktree });
      return true;
    } finally {
      this.cleaning.delete(id);
      finished();
    }
  }

  /** 有界分页；同一轮里失败的任务只尝试一次，随后按连败退避。 */
  async finished(): Promise<number> {
    let after = 0;
    let count = 0;
    const now = this.now();
    for (;;) {
      const rows = all<{ id: number }>(this.db, CLEANUP_PAGE_SQL, after, after);
      if (!rows.length) return count;
      for (const row of rows) {
        if ((this.retryAt.get(row.id) ?? 0) > now) continue;
        try {
          if (await this.cleanup(row.id)) count++;
          this.retryAt.delete(row.id);
          this.attempts.delete(row.id);
        } catch (error) {
          const n = (this.attempts.get(row.id) ?? 0) + 1;
          this.attempts.set(row.id, n);
          this.retryAt.set(row.id, now + cleanupBackoffMs(n));
          console.error(`t${row.id} 工作树清理失败：${redact(String(error))}`);
        }
      }
      after = rows.at(-1)!.id;
    }
  }
}
