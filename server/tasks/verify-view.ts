import type { Verdict, VerifyStep } from "./verify.ts";

/**
 * 上线验证状态怎么显示（t182，纯函数）：看板、状态栏、task show 与事件里的现象一行。
 * 命令行静态引入，这里不引执行者档案等重模块。
 */

/** 一步现象说成一行：命令 · 期望 · 实际。 */
export function phenomenonLine(step: Partial<VerifyStep>): string {
  const mark =
    step.matched === false
      ? "不符合"
      : step.matched === true
        ? "符合"
        : "无法验证";
  return [
    `[${mark}] ${step.command || "（没写命令）"}`,
    step.expected ? `期望 ${step.expected}` : "",
    step.output ? `实际 ${step.output}` : "",
  ]
    .filter(Boolean)
    .map((part) => part.replace(/\s+/g, " "))
    .join(" · ");
}

/** 原任务的验证状态：验证中、通过、没通过、无法验证。 */
export type VerifyState = "running" | Verdict;
export const VERIFY_STATE_TEXT: Record<VerifyState, string> = {
  running: "验证中",
  passed: "验证通过",
  failed: "验证没过",
  unverifiable: "无法验证",
};

export type VerifyView = {
  state: VerifyState;
  /** 验证任务短号。 */
  verifier: string;
  /** 验证执行者（在跑或跑过的）；还没派出去为 null。 */
  worker: string | null;
  started_at: number | null;
  summary: string | null;
  decided_at: number | null;
  /** 没通过、无法验证的事件投给了谁；没投（通过、旧记录）为 null。 */
  handler: string | null;
  /** 那条事件还没确认（负责人还没处理完）。 */
  pending: boolean;
};

/** 看板状态列：「已上线 · 验证没过」。 */
export const verifyStateText = (view: Pick<VerifyView, "state">) =>
  `已上线 · ${VERIFY_STATE_TEXT[view.state]}`;

/** 看板最近动作列：验证中说谁在跑，没通过说原因与交给了谁。 */
export function verifyActionText(view: VerifyView): string {
  if (view.state === "running")
    return `${view.verifier}${view.worker ? ` ${view.worker}` : ""} 在照 PR 的端到端验证跑`;
  if (view.state === "passed") return `${view.verifier} 照着跑通`;
  const who = view.handler
    ? view.pending
      ? `等 ${view.handler} 处理`
      : `${view.handler} 已看过`
    : "";
  return [view.summary ?? "", who].filter(Boolean).join(" · ");
}

/**
 * 已结束任务在验证上的持球人（纯函数）：验证中是验证执行者；没通过、无法验证且事件还没处理完的是收到事件的
 * leader 或秘书；其余（通过、已处理）没有。
 */
export function verifyHolder(view: VerifyView | null): {
  kind: "worker" | "leader" | "secretary" | "user";
  who: string | null;
  text: string;
} | null {
  if (!view) return null;
  if (view.state === "running")
    return {
      kind: "worker",
      who: view.worker,
      text: `验证中 · ${view.verifier}${view.worker ? ` ${view.worker}` : ""} 在跑`,
    };
  if (view.state === "passed" || !view.pending || !view.handler) return null;
  return {
    kind: /^a[1-9][0-9]*$/.test(view.handler)
      ? "leader"
      : /^u[1-9][0-9]*$/.test(view.handler)
        ? "user"
        : "secretary",
    who: view.handler,
    text: `${VERIFY_STATE_TEXT[view.state]} · 等 ${view.handler} 处理`,
  };
}
