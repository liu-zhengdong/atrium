import type { FileStat } from "./gate-parse.ts";
import { TRUSTS, type Risk, type Trust } from "./profiles.ts";

/**
 * 合入前的审阅关卡（#325 设计 3）：纯判定。
 * 高风险或低信任执行者的 PR 先派一个不同模型的一次性审阅者，按清单给出通过或打回；
 * 其余直接进合入队列。IO（挑人、派活、读结论）在 review-runtime.ts。
 */

/** 可信：执行者档案 trust 至少 medium。 */
const TRUSTED = TRUSTS.indexOf("medium");

export type ReviewNeed = { needed: false } | { needed: true; reason: string };

/** 是否要审阅：风险 high，或执行者 trust 低于 medium（缺档案按 unknown）。 */
export function reviewNeed(risk: Risk, trust: Trust | undefined): ReviewNeed {
  const actual = trust ?? "unknown";
  const reasons = [
    risk === "high" ? "任务风险 high" : "",
    TRUSTS.indexOf(actual) < TRUSTED ? `执行者 trust=${actual}` : "",
  ].filter(Boolean);
  return reasons.length
    ? { needed: true, reason: reasons.join("，") }
    : { needed: false };
}

export type ReviewerCandidate = {
  tool: string;
  model?: string;
  trust?: Trust;
};

/** 审阅者须与原执行者不同工具、不同模型，且自身 trust 至少 medium；不合格时返回原因。 */
export function reviewerRefusal(
  original: { tool: string; model?: string },
  candidate: ReviewerCandidate,
): string | undefined {
  if (candidate.tool === original.tool)
    return `${candidate.tool} 与原执行者同一工具`;
  if (candidate.model && original.model && candidate.model === original.model)
    return `${candidate.tool} 与原执行者同一模型 ${candidate.model}`;
  const trust = candidate.trust ?? "unknown";
  if (TRUSTS.indexOf(trust) < TRUSTED)
    return `${candidate.tool} 的档案 trust=${trust}，审阅者至少 medium`;
  return undefined;
}

export type ReviewVerdict = { passed: boolean; notes: string };

const VERDICT_RE = /审阅结论\s*[:：]\s*\**\s*(通过|打回)/g;
export const NOTES_MAX = 1500;

/**
 * 从审阅者的收尾摘要读结论：取最后一个「审阅结论：通过/打回」，之前的文字作意见。
 * 没有结论返回 null，不猜：退出时先请同一审阅者补答一次（conclusion.ts），补答后仍没有才由调用方转卡住。
 */
export function parseReviewVerdict(text: string | null): ReviewVerdict | null {
  if (!text) return null;
  let last: RegExpExecArray | undefined;
  for (const match of text.matchAll(VERDICT_RE)) last = match;
  if (!last) return null;
  const before = text.slice(0, last.index).trim();
  const notes =
    before.length > NOTES_MAX ? `…${before.slice(-NOTES_MAX)}` : before;
  return { passed: last[1] === "通过", notes };
}

export type DiffSummary = {
  files: number;
  added: number;
  removed: number;
  /** 改动最多的文件，最多 10 个。 */
  top: FileStat[];
  /** 一行人话：给秘书看。 */
  text: string;
};

/** 改动规模摘要：文件数、增删行数与改动最多的文件。 */
export function diffSummary(stats: readonly FileStat[]): DiffSummary {
  const added = stats.reduce((sum, s) => sum + s.added, 0);
  const removed = stats.reduce((sum, s) => sum + s.removed, 0);
  const top = [...stats]
    .sort(
      (a, b) =>
        b.added + b.removed - (a.added + a.removed) ||
        a.file.localeCompare(b.file),
    )
    .slice(0, 10);
  const head = `改动 ${stats.length} 个文件，+${added} −${removed}`;
  const text = top.length
    ? `${head}：${top.map((s) => `${s.file}（+${s.added} −${s.removed}）`).join("、")}${stats.length > top.length ? ` 等` : ""}`
    : head;
  return { files: stats.length, added, removed, top, text };
}

/** 派给审阅者的任务详述：只读、按清单审、最后一行固定格式给结论。 */
export function reviewBrief(input: {
  ref: string;
  title: string;
  prUrl: string;
  repoFlag: string;
  worktree: string;
  base: string;
  risk: Risk;
  reason: string;
  diff: DiffSummary;
  brief?: string | null;
}): string {
  return [
    `# 审阅 ${input.ref} 的 PR`,
    "",
    `原任务：${input.ref} ${input.title}`,
    `PR：${input.prUrl}（gh 查询一律带 -R ${input.repoFlag}）`,
    `代码：${input.worktree}（分支已推送；对比基线 origin/${input.base}）`,
    `为什么要审阅：${input.reason}；任务风险 ${input.risk}`,
    `改动规模：${input.diff.text}`,
    ...(input.brief ? ["", "## 原任务详述", "", input.brief.trim()] : []),
    "",
    "## 怎么看",
    "",
    `- \`gh pr diff ${input.prUrl} -R ${input.repoFlag}\` 或 \`git -C ${input.worktree} diff origin/${input.base}...HEAD\` 看改动；需要时读工作树里的文件。`,
    "- 只读：不要修改、提交、推送工作树，不要在 PR 上评论、批准或合入。",
    "",
    "## 清单",
    "",
    "1. 改动是否做到原任务要求，有没有越出任务范围的改动。",
    "2. 正确性：边界条件、错误处理、并发与重启后的状态、旧数据兼容。",
    "3. 安全：凭据不进日志与输出、SQL 参数化、路径与外部输入校验、子进程环境。",
    "4. 测试：新增分支是否有测试覆盖，测试是否真的断言了行为；PR「端到端验证」一节要有在隔离实例里实跑的命令与输出，且输出符合期望（没有或对不上就打回）。",
    "5. 可维护性：是否符合仓库 AGENTS.md 的约定，有没有明显重复或无用代码。",
    "",
    "## 结论格式",
    "",
    "打回时先逐条写问题（文件:行、现象、怎么改），只写必须改的；小建议不打回。",
    "最后一行单独写 `审阅结论：通过` 或 `审阅结论：打回`；没按格式写，运行时会请你补答一次。",
    "",
  ].join("\n");
}
