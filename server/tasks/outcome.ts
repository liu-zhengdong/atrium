import type { Verdict } from "./gates.ts";

/**
 * 执行者退出后怎么收尾（#262）：纯函数。输入停止原因、退出情况、关卡结论，
 * 输出状态机事件、投递的事件种类、原因，以及卡死时要不要重试。
 */

export type Stop =
  | { kind: "user" }
  | { kind: "stalled"; reason: string }
  | { kind: "idle"; reason: string };

export type Exit =
  { code: number | null; signal: NodeJS.Signals | null } | "unknown";

export type ExitDecision = {
  event: "exit_ok" | "exit_fail" | "block";
  publish: "done" | "failed" | "blocked";
  reason?: string;
  /** 卡死后按档案重试一次。 */
  retry: boolean;
};

export function exitText(exit: Exit) {
  if (exit === "unknown") return "退出码未知（服务重启期间退出）";
  return exit.signal ? `被信号 ${exit.signal} 结束` : `退出码 ${exit.code}`;
}

export function exitDetail(exit: Exit): Record<string, unknown> {
  return exit === "unknown"
    ? { exit: "unknown" }
    : { code: exit.code, signal: exit.signal };
}

/** 被停下的（人工、卡死、空闲）不查事实；其余都要查事实。 */
export const needsFacts = (stop: Stop | undefined) => stop === undefined;

/** 非 0 退出直接失败，事实照样记下；0 或未知退出才过关卡。 */
export const needsGates = (stop: Stop | undefined, exit: Exit) =>
  stop === undefined &&
  (exit === "unknown" || (exit.code === 0 && exit.signal === null));

export function decideExit(input: {
  stop?: Stop;
  exit: Exit;
  retried: boolean;
  retryAllowed: boolean;
  verdict?: Verdict;
}): ExitDecision {
  const { stop, exit } = input;
  if (stop?.kind === "user")
    return {
      event: "exit_fail",
      publish: "failed",
      reason: "人工停止",
      retry: false,
    };
  if (stop?.kind === "stalled")
    return {
      event: "exit_fail",
      publish: "failed",
      reason: stop.reason,
      retry: !input.retried && input.retryAllowed,
    };
  if (stop?.kind === "idle")
    return {
      event: "block",
      publish: "blocked",
      reason: stop.reason,
      retry: false,
    };
  if (!needsGates(stop, exit)) {
    const ended = exit as { code: number | null; signal: string | null };
    return {
      event: "exit_fail",
      publish: "failed",
      reason: ended.signal
        ? `执行者被信号 ${ended.signal} 结束`
        : `执行者退出码 ${ended.code}`,
      retry: false,
    };
  }
  const verdict = input.verdict;
  if (!verdict) throw new Error("正常退出须先给出关卡结论");
  if (verdict.passed)
    return { event: "exit_ok", publish: "done", retry: false };
  const failed = verdict.failed
    .map((result) => `${result.gate}：${result.evidence}`)
    .join("；");
  return {
    event: "block",
    publish: "blocked",
    reason: verdict.awaitingCi ? `等 CI：${failed}` : `关卡不过：${failed}`,
    retry: false,
  };
}
