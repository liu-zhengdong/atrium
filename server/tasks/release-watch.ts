import type { DatabaseSync } from "node:sqlite";
import { redact } from "../secret-redact.ts";
import type { Exec } from "./git.ts";
import { originRepo, repoFlag } from "./gh-repo.ts";
import { atomically, noteTask } from "./ledger.ts";
import {
  failedStep,
  logSummary,
  parseRuns,
  RELEASE_RUNS_LIMIT,
  RELEASE_WORKFLOW,
  type ReleaseRun,
} from "./release-run.ts";

/**
 * 盯发版工作流的 IO（t265）：按仓库取最近的发版运行、取失败运行挂在哪一步与日志摘要、记上线失败。
 * 判定在 `release-run.ts`；一轮上线巡检新建一个 ReleaseRuns，同一仓库、同一运行只查一次。
 */
export class ReleaseRuns {
  private readonly lists = new Map<
    string,
    Promise<{ flag: string; runs: ReleaseRun[] } | null>
  >();
  private readonly failures = new Map<
    number,
    Promise<{ step: string | null; tests: string[]; log: string }>
  >();

  constructor(private readonly run: Exec) {}

  /** 仓库（本地路径）最近的发版运行；gh 查不到或读不懂为 null（不下结论）。 */
  list(repo: string) {
    let list = this.lists.get(repo);
    if (!list) {
      list = this.fetch(repo);
      this.lists.set(repo, list);
    }
    return list;
  }

  private async fetch(repo: string) {
    const origin = await originRepo(repo, this.run);
    if ("error" in origin) return null;
    const flag = repoFlag(origin.repo);
    const result = await this.run(
      "gh",
      [
        "run",
        "list",
        "-R",
        flag,
        "--workflow",
        RELEASE_WORKFLOW,
        "--limit",
        String(RELEASE_RUNS_LIMIT),
        "--json",
        "databaseId,headSha,status,conclusion,createdAt,url",
      ],
      { timeoutMs: 60_000 },
    );
    if (!result.ok) return null;
    const runs = parseRuns(result.stdout);
    return runs ? { flag, runs } : null;
  }

  /** 失败的运行挂在哪一步、失败用例与日志尾部摘要（凭据抹掉）；取不到的项留空。 */
  failure(flag: string, id: number) {
    let failure = this.failures.get(id);
    if (!failure) {
      failure = this.describe(flag, id);
      this.failures.set(id, failure);
    }
    return failure;
  }

  private async describe(flag: string, id: number) {
    const [jobs, log] = await Promise.all([
      this.run(
        "gh",
        ["run", "view", String(id), "-R", flag, "--json", "jobs"],
        {
          timeoutMs: 60_000,
        },
      ),
      this.run("gh", ["run", "view", String(id), "-R", flag, "--log-failed"], {
        timeoutMs: 120_000,
      }),
    ]);
    const summary = log.ok ? logSummary(log.stdout) : { tests: [], log: "" };
    return {
      step: jobs.ok ? failedStep(jobs.stdout) : null,
      tests: summary.tests.map(redact),
      log: redact(summary.log),
    };
  }
}

/**
 * 记上线失败（发版这一段）：tasks.release_failed_at 置上（紧急通道据此不再让路，同一件只记一次），
 * 同一事务里记事件；投递由调用方做。返回这次记上没有（已记过为 false）。
 */
export function markReleaseFailed(
  db: DatabaseSync,
  id: number,
  kind: "release_failed" | "release_overdue",
  detail: Record<string, unknown>,
  now: number,
): boolean {
  return atomically(db, () => {
    const changed = db
      .prepare(
        "UPDATE tasks SET release_failed_at=?,updated_at=? WHERE id=? AND release_failed_at IS NULL",
      )
      .run(now, now, id).changes;
    if (!changed) return false;
    noteTask(db, id, kind, detail);
    return true;
  });
}
