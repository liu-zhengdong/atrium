import type { Deliver } from "./deliver.ts";
import type { CommentFacts } from "./comment-facts.ts";
import {
  evaluateGates,
  type Facts,
  type GateResult,
  type Verdict,
} from "./gates.ts";

function verdict(results: GateResult[]): Verdict {
  const failed = results.filter((result) => !result.ok);
  return { results, failed, passed: failed.length === 0 };
}

/** 交付物关卡只吃已收集的事实，不调用 git/gh。 */
export function evaluateDelivery(input: {
  deliver: Deliver;
  issue: number | null;
  startedAt: number;
  endedAt: number;
  comments?: CommentFacts;
  checks: readonly string[];
  limits: Record<string, number>;
  facts?: Facts;
}): Verdict {
  if (input.deliver === "pr") {
    if (!input.facts) throw new Error("PR 交付缺少仓库事实");
    return evaluateGates(input.checks, input.limits, input.facts);
  }
  if (input.deliver === "none") return verdict([]);
  const { issue, comments, startedAt, endedAt } = input;
  if (!issue)
    return verdict([
      { gate: "comment", ok: false, evidence: "任务没有 issue 号" },
    ]);
  if (!comments)
    return verdict([{ gate: "comment", ok: false, evidence: "没有查询评论" }]);
  if (comments.error)
    return verdict([
      {
        gate: "comment",
        ok: false,
        evidence: `issue #${issue} 评论查询失败：${comments.error}`,
      },
    ]);
  // GitHub 评论时间精度为秒；本秒内的评论视为运行期间。
  const startSecond = Math.floor(startedAt / 1000) * 1000;
  const found = comments.comments.find((comment) => {
    const at = Date.parse(comment.created_at);
    return (
      Number.isFinite(at) &&
      at >= startSecond &&
      at <= endedAt &&
      /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+#issuecomment-\d+$/.test(
        comment.html_url,
      )
    );
  });
  return verdict([
    {
      gate: "comment",
      ok: !!found,
      evidence: found
        ? `issue #${issue} 在运行期间新增评论：${found.html_url}`
        : `issue #${issue} 在运行期间没有新评论`,
    },
  ]);
}
