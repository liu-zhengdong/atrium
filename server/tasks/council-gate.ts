import type { Checklist } from "./concern-gate.ts";

/**
 * 会审（#322 第 3 步）的判定：纯函数，不碰数据库与进程。
 * - 专员意见：意见任务摘要的最后一行「意见：同意／有条件同意：条件／反对：原因／否决：越过的底线」；
 * - 进度：专员意见都不再跑才交 leader 汇总；
 * - 汇总：leader 的摘要里「一致」「冲突」两段、「需用户拍板：…」行与最后一行「结论：…」；
 * - 结局：leader 标了需用户拍板、没写结论、或有专员以底线否决而 leader 没上交的，一律上交用户；其余由 leader 定。
 * - 提示词：专员意见任务与 leader 汇总任务的详述。
 */

export type Stance = "agree" | "conditional" | "oppose" | "veto" | "none";

export const STANCE_LABEL: Record<Stance, string> = {
  agree: "同意",
  conditional: "有条件同意",
  oppose: "反对",
  veto: "否决",
  none: "没出意见",
};

export type Opinion = { stance: Stance; reason: string };

const OPINION_RE =
  /^[\s>*#-]*(?:\*\*)?意见(?:\*\*)?\s*[:：]\s*(?:\*\*)?(同意|有条件同意|有条件|反对|否决)(?:\*\*)?\s*(?:[:：，,。;；-]\s*)?(.*)$/;

/** 从意见摘要取立场：以最后一行「意见：…」为准；没写判 none（没出意见，不当同意）。 */
export function parseOpinion(summary: string): Opinion {
  let found: Opinion | undefined;
  for (const line of summary.split("\n")) {
    const match = OPINION_RE.exec(line.trim());
    if (!match) continue;
    const reason = match[2]!.trim().replace(/\*\*$/, "").trim();
    const word = match[1]!;
    found =
      word === "同意"
        ? { stance: "agree", reason }
        : word === "反对"
          ? { stance: "oppose", reason: reason || "没写原因（看意见正文）" }
          : word === "否决"
            ? { stance: "veto", reason: reason || "没写越过哪条底线" }
            : { stance: "conditional", reason: reason || "没写条件" };
  }
  return (
    found ?? {
      stance: "none",
      reason: "意见摘要里没有「意见：同意／有条件同意／反对／否决」",
    }
  );
}

/** 意见任务不再跑时的立场：完成的读摘要，失败、取消、受阻的判没出意见；还在跑为 null。 */
export function opinionOf(
  status: string,
  result: string | null,
  reason?: string | null,
): Opinion | null {
  if (status === "done") return parseOpinion(result ?? "");
  if (status === "failed" || status === "cancelled" || status === "blocked")
    return {
      stance: "none",
      reason: `意见任务${status === "failed" ? "失败" : status === "cancelled" ? "已取消" : "受阻"}${reason ? `：${reason}` : ""}`,
    };
  return null;
}

/** 专员意见都不再跑（且不在拉起、收尾、排队）才交 leader 汇总。 */
export function opinionsReady(
  members: readonly { status: string; busy: boolean }[],
): boolean {
  return (
    members.length > 0 &&
    members.every(
      (m) =>
        !m.busy &&
        (m.status === "done" ||
          m.status === "failed" ||
          m.status === "cancelled" ||
          m.status === "blocked"),
    )
  );
}

export type Summary = {
  agreed: string[];
  conflicts: string[];
  escalate: string[];
  conclusion: string | null;
};

const CONCLUSION_RE =
  /^[\s>*#-]*(?:\*\*)?结论(?:\*\*)?\s*[:：]\s*(?:\*\*)?(.*?)(?:\*\*)?\s*$/;
const ESCALATE_RE =
  /^[\s>*#-]*(?:\*\*)?需用户拍板(?:\*\*)?\s*[:：]\s*(?:\*\*)?(.*?)(?:\*\*)?\s*$/;
const HEADING_RE = /^#{1,6}\s*(.+?)\s*$/;
const NONE_RE = /^(无|没有|暂无|不需要|none|-)?[。.]?$/i;

/** 从 leader 汇总取一致、冲突、需用户拍板与结论；结论以最后一行「结论：」为准，「需用户拍板：无」不算。 */
export function parseSummary(text: string): Summary {
  const summary: Summary = {
    agreed: [],
    conflicts: [],
    escalate: [],
    conclusion: null,
  };
  let section: "agreed" | "conflicts" | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const name = heading[1]!.replace(/[:：]$/, "");
      section = /^一致/.test(name)
        ? "agreed"
        : /^(冲突|分歧)/.test(name)
          ? "conflicts"
          : null;
      continue;
    }
    const escalate = ESCALATE_RE.exec(line);
    if (escalate) {
      const item = escalate[1]!.trim();
      if (!NONE_RE.test(item)) summary.escalate.push(item);
      continue;
    }
    const conclusion = CONCLUSION_RE.exec(line);
    if (conclusion) {
      const value = conclusion[1]!.trim();
      if (value) summary.conclusion = value;
      continue;
    }
    if (section && /^[-*]\s+/.test(line)) {
      const item = line.replace(/^[-*]\s+/, "").trim();
      if (item && !NONE_RE.test(item)) summary[section].push(item);
    }
  }
  return summary;
}

export type MemberOpinion = {
  ref: string;
  name: string;
  task: string;
  stance: Stance;
  reason: string;
};

export type CouncilOutcome = {
  kind: "decided" | "escalated";
  conclusion: string | null;
  escalate: string[];
};

/**
 * 合成会审结局：leader 标的需用户拍板原样上交；没写结论、专员都没出意见、有专员以底线否决而 leader 没上交的，
 * 由运行时补一条上交理由（专员否决不能由 leader 自行推翻）。
 */
export function councilOutcome(
  summary: Summary,
  opinions: readonly MemberOpinion[],
): CouncilOutcome {
  const escalate = [...summary.escalate];
  if (!summary.conclusion) escalate.push("leader 汇总没写「结论：」，请上层定");
  if (opinions.length && opinions.every((o) => o.stance === "none"))
    escalate.push("受邀专员都没出意见，结论缺依据");
  if (!summary.escalate.length)
    for (const o of opinions.filter((o) => o.stance === "veto"))
      escalate.push(
        `${o.name}（${o.ref} · ${o.task}）以底线否决：${o.reason}；专员否决不能由 leader 自行推翻`,
      );
  return {
    kind: escalate.length ? "escalated" : "decided",
    conclusion: summary.conclusion,
    escalate,
  };
}

// ---- 提示词 ----

const clip = (text: string, max: number) =>
  Array.from(text).length > max
    ? `${Array.from(text)
        .slice(0, max - 1)
        .join("")}…`
    : text;

const TOPIC_MAX = 16_000;
const OPINION_MAX = 4_000;

export type Topic = {
  ref: string;
  topic: string;
  brief: string | null;
  brief_path: string | null;
  issue: number | null;
  repo: string | null;
  leader: string;
  concerns: readonly { ref: string; name: string }[];
};

function topicLines(topic: Topic): string[] {
  return [
    `- 议题：${topic.topic}（会审 ${topic.ref}）`,
    ...(topic.issue ? [`- 关联 issue：#${topic.issue}`] : []),
    ...(topic.repo ? [`- 仓库（只读参考）：${topic.repo}`] : []),
    `- 受邀专员：${topic.concerns.map((c) => `${c.name}（${c.ref}）`).join("、")}`,
    `- 汇总与拍板：${topic.leader}`,
    "",
    ...(topic.brief
      ? [
          `### 议题详述${topic.brief_path ? `（${topic.brief_path}）` : ""}`,
          "",
          clip(topic.brief.trim(), TOPIC_MAX),
        ]
      : ["（没有附议题详述，按议题标题与关联 issue 判断）"]),
  ];
}

function checklistLines(c: Checklist): string[] {
  return [
    `### ${c.name}（${c.ref}）${c.goal ? `——${c.goal}` : ""}`,
    ...(c.points.length
      ? [
          "检查要点：",
          ...c.points.map((p) => `- ${p.text}（${p.ref}；为什么：${p.why}）`),
        ]
      : ["检查要点：未写，按专员章程目标看"]),
    ...(c.bottom.length
      ? ["底线（越过即可否决）：", ...c.bottom.map((b) => `- ${b}`)]
      : []),
  ];
}

/** 专员意见任务的详述：议题、按什么看（清单与底线）、怎么交意见。 */
export function opinionBrief(topic: Topic, checklist: Checklist): string {
  return [
    `# 会审意见：${checklist.name} · ${topic.topic}`,
    "",
    `你是「${checklist.name}」专员，被请来参加会审 ${topic.ref}，和其他专员各自独立、并行出意见，之后由${topic.leader}汇总。`,
    "只出意见不动手：不要改文件、提交、推送、开 PR，也不要在 issue 或 PR 上评论。",
    "",
    "## 议题",
    "",
    ...topicLines(topic),
    "",
    "## 按什么看",
    "",
    ...checklistLines(checklist),
    "",
    "## 怎么交意见",
    "",
    "从你这位专员的角度逐条写：看到的风险或好处 → 依据（看了哪里、哪条要点或底线）→ 建议。证据来自你刚看过的材料或命令输出，不凭印象。",
    "回复的最后一行只写立场，四选一：",
    "- `意见：同意`（可在后面加一句说明）",
    "- `意见：有条件同意：<条件>`",
    "- `意见：反对：<原因>`",
    "- `意见：否决：<越过了哪条底线>`（只有越过底线才用；否决须上交用户，leader 不能自行推翻）",
    "",
  ].join("\n");
}

export type OpinionEntry = MemberOpinion & { text: string | null };

/** leader 汇总任务的详述：议题、各方意见原文、汇总规则与交付格式。 */
export function summaryBrief(
  topic: Topic,
  opinions: readonly OpinionEntry[],
  comment: boolean,
): string {
  return [
    `# 会审汇总：${topic.topic}`,
    "",
    `你代${topic.leader}主持会审 ${topic.ref}：受邀专员已各自出了意见（原文在下面），请汇总一致与冲突，能定的自己定。`,
    "只汇总与拍板，不动手实现：不要改文件、提交、推送或开 PR。",
    "",
    "## 议题",
    "",
    ...topicLines(topic),
    "",
    "## 各方意见",
    "",
    ...opinions.flatMap((o) => [
      `### ${o.name}（${o.ref} · ${o.task}）：${STANCE_LABEL[o.stance]}${o.reason ? `——${o.reason}` : ""}`,
      "",
      o.text?.trim() ? clip(o.text.trim(), OPINION_MAX) : "（没有意见原文）",
      "",
    ]),
    "## 怎么汇总",
    "",
    "- 一致：各方都认可的做法或风险。",
    "- 冲突：专员之间意见不同的地方，写清各方主张；能按组织目标与要点定的，给出取舍和理由。",
    "- 只有两类事上交用户：碰到用户定的边界（硬边界、预算、对外公开、不可撤回的数据操作等），或专员之间谈不拢、你也定不了。每条写一行 `需用户拍板：<要用户定什么、有哪几个选项、各自代价>`。",
    "- 有专员以底线否决的，不能自行推翻：要么按否决调整结论，要么写 `需用户拍板：`。",
    "- 没出意见的专员，在冲突或结论里说明缺了谁、影响多大。",
    ...(comment
      ? [
          `- 把汇总（一致、冲突、需用户拍板、结论）作为一条评论发到 issue #${topic.issue}（gh 命令带 -R 指向该仓库），并在回复里附评论链接。`,
        ]
      : []),
    "",
    "回复格式：",
    "",
    "```",
    "## 一致",
    "- …",
    "## 冲突",
    "- …（各方主张；你的取舍与理由）",
    "需用户拍板：…（每条一行；没有就不写这一行）",
    "结论：<一句话，后续任务照此执行>",
    "```",
    "",
    "最后一行必须是「结论：…」。",
    "",
  ].join("\n");
}
