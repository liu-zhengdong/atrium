import type { DatabaseSync } from "node:sqlite";
import { all } from "./ledger-model.ts";
import { firstLine, type Exec } from "./git.ts";
import { originRepo, parsePrUrl, repoFlag } from "./gh-repo.ts";
import {
  locallyMerged,
  parsePrState,
  prNumber,
  type PrState,
  type Upstream,
} from "./schedule-upstream.ts";

/**
 * 排期巡检的 PR 刷新（t122）：把 gh / git 调用从逐候选的循环里挪出来，
 * 一页候选一次批量取到期的 PR，去重后串行查。已合入的不查；
 * 关闭或查不到的按连败次数退避，不再每分钟空转。可被关闭信号中断。
 */

const OPEN_INTERVAL_MS = 60_000;
const BACKOFF_MAX_MS = 24 * 60 * 60_000;

/** 退避时长：连败一次 1 分钟起，逐次翻倍，封顶一天。 */
export function backoffMs(attempts: number): number {
  const step = Math.min(Math.max(attempts, 1) - 1, 16);
  return Math.min(OPEN_INTERVAL_MS * 2 ** step, BACKOFF_MAX_MS);
}

const placeholders = (count: number) => Array(count).fill("?").join(",");

/**
 * 一页候选所等的上游交付 PR（驱动表是 task_dependencies，按 task_id 走索引，
 * 不按 tasks.status 扫全部已完成任务）。GROUP BY 让多个下游共用一次查询。
 */
export function upstreamDueQuery(candidates: number): string {
  return `SELECT t.id AS task_id,t.pr_url,t.repo,t.delivery_stage,t.merge_commit,
       m.pr_url AS cached_url,m.state,m.checked_at,m.next_check_at,m.attempts
     FROM task_dependencies d CROSS JOIN tasks t ON t.id=d.after_id
     LEFT JOIN task_pr_merge m ON m.task_id=t.id
     WHERE d.task_id IN (${placeholders(candidates)})
       AND t.status='done' AND t.deliver='pr' AND t.pr_url IS NOT NULL
       AND (m.state IS NULL OR m.state!='merged' OR m.pr_url IS NOT t.pr_url)
       AND (m.pr_url IS NOT t.pr_url OR m.next_check_at IS NULL OR m.next_check_at<=?)
     GROUP BY t.id
     ORDER BY m.next_check_at
     LIMIT 200`;
}

type UpstreamDue = Omit<Upstream, "pr_url"> & {
  pr_url: string;
  task_id: number;
  cached_url: string | null;
  state: PrState | null;
  checked_at: number | null;
  next_check_at: number | null;
  attempts: number | null;
};

type ExternalDue = {
  repo: string;
  number: number;
  error: string | null;
  attempts: number | null;
};

/** 刷新一页候选所等的 PR；stop 为真时尽快返回，不再发新的 gh / git。 */
export async function refreshDueSchedulePrs(
  db: DatabaseSync,
  candidateIds: number[],
  now: number,
  run: Exec,
  stop: () => boolean = () => false,
): Promise<void> {
  if (!candidateIds.length) return;
  await refreshUpstream(db, candidateIds, now, run, stop);
  if (!stop()) await refreshExternal(db, candidateIds, now, run, stop);
}

