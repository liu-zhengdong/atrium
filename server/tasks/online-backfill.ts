import type { DatabaseSync } from "node:sqlite";
import { originRepo, repoFlag } from "./gh-repo.ts";
import type { Exec } from "./git.ts";
import { compareSemver } from "../releases.ts";
import { atomically, noteTask } from "./ledger.ts";
import { all, type TaskRow } from "./ledger-model.ts";
import { firstRelease, includedInVersion } from "./online.ts";

/**
 * 旧任务自动上线回填（t125）：没有 online_wait 的已合入任务，查过就记下。
 * 别的仓库一次判定后整仓跳过，不再每分钟起 git。
 */

export const LEGACY_ONLINE_SQL = `SELECT id,repo,pr_url,merge_commit FROM tasks INDEXED BY tasks_online_legacy
 WHERE id>? AND delivery_stage='merged' AND online_wait=0
   AND release_version IS NULL AND online_attempt IS NULL
   AND repo IS NOT NULL AND online_checked_at IS NULL
 ORDER BY id LIMIT 100`;

const SKIP_REPO_SQL = `UPDATE tasks SET online_checked_at=?
 WHERE repo=? AND delivery_stage='merged' AND online_wait=0
   AND release_version IS NULL AND online_attempt IS NULL
   AND online_checked_at IS NULL`;

export type LegacyRow = Pick<
  TaskRow,
  "id" | "repo" | "pr_url" | "merge_commit"
>;

export type BackfillPage = {
  db: DatabaseSync;
  run: Exec;
  selfRepo: string;
  current: string;
  now: number;
  closed: () => boolean;
  changed: (id: number) => void;
  commitOf: (row: LegacyRow) => Promise<string | null>;
  afterId: number;
};

export type BackfillResult = {
  lastId: number;
  count: number;
  more: boolean;
};

function markChecked(db: DatabaseSync, id: number, now: number) {
  db.prepare("UPDATE tasks SET online_checked_at=? WHERE id=?").run(now, id);
}

function skipRepo(db: DatabaseSync, repo: string, now: number) {
  db.prepare(SKIP_REPO_SQL).run(now, repo);
}

function groupByRepo(rows: LegacyRow[]) {
  const groups = new Map<string, LegacyRow[]>();
  for (const row of rows) {
    if (!row.repo) continue;
    const list = groups.get(row.repo) ?? [];
    list.push(row);
    groups.set(row.repo, list);
  }
  return groups;
}

async function fetchTags(
  repo: string,
  run: Exec,
  fetched: Map<string, boolean>,
) {
  if (fetched.has(repo)) return fetched.get(repo) === true;
  const result = await run(
    "git",
    ["-C", repo, "fetch", "--quiet", "--tags", "--force", "origin"],
    { timeoutMs: 120_000 },
  );
  fetched.set(repo, result.ok);
  return result.ok;
}

async function considerSelf(
  page: BackfillPage,
  row: LegacyRow,
  fetched: Map<string, boolean>,
) {
  if (page.closed() || !row.repo) return;
  const commit = row.merge_commit ?? (await page.commitOf(row));
  if (!commit) {
    markChecked(page.db, row.id, page.now);
    return;
  }
  if (!(await fetchTags(row.repo, page.run, fetched))) return;
  const tags = await page.run("git", [
    "-C",
    row.repo,
    "tag",
    "--contains",
    commit,
    "--list",
    "v*",
  ]);
  const release = tags.ok ? firstRelease(tags.stdout) : null;
  if (
    !release ||
    !includedInVersion(tags.stdout, page.current) ||
    compareSemver(release, page.current) > 0
  ) {
    markChecked(page.db, row.id, page.now);
    return;
  }
  atomically(page.db, () => {
    page.db
      .prepare(
        "UPDATE tasks SET delivery_stage='online',release_version=?,updated_at=? WHERE id=? AND delivery_stage='merged'",
      )
      .run(release, page.now, row.id);
    noteTask(page.db, row.id, "online_backfilled", {
      version: page.current,
      release,
    });
  });
  page.changed(row.id);
}

/** 一页至多 100 条；同一仓库的 origin 只查一次，非自身仓库整仓记下不再查。 */
export async function backfillLegacyPage(
  page: BackfillPage,
): Promise<BackfillResult> {
  const rows = all<LegacyRow>(page.db, LEGACY_ONLINE_SQL, page.afterId);
  if (!rows.length) return { lastId: 0, count: 0, more: false };
  const fetched = new Map<string, boolean>();
  for (const [repo, group] of groupByRepo(rows)) {
    if (page.closed()) break;
    const origin = await originRepo(repo, page.run);
    if ("error" in origin || repoFlag(origin.repo) !== page.selfRepo) {
      skipRepo(page.db, repo, page.now);
      continue;
    }
    for (const row of group) await considerSelf(page, row, fetched);
  }
  return {
    lastId: rows.at(-1)!.id,
    count: rows.length,
    more: rows.length === 100,
  };
}
