/**
 * 任务请专员（#322 第 2 步）的判定：纯函数，不碰数据库与进程。
 * - 审查结论：专员审查任务的摘要里最后一行「结论：通过」或「结论：否决：原因」；
 * - 专员关卡：各专员的结论合成父任务的去向（全部通过才补判通过，任一否决即卡住并写原因）；
 * - 提示：按关注点章程 `invite_when` 的规则对照改动范围，提示「要不要请某专员」，只提示不自动请；
 * - 提示词：派活时附的「请了的专员与检查要点」、专员审查任务的详述。
 */

export type Verdict = "pass" | "veto" | "none";

/** 一位被请专员在本轮的情况；review_status 为审查任务当前状态，没派出审查任务时为 null。 */
export type ConcernState = {
  ref: string;
  name: string;
  review: string | null;
  review_status: string | null;
  verdict: Verdict | null;
  reason: string | null;
};

export type ReviewConclusion = { verdict: Verdict; reason: string };

const VERDICT_RE =
  /^[\s>*#-]*(?:\*\*)?结论(?:\*\*)?\s*[:：]\s*(?:\*\*)?(通过|否决|不通过)(?:\*\*)?\s*(?:[:：，,。;；-]\s*)?(.*)$/;

/** 从审查摘要取结论：以最后一行「结论：…」为准；没写结论判 none（审查没出结论，不当通过）。 */
export function parseReviewConclusion(summary: string): ReviewConclusion {
  let found: ReviewConclusion | undefined;
  for (const line of summary.split("\n")) {
    const match = VERDICT_RE.exec(line.trim());
    if (!match) continue;
    const reason = match[2]!.trim().replace(/\*\*$/, "").trim();
    found =
      match[1] === "通过"
        ? { verdict: "pass", reason: reason || "按清单审过，没有越过底线" }
        : {
            verdict: "veto",
            reason: reason || "专员否决，没写原因（看审查任务的摘要）",
          };
  }
  return (
    found ?? {
      verdict: "none",
      reason: "审查摘要里没有「结论：通过」或「结论：否决：原因」",
    }
  );
}

/** 审查任务不再跑时的结论：完成的读摘要，失败、取消、受阻的判没出结论。 */
export function reviewConclusion(
  status: string,
  result: string | null,
  reason?: string | null,
): ReviewConclusion | null {
  if (status === "done") return parseReviewConclusion(result ?? "");
  if (status === "failed" || status === "cancelled" || status === "blocked")
    return {
      verdict: "none",
      reason: `审查任务${status === "failed" ? "失败" : status === "cancelled" ? "已取消" : "受阻"}${reason ? `：${reason}` : ""}`,
    };
  return null;
}

export type ConcernOutcome =
  | { kind: "none" }
  | { kind: "waiting"; reason: string }
  | { kind: "passed"; reason: string }
  | { kind: "vetoed"; reason: string }
  | { kind: "incomplete"; reason: string };

const label = (c: ConcernState) =>
  `${c.name}（${c.ref}${c.review ? ` · ${c.review}` : ""}）`;

/** 合成专员关卡：还有没出结论的就等；都出了结论后任一否决即否决，任一没出结论即卡住，全部通过才通过。 */
export function concernOutcome(list: readonly ConcernState[]): ConcernOutcome {
  if (!list.length) return { kind: "none" };
  const waiting = list.filter((c) => c.verdict === null);
  if (waiting.length)
    return {
      kind: "waiting",
      reason: `等专员审查：${waiting.map(label).join("、")}`,
    };
  const vetoed = list.filter((c) => c.verdict === "veto");
  const missing = list.filter((c) => c.verdict === "none");
  if (vetoed.length)
    return {
      kind: "vetoed",
      reason: `专员否决：${vetoed.map((c) => `${label(c)}：${c.reason}`).join("；")}${
        missing.length
          ? `；另有没出结论的：${missing.map(label).join("、")}`
          : ""
      }`,
    };
  if (missing.length)
    return {
      kind: "incomplete",
      reason: `专员审查没出结论：${missing.map((c) => `${label(c)}：${c.reason}`).join("；")}；重跑审查任务或人工判定`,
    };
  return {
    kind: "passed",
    reason: `专员审查通过：${list.map(label).join("、")}`,
  };
}

/** 父任务在关卡通过后要不要等专员：请了专员才等。 */
export const needsReview = (invited: number) => invited > 0;

// ---- 提示「要不要请某专员」 ----

export type InviteRule = { ref: string; name: string; when: string[] };
export type InviteHint = { ref: string; name: string; matched: string[] };

/** 规则里带 `/`、`*`、`?` 或以 `.` 开头的当路径通配（对照改动的文件），其余当关键词（对照标题、详述与文件路径，不分大小写）。 */
export const isPathRule = (rule: string) => /[/*?]|^\./.test(rule);

/** 路径通配转正则：`**` 跨目录、`*` 不跨目录、`?` 单字符；不带 `/` 的规则按文件名或任一段匹配。 */
export function globRegex(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*" && glob[i + 1] === "*") {
      source += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (ch === "*") source += "[^/]*";
    else if (ch === "?") source += "[^/]";
    else source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(glob.includes("/") ? `^${source}$` : `(?:^|/)${source}$`);
}

/**
 * 按规则提示：没请的专员里，改动文件命中路径通配、或标题详述与文件路径含关键词的，给出命中了什么。
 * 每位专员至多列 3 条命中，整体按规则顺序；已请的不提示。
 */
export function inviteHints(
  rules: readonly InviteRule[],
  input: { files?: readonly string[]; text?: string },
  invited: ReadonlySet<string>,
): InviteHint[] {
  const files = input.files ?? [];
  const text = (input.text ?? "").toLowerCase();
  const hints: InviteHint[] = [];
  for (const rule of rules) {
    if (invited.has(rule.ref)) continue;
    const matched: string[] = [];
    for (const when of rule.when) {
      const entry = when.trim();
      if (!entry) continue;
      if (isPathRule(entry)) {
        const re = globRegex(entry);
        const file = files.find((f) => re.test(f));
        if (file) matched.push(`${file} 命中 ${entry}`);
      } else {
        const word = entry.toLowerCase();
        const file = files.find((f) => f.toLowerCase().includes(word));
        if (text.includes(word)) matched.push(`提到「${entry}」`);
        else if (file) matched.push(`${file} 含「${entry}」`);
      }
      if (matched.length >= 3) break;
    }
    if (matched.length) hints.push({ ref: rule.ref, name: rule.name, matched });
  }
  return hints;
}

export const hintText = (hint: InviteHint) =>
  `${hint.name}（${hint.ref}）：${hint.matched.join("；")}`;

// ---- 提示词 ----

export type Checklist = {
  ref: string;
  name: string;
  goal: string;
  points: { ref: string; text: string; why: string }[];
  bottom: string[];
};

const CHECKLIST_MAX = 3000;
const clip = (text: string, max: number) =>
  Array.from(text).length > max
    ? `${Array.from(text)
        .slice(0, max - 1)
        .join("")}…`
    : text;

function checklistLines(c: Checklist): string[] {
  return [
    `### ${c.name}（${c.ref}）${c.goal ? `——${c.goal}` : ""}`,
    ...(c.points.length
      ? [
          "检查要点：",
          ...c.points.map((p) => `- ${p.text}（${p.ref}；为什么：${p.why}）`),
        ]
      : ["检查要点：未写，按专员章程目标审"]),
    ...(c.bottom.length
      ? ["底线（越过即否决）：", ...c.bottom.map((b) => `- ${b}`)]
      : []),
  ];
}

/** 派活时附给执行者：请了哪些专员、各自的检查要点与底线；整段不超过 3000 字。 */
export function concernSection(list: readonly Checklist[]): string | undefined {
  if (!list.length) return undefined;
  const text = [
    "这个任务请了下列专员。开工前按他们的要点自查；交付后运行时会请他们逐条审一遍，越过底线会被否决、任务转卡住。",
    "",
    ...list.flatMap((c) => [...checklistLines(c), ""]),
  ]
    .join("\n")
    .trim();
  return clip(text, CHECKLIST_MAX);
}

export type ReviewBriefInput = {
  checklist: Checklist;
  task: { ref: string; title: string };
  pr_url: string | null;
  worktree: string | null;
  branch: string | null;
  base: string | null;
  diff?: { files: number; added: number; removed: number; list: string[] };
};

/** 专员审查任务的详述：审什么（PR、分支、改动）、按什么审（清单与底线）、怎么交结论。 */
export function reviewBrief(input: ReviewBriefInput): string {
  const { checklist: c, task } = input;
  const range = input.base ? `origin/${input.base}...HEAD` : "HEAD";
  return [
    `# 专员审查：${c.name} · ${task.ref} ${task.title}`,
    "",
    `你是「${c.name}」专员，被请来审 ${task.ref} 的交付。只审不改：不要提交、推送、改分支或评论 PR。`,
    "",
    "## 审什么",
    "",
    ...(input.pr_url ? [`- PR：${input.pr_url}`] : ["- 没有 PR"]),
    ...(input.worktree
      ? [
          `- 工作树：${input.worktree}${input.branch ? `（分支 ${input.branch}）` : ""}`,
          `- 改动：\`git -C ${input.worktree} diff ${range}\``,
        ]
      : []),
    ...(input.diff
      ? [
          `- 规模：${input.diff.files} 个文件，+${input.diff.added} −${input.diff.removed}`,
          ...input.diff.list.slice(0, 30).map((f) => `  - ${f}`),
          ...(input.diff.list.length > 30
            ? [`  - …另有 ${input.diff.list.length - 30} 个`]
            : []),
        ]
      : []),
    "",
    "## 按什么审",
    "",
    ...checklistLines(c),
    "",
    "## 怎么交结论",
    "",
    "逐条写：要点 → 看了哪里（文件与行）→ 结论。证据来自你刚看过的代码或命令输出，不采信执行者自述。",
    "回复的最后一行只写结论，二选一：",
    "- `结论：通过`（可在后面加一句说明）",
    "- `结论：否决：<越过了哪条底线或要点、在哪里>`",
    "只有越过底线或明确违反要点才否决；改进建议写在正文，不影响通过。",
    "",
  ].join("\n");
}
