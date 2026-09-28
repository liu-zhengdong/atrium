import { existsSync } from "node:fs";
import { redact } from "../../secret-redact.ts";
import { firstLine, type Exec } from "../git.ts";
import type { Task } from "../ledger/ledger.ts";

/** gh pr view 里合入要用的字段。 */
export type PrView = {
  state: string;
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  isCrossRepository: boolean;
  mergeCommit?: { oid?: string } | null;
};

/**
 * 合入队列用到的 git / gh 调用：失败抛错、错误里抹掉凭据；服务关闭中不再发命令。
 * 只管怎么调命令，合入怎么走在 merge-runtime.ts。
 */
export class MergeGit {
  constructor(
    private readonly run: Exec,
    private readonly closed: () => boolean,
  ) {}

  async command(command: string, args: string[], cwd?: string) {
    if (this.closed()) throw new Error("服务正在关闭");
    const result = await this.run(command, args, {
      ...(cwd ? { cwd } : {}),
      timeoutMs: command === "git" && args.includes("fetch") ? 120_000 : 30_000,
    });
    if (this.closed()) throw new Error("服务正在关闭");
    if (!result.ok)
      throw new Error(
        redact(
          `${command} ${args.filter((arg) => !arg.startsWith("--force-with-lease")).join(" ")}：${firstLine(result.stderr) || "执行失败"}`,
        ),
      );
    return result.stdout.trim();
  }

  async pr(task: Task, repo: string): Promise<PrView> {
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
    const data = value as Partial<PrView>;
    if (
      ![data.state, data.headRefOid, data.headRefName, data.baseRefName].every(
        (item) => typeof item === "string" && !!item,
      ) ||
      typeof data.isCrossRepository !== "boolean"
    )
      throw new Error("gh pr view 缺少合入所需字段");
    return data as PrView;
  }

  head(worktree: string) {
    return this.command("git", ["-C", worktree, "rev-parse", "HEAD"]);
  }

  /** 工作树有没有没提交的改动（porcelain 输出；干净为空串）。 */
  status(worktree: string) {
    return this.command("git", [
      "--no-optional-locks",
      "-C",
      worktree,
      "status",
      "--porcelain",
    ]);
  }

  /** 上次没做完的 rebase（服务重启、进程被杀）先撤掉，工作树回到 rebase 前。 */
  async abortStaleRebase(worktree: string) {
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
        return;
      }
    }
  }

  /** rebase 到 origin/<base>；冲突时撤掉 rebase，返回冲突文件（至多 30 个）或 git 的第一行报错。 */
  async rebase(
    worktree: string,
    base: string,
  ): Promise<{ ok: true } | { ok: false; conflict: string }> {
    const rebase = await this.run(
      "git",
      ["-C", worktree, "rebase", `origin/${base}`],
      { timeoutMs: 120_000 },
    );
    if (rebase.ok) return { ok: true };
    const files = await this.run("git", [
      "-C",
      worktree,
      "diff",
      "--name-only",
      "--diff-filter=U",
    ]);
    await this.run("git", ["-C", worktree, "rebase", "--abort"]);
    const conflict = files.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(0, 30);
    return {
      ok: false,
      conflict: redact(
        `rebase 冲突：${conflict.join("、") || firstLine(rebase.stderr)}`,
      ),
    };
  }
}
