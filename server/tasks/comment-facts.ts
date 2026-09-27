import { exec as defaultExec, type Exec } from "./git.ts";
import { apiArgs, originRepo } from "./gh-repo.ts";

export type IssueComment = { created_at: string; html_url: string };
export type CommentFacts = { comments: IssueComment[]; error?: string };

/** gh 按更新时间分页筛选；创建时间仍由纯关卡逐条核对。仓库取自 origin，不让 gh 在 fork 里猜到上游。 */
export async function collectComments(
  repo: string | null,
  issue: number,
  startedAt: number,
  run: Exec = defaultExec,
): Promise<CommentFacts> {
  if (!repo)
    return { comments: [], error: "任务没有仓库，无法查询 issue 评论" };
  const origin = await originRepo(repo, run);
  if ("error" in origin) return { comments: [], error: origin.error };
  const response = await run(
    "gh",
    [
      ...apiArgs(origin.repo, `issues/${issue}/comments`),
      "--method",
      "GET",
      "-f",
      `since=${new Date(startedAt - 1000).toISOString()}`,
      "-f",
      "per_page=100",
      "--paginate",
      "--slurp",
    ],
    { timeoutMs: 30_000 },
  );
  if (!response.ok)
    return {
      comments: [],
      error: response.stderr.trim().split("\n")[0] || "gh 查询失败",
    };
  try {
    const pages: unknown = JSON.parse(response.stdout);
    if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error();
    const comments = pages
      .flat()
      .filter(
        (item): item is IssueComment =>
          !!item &&
          typeof item === "object" &&
          typeof item.created_at === "string" &&
          typeof item.html_url === "string",
      );
    return { comments };
  } catch {
    return { comments: [], error: "gh 评论输出不是预期 JSON" };
  }
}