async function refreshUpstream(
  db: DatabaseSync,
  candidateIds: number[],
  now: number,
  run: Exec,
  stop: () => boolean,
) {
  const rows = all<UpstreamDue>(
    db,
    upstreamDueQuery(candidateIds.length),
    ...candidateIds,
    now,
  );
  const targets = new Map<string, string>();
  const write = db.prepare(
    `INSERT INTO task_pr_merge(task_id,pr_url,state,checked_at,error,next_check_at,attempts)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(task_id) DO UPDATE SET pr_url=excluded.pr_url,state=excluded.state,
       checked_at=excluded.checked_at,error=excluded.error,
       next_check_at=excluded.next_check_at,attempts=excluded.attempts`,
  );
  for (const row of rows) {
    if (stop()) return;
    // 本地已合入：直接记下，不问 gh。
    if (locallyMerged(row)) {
      write.run(row.task_id, row.pr_url, "merged", now, null, null, 0);
      continue;
    }
    // 换了新 PR 时旧 PR 的连败次数不继承，从 0 算起（否则新 PR 会被旧退避挡住）。
    const fresh = row.cached_url === row.pr_url;
    const prior = fresh ? (row.attempts ?? 0) : 0;
    let state: PrState | null = null;
    let error: string | null = null;
    let nextCheckAt: number | null = now + OPEN_INTERVAL_MS;
    let attempts = 0;
    try {
      const target = await ghTarget(row, targets, run);
      const result = await run(
        "gh",
        [
          "pr",
          "view",
          String(prNumber(row.pr_url)),
          "-R",
          target,
          "--json",
          "state,mergedAt",
        ],
        { timeoutMs: 15_000 },
      );
      if (!result.ok)
        throw new Error(firstLine(result.stderr) || "gh 查询失败");
      state = parsePrState(result.stdout);
      if (state === "merged") nextCheckAt = null;
      else if (state === "closed") {
        attempts = prior + 1;
        nextCheckAt = now + backoffMs(attempts);
      } else nextCheckAt = now + OPEN_INTERVAL_MS;
    } catch (cause) {
      // 关服务中止的查询不算失败，不写库（否则看板会显示「查询失败：已取消」）。
      if (stop()) return;
      error = (cause instanceof Error ? cause.message : String(cause)).slice(
        0,
        300,
      );
      // 查询失败保留上次查到的状态，只记下错误，并按连败退避。
      state = fresh ? row.state : null;
      attempts = prior + 1;
      nextCheckAt = now + backoffMs(attempts);
    }
    write.run(
      row.task_id,
      row.pr_url,
      state,
      now,
      error,
      nextCheckAt,
      attempts,
    );
  }
}

async function refreshExternal(
  db: DatabaseSync,
  candidateIds: number[],
  now: number,
  run: Exec,
  stop: () => boolean,
) {
  const rows = all<ExternalDue>(
    db,
    `SELECT p.repo,p.number,p.error,p.attempts
     FROM task_pr_dependencies p
     WHERE p.task_id IN (${placeholders(candidateIds.length)})
       AND p.merged=0
       AND (p.next_check_at IS NULL OR p.next_check_at<=?)
     ORDER BY p.next_check_at
     LIMIT 200`,
    ...candidateIds,
    now,
  );
  // 同一个 PR 被多个任务引用时只查一次。
  const pending = new Map<string, ExternalDue>();
  for (const row of rows) pending.set(`${row.repo}#${row.number}`, row);
  const update = db.prepare(
    "UPDATE task_pr_dependencies SET merged=?,checked_at=?,error=?,next_check_at=?,attempts=? WHERE repo=? AND number=? AND merged=0",
  );
  for (const row of pending.values()) {
    if (stop()) return;
    const prior = row.attempts ?? 0;
    let merged = false;
    let error: string | null = null;
    let nextCheckAt: number | null = now + OPEN_INTERVAL_MS;
    let attempts = 0;
    try {
      const result = await run(
        "gh",
        [
          "pr",
          "view",
          String(row.number),
          "-R",
          row.repo,
          "--json",
          "state,mergedAt",
        ],
        { timeoutMs: 15_000 },
      );
      if (!result.ok)
        throw new Error(firstLine(result.stderr) || "gh 查询失败");
      const state = parsePrState(result.stdout);
      merged = state === "merged";
      if (merged) nextCheckAt = null;
      else if (state === "closed") {
        // 已关闭的外部 PR 按连败退避，不再每分钟查。
        attempts = prior + 1;
        nextCheckAt = now + backoffMs(attempts);
      }
    } catch (cause) {
      if (stop()) return;
      error = (cause instanceof Error ? cause.message : String(cause)).slice(
        0,
        300,
      );
      attempts = prior + 1;
      nextCheckAt = now + backoffMs(attempts);
    }
    update.run(
      merged ? 1 : 0,
      now,
      error,
      nextCheckAt,
      attempts,
      row.repo,
      row.number,
    );
  }
}

/** `-R` 目标按任务仓库的 origin 解析；任务没记仓库或 origin 不是托管地址时用 PR 链接里的仓库。同一轮里同一仓库只解析一次。 */
async function ghTarget(
  row: Upstream & { pr_url: string },
  targets: Map<string, string>,
  run: Exec,
) {
  if (row.repo) {
    const cached = targets.get(row.repo);
    if (cached) return cached;
    const origin = await originRepo(row.repo, run);
    if ("repo" in origin) {
      const flag = repoFlag(origin.repo);
      targets.set(row.repo, flag);
      return flag;
    }
  }
  const fromUrl = parsePrUrl(row.pr_url);
  if (!fromUrl) throw new Error(`PR 链接 ${row.pr_url} 解析不出 owner/repo`);
  return repoFlag(fromUrl);
}
