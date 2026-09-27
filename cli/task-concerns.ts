import type { ConcernState, InviteHint } from "../server/tasks/concern-gate.ts";

/** 任务请专员（#322 第 2 步）在命令行上的写法：请了谁、各自结论、要不要请的提示。 */

/** 一位专员这一轮的情况，一句人话。 */
export function concernState(c: ConcernState): string {
  if (c.verdict === "pass") return "通过";
  if (c.verdict === "veto") return `否决：${c.reason ?? ""}`;
  if (c.verdict === "none") return `没出结论：${c.reason ?? ""}`;
  if (!c.review) return "已请，交付后审";
  return c.review_status === "running" ? "审查中" : "等审查";
}

export const concernLabel = (c: ConcernState) =>
  `${c.name}（${c.ref}${c.review ? ` · ${c.review}` : ""}）`;

/** task show 的「请的专员」：每位一段，用分号隔开。 */
export const concernsText = (list: readonly ConcernState[] | undefined) =>
  list?.length
    ? list.map((c) => `${concernLabel(c)}：${concernState(c)}`).join("；")
    : null;

/** top 的子行：只写名字与结论，长原因看 task show。 */
export const concernsBrief = (list: readonly ConcernState[] | undefined) =>
  list?.length
    ? `专员：${list
        .map(
          (c) =>
            `${c.name} ${c.verdict === "pass" ? "通过" : c.verdict === "veto" ? "否决" : c.verdict === "none" ? "没出结论" : c.review ? (c.review_status === "running" ? `审查中 ${c.review}` : `等审查 ${c.review}`) : "已请"}`,
        )
        .join(" · ")}`
    : null;

/** 提示「要不要请某专员」：只提示，给出请的命令。 */
export function hintLines(
  task: { ref: string; concern_hints?: InviteHint[] },
  rerun = false,
): string[] {
  const hints = task.concern_hints ?? [];
  if (!hints.length) return [];
  return [
    ...hints.map(
      (h) => `提示：可能要请「${h.name}」专员（${h.matched.join("；")}）`,
    ),
    `要请：atrium task set ${task.ref} --concern ${hints.map((h) => h.ref).join(",")}${rerun ? `，再 atrium task run ${task.ref}` : ""}`,
  ];
}
