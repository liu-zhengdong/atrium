import type { Overview, Stage } from "../server/org/overview.ts";
import { STAGE_LABEL } from "../server/org/overview.ts";
import type { Point } from "../server/org/points.ts";

/**
 * `org show` 的人话段（#322）：是什么 → 能用它做什么 → 一件事怎么走完 → 由哪几部分组成 → 要点 → 现在做到哪、接下来。
 * 没写的项标「未写」，一项都没写时只给一行怎么补。技术细节不在这里，由 `--detail` 另外展开。
 */

const counts = (t: {
  todo: number;
  running: number;
  blocked: number;
  reviewing?: number;
  merge_queued?: number;
  merging?: number;
}) =>
  [
    t.running ? `在做 ${t.running}` : "",
    t.reviewing ? `审阅中 ${t.reviewing}` : "",
    t.merge_queued ? `排队合入 ${t.merge_queued}` : "",
    t.merging ? `合入中 ${t.merging}` : "",
    t.blocked ? `卡住 ${t.blocked}` : "",
    t.todo ? `待办 ${t.todo}` : "",
  ]
    .filter(Boolean)
    .map((p) => ` · ${p}`)
    .join("");

/** 节点标题：人话名在前，原名与类比跟在后面。 */
export function titleOf(
  node: { ref: string; name: string },
  overview: Pick<Overview, "alias" | "analogy">,
): string {
  const alias = overview.alias && overview.alias !== node.name;
  return `${node.ref} ${alias ? `${overview.alias}（${node.name}）` : node.name}${overview.analogy ? `——${overview.analogy}` : ""}`;
}

export const isBlank = (o: Overview) =>
  !o.what &&
  !o.uses.length &&
  !o.flow.length &&
  !o.now &&
  !o.next &&
  !o.stages.length &&
  !o.parts.some((p) => p.alias || p.analogy);

export function stageLine(stage: Stage): string {
  return `${stage.id} [${STAGE_LABEL[stage.status]}] ${stage.result}`;
}

function stageDetail(stage: Stage): string[] {
  const lines = [
    ...(stage.parent ? [`上级：${stage.parent}`] : []),
    ...(stage.after?.length ? [`前置：${stage.after.join("、")}`] : []),
    ...(stage.due ? [`截止：${stage.due}`] : []),
    ...(stage.repo ? [`仓库：${stage.repo}`] : []),
    ...(stage.criteria ?? []).map((c, i) => `验收 ${i + 1}：${c}`),
    ...(stage.evidence ?? []).map((e) => `证据：${e}`),
    ...(stage.note ? [`说明：${stage.note}`] : []),
  ];
  return lines.map((line) => `      ${line.split("\n").join("\n      ")}`);
}

/** 要点：人话一句在前，为什么、谁定的、守护它的检查缩进在下一行。 */
export function pointLines(points: readonly Point[]): string[] {
  if (!points.length) return [];
  return [
    "要点（必须守住）：",
    ...points.flatMap((p) => [
      `  ${p.ref} ${p.text}${p.applies?.length ? `（适用于 ${p.applies.join("、")}）` : ""}`,
      `     为什么：${p.why} · ${p.by} 定${p.check ? ` · 检查：${p.check}` : ""}`,
    ]),
  ];
}

export function formatOverview(
  node: { ref: string; name: string },
  overview: Overview,
  detail = false,
  points: readonly Point[] = [],
): string[] {
  if (isBlank(overview))
    return [
      `人话介绍还没写（是什么、能做什么、怎么走完、由哪几部分组成、现状）：atrium org show ${node.ref} --raw > 章程.md，补上 what、uses、flow、alias、analogy、now、next 后 atrium org edit ${node.ref} --charter 章程.md --reason 原因`,
      ...partLines(overview, detail),
      ...pointLines(points),
    ];
  const none = "（未写）";
  const stages = overview.stages;
  const tally = Object.entries(
    stages.reduce<Record<string, number>>((sum, s) => {
      sum[STAGE_LABEL[s.status]] = (sum[STAGE_LABEL[s.status]] ?? 0) + 1;
      return sum;
    }, {}),
  )
    .map(([label, n]) => `${label} ${n}`)
    .join(" · ");
  return [
    `是什么：${overview.what ? `${overview.what}${overview.what_from_goal ? "（取自章程目标）" : ""}` : none}`,
    ...(overview.uses.length
      ? ["能用它做什么：", ...overview.uses.map((u) => `  · ${u}`)]
      : [`能用它做什么：${none}`]),
    ...(overview.flow.length
      ? [
          "一件事怎么走完：",
          ...overview.flow.map((step, i) => `  ${i + 1}. ${step}`),
        ]
      : [`一件事怎么走完：${none}`]),
    ...partLines(overview, detail),
    ...pointLines(points),
    `现在做到哪：${overview.now || none}`,
    `接下来：${overview.next || none}`,
    ...(stages.length
      ? [
          `阶段（${tally}）：`,
          ...stages.flatMap((s) => [
            `  ${stageLine(s)}`,
            ...(detail ? stageDetail(s) : []),
          ]),
        ]
      : []),
  ];
}

function partLines(overview: Overview, detail: boolean): string[] {
  const parts = overview.parts.filter((p) => detail || !p.archived);
  if (!parts.length) return ["由哪几部分组成：没有下一层"];
  return [
    "由哪几部分组成：",
    ...parts.map(
      (p) =>
        `  ${titleOf(p, p)}${counts(p.tasks)}${p.archived ? " · 已归档" : ""}`,
    ),
  ];
}
