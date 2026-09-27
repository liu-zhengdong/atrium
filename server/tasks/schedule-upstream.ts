import type { DatabaseSync } from "node:sqlite";
import { all, type TaskRow } from "./ledger-model.ts";

/**
 * 上游交付 PR 的合入状态（#262）：运行时的 done 只表示交付物过了关卡，
 * 合入由交付关卡后的运行时队列完成；`--after tN` 在 tN 交付 PR 时要等这个 PR 合入。
 * 状态按上游任务缓存，多个下游共用一次查询。刷新与退避在 schedule-refresh.ts。
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

/** 本地已记下合入的任务：不必再问 gh。 */
export function locallyMerged(row: {
  delivery_stage: TaskRow["delivery_stage"];
  merge_commit: string | null;
}): boolean {
  return (
    row.delivery_stage === "merged" ||
    row.delivery_stage === "online" ||
    row.merge_commit !== null
  );
}

export function ensureUpstreamPrTable(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_pr_merge (
    task_id INTEGER PRIMARY KEY REFERENCES tasks(id), pr_url TEXT NOT NULL,
    state TEXT CHECK(state IN ('open','merged','closed')), checked_at INTEGER, error TEXT);`);
  const columns = all<{ name: string }>(db, "PRAGMA table_info(task_pr_merge)");
  // 关闭与查不到的 PR 退避（t122）：记下下次可查时刻与连败次数，不再每分钟空转。
  if (!columns.some((column) => column.name === "next_check_at"))
    db.exec("ALTER TABLE task_pr_merge ADD COLUMN next_check_at INTEGER");
  if (!columns.some((column) => column.name === "attempts"))
    db.exec(
      "ALTER TABLE task_pr_merge ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0",
    );
  // 旧库没有 next_check_at：按上次查询时刻沿用一分钟节奏补上，避免升级瞬间全体重查。
  db.exec(
    "UPDATE task_pr_merge SET next_check_at=COALESCE(checked_at,0)+60000 WHERE next_check_at IS NULL",
  );
}

export function prNumber(url: string): number | null {
  const match = /\/pull\/([1-9][0-9]*)\/?$/.exec(url.trim());
  const number = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(number) ? number : null;
}

type Upstream = Pick<
  TaskRow,
  | "id"
  | "status"
  | "deliver"
  | "pr_url"
  | "repo"
  | "delivery_stage"
  | "merge_commit"
  | "online_wait"
>;

/** 只有交付 PR 且已记下链接的 done 任务才要等合入；comment、none 或没记 PR 的，done 即满足。 */
export function watched(row: Upstream): row is Upstream & { pr_url: string } {
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
      "SELECT id,status,deliver,pr_url,repo,delivery_stage,merge_commit,online_wait FROM tasks WHERE id=?",
    )
    .get(id) as Upstream;
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
  // 本地已合入的（#322 合入队列）不必等 gh 结果。
  const state = locallyMerged(row) ? "merged" : (cached?.state ?? null);
  return {
    ref,
    status: row.status,
    pr: {
      number: prNumber(row.pr_url)!,
      state,
      error: state === "merged" ? null : (cached?.error ?? null),
    },
    ...(release ? { release } : {}),
  };
}

/** 一页用到的上游任务批量取依赖状态（k23）：常数条查询，不随下游数线性增长。 */
export function dependencyOfMany(
  db: DatabaseSync,
  ids: number[],
): Map<number, Dependency> {
  const result = new Map<number, Dependency>();
  if (!ids.length) return result;
  const list = ids.map(() => "?").join(",");
  const rows = all<Upstream>(
    db,
    `SELECT id,status,deliver,pr_url,repo,delivery_stage,merge_commit,online_wait FROM tasks WHERE id IN (${list})`,
    ...ids,
  );
  // 合入后最近一次上线结论（t130）：只看停在 merged、不等上线的，一条查询取各自最新一条。
  const settled = rows.filter(
    (row) => row.delivery_stage === "merged" && row.online_wait === 0,
  );
  const failed = new Set<number>();
  if (settled.length)
    for (const row of all<{ task_id: number; kind: string }>(
      db,
      `SELECT task_id,kind FROM task_events WHERE id IN (SELECT MAX(id) FROM task_events WHERE task_id IN (${settled.map(() => "?").join(",")}) AND kind IN ('merged','online','online_backfilled','online_failed') GROUP BY task_id)`,
      ...settled.map((row) => row.id),
    ))
      if (row.kind === "online_failed") failed.add(row.task_id);
  const cached = new Map<
    number,
    { pr_url: string; state: PrState | null; error: string | null }
  >();
  for (const row of all<{
    task_id: number;
    pr_url: string;
    state: PrState | null;
    error: string | null;
  }>(
    db,
    `SELECT task_id,pr_url,state,error FROM task_pr_merge WHERE task_id IN (${list})`,
    ...ids,
  ))
    cached.set(row.task_id, row);
  for (const row of rows) {
    const ref = `t${row.id}`;
    if (!watched(row)) {
      result.set(row.id, { ref, status: row.status });
      continue;
    }
    const release = releaseOf({
      delivery_stage: row.delivery_stage,
      online_wait: row.online_wait,
      online_failed: failed.has(row.id),
    });
    const hit = cached.get(row.id);
    const fresh = hit?.pr_url === row.pr_url;
    const state = locallyMerged(row)
      ? "merged"
      : fresh
        ? (hit!.state ?? null)
        : null;
    result.set(row.id, {
      ref,
      status: row.status,
      pr: {
        number: prNumber(row.pr_url)!,
        state,
        error: state === "merged" ? null : fresh ? (hit!.error ?? null) : null,
      },
      ...(release ? { release } : {}),
    });
  }
  return result;
}

/** gh 的 state 字段：MERGED、CLOSED、OPEN；读不懂就报错，不当作合入。 */
export function parsePrState(stdout: string): PrState {
  const parsed = JSON.parse(stdout) as { state?: unknown; mergedAt?: unknown };
  if (parsed.state === "MERGED" || parsed.mergedAt) return "merged";
  if (parsed.state === "CLOSED") return "closed";
  if (parsed.state === "OPEN") return "open";
  throw new Error(`gh 返回的 PR 状态看不懂：${String(parsed.state)}`);
}

export type { Upstream };
