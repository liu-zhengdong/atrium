import type { DatabaseSync } from "node:sqlite";
import { all, type TaskRow } from "./ledger-model.ts";
import { firstLine, type Exec } from "./git.ts";
import { originRepo, parsePrUrl, repoFlag } from "./gh-repo.ts";

/**
 * 上游交付 PR 的合入状态（#262）：运行时的 done 只表示交付物过了关卡，
 * 合入由交付关卡后的运行时队列完成；`--after tN` 在 tN 交付 PR 时要等这个 PR 合入。
 * 状态按上游任务缓存，多个下游共用一次查询。
 */

export type PrState = "open" | "merged" | "closed";
export type UpstreamPr = {
  number: number;
  state: PrState | null;
  error: string | null;
};
/**
 * 上游交付的上线进度（t130）：合入服务自身仓库的要等自动上线，新命令上线后下游才用得上。
 * merging：运行时正在合入，gh 显示已合入也还没记账；waiting：已合入、等发版上线；
 * online：已上线；failed：自升级失败，停在已合入。不经自动上线的（别的仓库、本服务不自升级、
 * 不经合入队列）没有这一项，合入即满足。
 */
export type Release = "merging" | "waiting" | "online" | "failed";
export type Dependency = {
  ref: string;
  status: TaskRow["status"];
  pr?: UpstreamPr;
  release?: Release;
};

/** 账本事实 → 上线进度；`failed` 指合入后最近一次上线结论是失败。 */
export function releaseOf(facts: {
  delivery_stage: TaskRow["delivery_stage"];
  online_wait: number;
  online_failed: boolean;
}): Release | undefined {
  if (facts.delivery_stage === "merging") return "merging";
  if (facts.delivery_stage === "online") return "online";
  if (facts.delivery_stage !== "merged") return undefined;
  if (facts.online_wait === 1) return "waiting";
  return facts.online_failed ? "failed" : undefined;
}

export function ensureUpstreamPrTable(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_pr_merge (
    task_id INTEGER PRIMARY KEY REFERENCES tasks(id), pr_url TEXT NOT NULL,
    state TEXT CHECK(state IN ('open','merged','closed')), checked_at INTEGER, error TEXT);`);
}

export function prNumber(url: string): number | null {
  const match = /\/pull\/([1-9][0-9]*)\/?$/.exec(url.trim());
  const number = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(number) ? number : null;
}

type Upstream = Pick<TaskRow, "id" | "status" | "deliver" | "pr_url" | "repo">;
type UpstreamRow = Upstream & Pick<TaskRow, "delivery_stage" | "online_wait">;

/** 只有交付 PR 且已记下链接的 done 任务才要等合入；comment、none 或没记 PR 的，done 即满足。 */
function watched(row: Upstream): row is Upstream & { pr_url: string } {
  return (
    row.status === "done" &&
    row.deliver === "pr" &&
    !!row.pr_url &&
    prNumber(row.pr_url) !== null
  );
}

/** 合入之后最近一次上线结论是不是失败（online_failed 晚于最近的 merged）。 */
function onlineFailed(db: DatabaseSync, id: number) {
  const last = db
    .prepare(
      "SELECT kind FROM task_events WHERE task_id=? AND kind IN ('merged','online','online_backfilled','online_failed') ORDER BY id DESC LIMIT 1",
    )
    .get(id) as { kind: string } | undefined;
  return last?.kind === "online_failed";
}

export function dependencyOf(db: DatabaseSync, id: number): Dependency {
  const row = db
    .prepare(
      "SELECT id,status,deliver,pr_url,repo,delivery_stage,online_wait FROM tasks WHERE id=?",
    )
    .get(id) as UpstreamRow;
  const ref = `t${id}`;
  if (!watched(row)) return { ref, status: row.status };
  const release = releaseOf({
    delivery_stage: row.delivery_stage,
    online_wait: row.online_wait,
    online_failed:
      row.delivery_stage === "merged" &&
      row.online_wait === 0 &&
      onlineFailed(db, id),
  });
  const cached = db
    .prepare(
      "SELECT state,error FROM task_pr_merge WHERE task_id=? AND pr_url=?",
    )
    .get(id, row.pr_url) as
    { state: PrState | null; error: string | null } | undefined;
  return {
    ref,
    status: row.status,
    pr: {
      number: prNumber(row.pr_url)!,
      state: cached?.state ?? null,
      error: cached?.error ?? null,
    },
    ...(release ? { release } : {}),
  };
}

/** gh 的 state 字段：MERGED、CLOSED、OPEN；读不懂就报错，不当作合入。 */
export function parsePrState(stdout: string): PrState {
  const parsed = JSON.parse(stdout) as { state?: unknown; mergedAt?: unknown };
  if (parsed.state === "MERGED" || parsed.mergedAt) return "merged";
  if (parsed.state === "CLOSED") return "closed";
  if (parsed.state === "OPEN") return "open";
  throw new Error(`gh 返回的 PR 状态看不懂：${String(parsed.state)}`);
}

/** 刷新某任务全部上游的 PR 状态；已合入的不再查，其余每分钟最多查一次。 */
export async function refreshUpstreamPrs(
  db: DatabaseSync,
  taskId: number,
  now: number,
  run: Exec,
) {
  const rows = all<
    Upstream & {
      cached_url: string | null;
      checked_at: number | null;
      state: PrState | null;
    }
  >(
    db,
    `SELECT t.id,t.status,t.deliver,t.pr_url,t.repo,m.pr_url AS cached_url,m.checked_at,m.state
     FROM task_dependencies d JOIN tasks t ON t.id=d.after_id LEFT JOIN task_pr_merge m ON m.task_id=t.id
     WHERE d.task_id=? AND t.status='done' AND t.deliver='pr' AND t.pr_url IS NOT NULL
     ORDER BY t.id LIMIT 20`,
    taskId,
  );
  for (const row of rows) {
    if (!watched(row)) continue;
    const fresh = row.cached_url === row.pr_url;
    if (
      fresh &&
      (row.state === "merged" ||
        (row.checked_at !== null && row.checked_at >= now - 60_000))
    )
      continue;
    let state: PrState | null = null;
    let error: string | null = null;
    try {
      const target = await ghTarget(row, run);
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
    } catch (cause) {
      error = (cause instanceof Error ? cause.message : String(cause)).slice(
        0,
        300,
      );
      // 查询失败保留上次查到的状态，只记下错误。
      state = fresh ? row.state : null;
    }
    db.prepare(
      `INSERT INTO task_pr_merge(task_id,pr_url,state,checked_at,error) VALUES (?,?,?,?,?)
       ON CONFLICT(task_id) DO UPDATE SET pr_url=excluded.pr_url,state=excluded.state,checked_at=excluded.checked_at,error=excluded.error`,
    ).run(row.id, row.pr_url, state, now, error);
  }
}

/** `-R` 目标按任务仓库的 origin 解析；任务没记仓库或 origin 不是托管地址时用 PR 链接里的仓库。 */
async function ghTarget(row: Upstream & { pr_url: string }, run: Exec) {
  if (row.repo) {
    const origin = await originRepo(row.repo, run);
    if ("repo" in origin) return repoFlag(origin.repo);
  }
  const fromUrl = parsePrUrl(row.pr_url);
  if (!fromUrl) throw new Error(`PR 链接 ${row.pr_url} 解析不出 owner/repo`);
  return repoFlag(fromUrl);
}
