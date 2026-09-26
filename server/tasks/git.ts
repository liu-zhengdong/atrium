import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { Problem } from "../problem.ts";
import type { WorktreePlan } from "./prepare.ts";

/**
 * 派活与验收用到的只读 git / gh 调用和建 worktree（#262）。
 * 一律 execFile（不经 shell）、有超时、有输出上限；失败返回 ok:false 与报错原文，不抛。
 */

export type Run = { ok: boolean; stdout: string; stderr: string };
export type Exec = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeoutMs?: number },
) => Promise<Run>;

export const exec: Exec = (command, args, options = {}) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          GH_PROMPT_DISABLED: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
      (error, stdout, stderr) =>
        resolve({
          ok: !error,
          stdout: String(stdout),
          stderr: String(stderr || (error ? error.message : "")),
        }),
    );
  });

const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";

/** origin 的默认分支：先看 origin/HEAD，再退回 main、master。 */
export async function defaultBranch(repo: string, run: Exec = exec) {
  const head = await run(
    "git",
    ["-C", repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    { timeoutMs: 10_000 },
  );
  if (head.ok && head.stdout.trim().startsWith("origin/"))
    return head.stdout.trim().slice("origin/".length);
  for (const name of ["main", "master"]) {
    const found = await run(
      "git",
      ["-C", repo, "rev-parse", "--verify", "--quiet", `origin/${name}`],
      { timeoutMs: 10_000 },
    );
    if (found.ok) return name;
  }
  throw new Problem(
    409,
    `仓库 ${repo} 找不到 origin 的默认分支（origin/HEAD、origin/main、origin/master 都没有）`,
    "conflict",
  );
}

/**
 * 从 origin/<默认分支> 建任务 worktree；已存在同路径的 worktree（重派）就沿用。
 * 分支已存在但 worktree 不在时，把分支检出到新 worktree。
 */
export async function ensureWorktree(
  repo: string,
  plan: WorktreePlan,
  base: string,
  run: Exec = exec,
) {
  if (existsSync(plan.path)) {
    const branch = await run(
      "git",
      ["-C", plan.path, "rev-parse", "--abbrev-ref", "HEAD"],
      { timeoutMs: 10_000 },
    );
    if (branch.ok && branch.stdout.trim() === plan.branch)
      return { created: false };
    throw new Problem(
      409,
      `工作树路径 ${plan.path} 已存在但不在分支 ${plan.branch} 上；先清理再派`,
      "conflict",
    );
  }
  const fetched = await run("git", ["-C", repo, "fetch", "origin", base], {
    timeoutMs: 120_000,
  });
  if (!fetched.ok)
    throw new Problem(
      409,
      `拉取 origin/${base} 失败：${firstLine(fetched.stderr)}`,
      "conflict",
    );
  const exists = await run(
    "git",
    [
      "-C",
      repo,
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${plan.branch}`,
    ],
    { timeoutMs: 10_000 },
  );
  const args = exists.ok
    ? ["-C", repo, "worktree", "add", plan.path, plan.branch]
    : [
        "-C",
        repo,
        "worktree",
        "add",
        "--no-track",
        "-b",
        plan.branch,
        plan.path,
        `origin/${base}`,
      ];
  const added = await run("git", args, { timeoutMs: 60_000 });
  if (!added.ok)
    throw new Problem(
      409,
      `建工作树失败：${firstLine(added.stderr)}`,
      "conflict",
    );
  return { created: true };
}

export { firstLine };
