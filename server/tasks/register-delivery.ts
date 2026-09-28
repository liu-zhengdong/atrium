import { samePath } from "../platform/plan.ts";
import type { Platform } from "../platform/plan.ts";
import type { Task } from "./ledger-model.ts";

/**
 * 秘书、leader 亲自做完的活登记交付（t257，`task deliver`）：给 PR 与可选的工作树，核对后进合入队列。
 * 这里只放判定，git / gh 取事实在 register-delivery-runtime.ts。
 */

export type WorktreeEntry = {
  path: string;
  head: string | null;
  branch: string | null;
};

/** `git worktree list --porcelain` → 各工作树；第一条是主工作树。 */
export function parseWorktrees(text: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  for (const block of text.replace(/\r\n/g, "\n").split(/\n\n+/)) {
    let entry: WorktreeEntry | null = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree "))
        entry = {
          path: line.slice("worktree ".length),
          head: null,
          branch: null,
        };
      else if (entry && line.startsWith("HEAD ")) entry.head = line.slice(5);
      else if (entry && line.startsWith("branch refs/heads/"))
        entry.branch = line.slice("branch refs/heads/".length);
    }
    if (entry) entries.push(entry);
  }
  return entries;
}

/** 任务此刻能不能登记交付；能则返回 null。 */
export function registerRefusal(
  task: Pick<Task, "ref" | "status" | "delivery_stage">,
): string | null {
  if (task.status === "running")
    return `${task.ref} 正在跑，先 atrium task stop ${task.ref} 再登记`;
  if (task.status === "cancelled") return `${task.ref} 已取消，不能登记交付`;
  switch (task.delivery_stage) {
    case "reviewing":
      return `${task.ref} 正在审阅，等审阅结论`;
    case "merge_queued":
    case "merging":
      return `${task.ref} 已在合入队列`;
    case "merged":
    case "online":
      return `${task.ref} 已合入`;
    default:
      return null;
  }
}

export type PrHead = {
  state: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  isCrossRepository: boolean;
};

/** PR 能不能交给合入队列（与合入时的核对一致）；能则返回 null。base 为仓库默认分支。 */
export function prRefusal(pr: PrHead, base: string): string | null {
  if (pr.state === "MERGED") return "PR 已合入，不用再排队";
  if (pr.state !== "OPEN") return `PR 不是打开状态（${pr.state}）`;
  if (pr.isCrossRepository)
    return "PR 来源不是仓库 origin 的分支，合入队列不收";
  if (pr.baseRefName !== base)
    return `PR 目标分支是 ${pr.baseRefName}，合入队列只合到 ${base}`;
  return null;
}

/**
 * 合入用哪个工作树。给了的：须是这个仓库的附属工作树（不是主工作树），在 PR 分支上、头提交与 PR 一致。
 * 没给的：PR 分支没在任何工作树检出就由合入队列另建（worktree 为 null；另建的路径已被占用则请调用方处理）；检出在任务原来的工作树上就用它；
 * 检出在别处则请调用方明说（git 不许同一分支检出两次，而合入后工作树要清理）。
 */
export function worktreeChoice(input: {
  platform: Platform;
  ref: string;
  given: string | null;
  own: string | null;
  pr: Pick<PrHead, "headRefName" | "headRefOid">;
  worktrees: readonly WorktreeEntry[];
  /** 合入队列另建时用的路径（按任务工作树规则）与它是否已存在。 */
  copy: { path: string; exists: boolean };
}): { worktree: string | null } | { error: string } {
  const { platform, pr, worktrees } = input;
  const main = worktrees[0];
  const find = (path: string) =>
    worktrees.find((entry) => samePath(platform, entry.path, path));
  if (input.given !== null) {
    const entry = find(input.given);
    if (!entry)
      return { error: `--worktree ${input.given} 不是任务仓库的工作树` };
    if (entry === main)
      return {
        error: `--worktree ${input.given} 是仓库主工作树，合入后会被清理，不能交给合入队列；不给 --worktree 由合入队列另建`,
      };
    if (entry.branch !== pr.headRefName)
      return {
        error: `--worktree 在分支 ${entry.branch ?? "（分离头）"} 上，PR 的分支是 ${pr.headRefName}`,
      };
    if (entry.head !== pr.headRefOid)
      return {
        error: `--worktree 的头提交 ${short(entry.head)} 与 PR 头提交 ${short(pr.headRefOid)} 不一致：先推送或拉齐`,
      };
    return { worktree: entry.path };
  }
  const holder = worktrees.find((entry) => entry.branch === pr.headRefName);
  if (!holder)
    return input.copy.exists
      ? {
          error: `合入队列要另建的工作树 ${input.copy.path} 已被占用：加 --worktree 给出 PR 分支所在的工作树，或先清掉它`,
        }
      : { worktree: null };
  if (
    holder !== main &&
    input.own &&
    samePath(platform, holder.path, input.own)
  )
    return holder.head === pr.headRefOid
      ? { worktree: holder.path }
      : {
          error: `${input.ref} 的工作树头提交 ${short(holder.head)} 与 PR 头提交 ${short(pr.headRefOid)} 不一致：先推送或拉齐`,
        };
  return {
    error:
      holder === main
        ? `PR 分支 ${pr.headRefName} 检出在仓库主工作树上：先切走分支，合入队列另建工作树`
        : `PR 分支 ${pr.headRefName} 已检出在 ${holder.path}：加 --worktree ${holder.path} 交给合入队列（合入后清理），或先在那里切走分支`,
  };
}

const short = (sha: string | null) => (sha ? sha.slice(0, 8) : "（无）");
