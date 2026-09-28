import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { redact } from "../secret-redact.ts";
import { defaultBranch, firstLine, type Exec } from "./git.ts";
import { originRepo, parsePrUrl, repoFlag } from "./gh-repo.ts";
import { atomically, getTask, noteTask, type Task } from "./ledger.ts";
import { objectOf, onlyKeys, repoOf } from "./ledger-validate.ts";
import { usage } from "./ledger-model.ts";
import { worktreePlan } from "./prepare.ts";
import { dequeue } from "./queue.ts";
import {
  parseWorktrees,
  prRefusal,
  registerRefusal,
  worktreeChoice,
  type PrHead,
} from "./register-delivery.ts";

const conflict = (message: string) =>
  new Problem(409, redact(message), "conflict");

/**
 * 登记交付（t257）：运行时自己查 PR 与工作树（不采信调用方），核对过后把任务记成完成、待合入。
 * 进合入队列由调用方做（MergeQueue.enqueue）；busy 为执行者正在拉起、在跑或收尾。
 */
export async function registerDelivery(
  db: DatabaseSync,
  reference: unknown,
  body: unknown,
  options: { run: Exec; busy: (id: number) => boolean; by: string },
): Promise<Task> {
  const input = objectOf(body);
  onlyKeys(input, ["pr_url", "worktree", "repo"]);
  const url = typeof input.pr_url === "string" ? input.pr_url.trim() : "";
  const target = parsePrUrl(url);
  if (!target) throw usage("--pr: 应为 https://github.com/owner/repo/pull/N");
  const given =
    input.worktree === undefined || input.worktree === null
      ? null
      : input.worktree;
  if (given !== null && (typeof given !== "string" || !isAbsolute(given)))
    throw usage("--worktree: 应为工作树的绝对路径");
  const task = getTask(db, reference);
  const refused =
    registerRefusal(task) ??
    (options.busy(task.id) ? `${task.ref} 的执行者还在跑或收尾，先停下` : null);
  if (refused) throw conflict(refused);
  const repo = repoOf(input.repo) ?? task.repo;
  if (!repo) throw usage(`${task.ref} 没记仓库：加 --repo 仓库路径`);
  const run = options.run;
  const origin = await originRepo(repo, run);
  if ("error" in origin) throw conflict(origin.error);
  const flag = repoFlag(origin.repo);
  if (repoFlag(target) !== flag)
    throw conflict(`PR 不在仓库 origin（${flag}）上`);
  const base = await defaultBranch(repo, run);
  const pr = await prHead(run, url, flag);
  const prBad = prRefusal(pr, base);
  if (prBad) throw conflict(prBad);
  const listed = await run(
    "git",
    ["-C", repo, "worktree", "list", "--porcelain"],
    {
      timeoutMs: 10_000,
    },
  );
  if (!listed.ok)
    throw conflict(`读不到仓库 ${repo} 的工作树：${firstLine(listed.stderr)}`);
  const real = async (path: string | null) =>
    path && existsSync(path) ? await realpath(path) : null;
  if (given !== null && !existsSync(given))
    throw usage(`--worktree 指向的目录不存在：${given}`);
  const copy = worktreePlan(
    repo,
    task.id,
    task.title,
    task.role ?? undefined,
  ).path;
  const choice = worktreeChoice({
    platform: process.platform,
    ref: task.ref,
    given: await real(given),
    own: await real(task.worktree),
    pr,
    worktrees: parseWorktrees(listed.stdout),
    copy: { path: copy, exists: existsSync(copy) },
  });
  if ("error" in choice) throw conflict(choice.error);
  return atomically(db, () => {
    // 查事实期间任务可能被别人改了：再判一次。
    const now = getTask(db, task.id);
    const late =
      registerRefusal(now) ??
      (options.busy(now.id) ? `${now.ref} 的执行者还在跑或收尾，先停下` : null);
    if (late) throw conflict(late);
    dequeue(db, task.id);
    const at = Date.now();
    db.prepare(
      `UPDATE tasks SET status='done',deliver='pr',pr_url=?,repo=?,branch=?,worktree=?,host_id=NULL,pid=NULL,
        ended_at=?,updated_at=? WHERE id=?`,
    ).run(url, repo, pr.headRefName, choice.worktree, at, at, task.id);
    noteTask(db, task.id, "delivery_registered", {
      pr_url: url,
      branch: pr.headRefName,
      worktree: choice.worktree ?? "合入队列另建",
      by: options.by,
    });
    return getTask(db, task.id);
  });
}

async function prHead(run: Exec, url: string, flag: string): Promise<PrHead> {
  const result = await run(
    "gh",
    [
      "pr",
      "view",
      url,
      "-R",
      flag,
      "--json",
      "state,headRefOid,headRefName,baseRefName,isCrossRepository",
    ],
    { timeoutMs: 30_000 },
  );
  if (!result.ok)
    throw conflict(`查不到 PR：${firstLine(result.stderr) || "gh 失败"}`);
  let data: Partial<PrHead> | null = null;
  try {
    data = JSON.parse(result.stdout) as Partial<PrHead>;
  } catch {
    // 下面统一报缺字段。
  }
  if (
    !data ||
    ![data.state, data.headRefOid, data.headRefName, data.baseRefName].every(
      (item) => typeof item === "string" && !!item,
    ) ||
    typeof data.isCrossRepository !== "boolean"
  )
    throw conflict("gh pr view 缺少登记所需字段");
  return data as PrHead;
}
