import type { AdoptedEnd } from "./adopted-exit.ts";
import type { Verdict } from "./gates.ts";

/**
 * 执行者退出后怎么收尾（#262）：纯函数。输入停止原因、退出情况、关卡结论，
 * 输出状态机事件、投递的事件种类、原因，以及卡死时要不要重试。
 */

export type Stop =
  | { kind: "user"; by?: string }
  | { kind: "stalled"; reason: string }
  | { kind: "idle"; reason: string };

export type Exit =
  { code: number | null; signal: NodeJS.Signals | null } | "unknown";

export type ExitDecision = {
  event: "exit_ok" | "exit_fail" | "block";
  publish: "done" | "failed" | "blocked" | "ci_unavailable";
  reason?: string;
  /** 卡死后按档案重试一次。 */
  retry: boolean;
};

/** 接管后退出的执行者没有退出码（服务重启后按 pid 接管，或重启窗口内已经退出）。 */
export const ADOPTED_EXIT = "接管后退出，退出码不可得";

export function exitText(exit: Exit, adopted?: AdoptedEnd) {
  if (exit === "unknown")
    return adopted && adopted.end !== "unknown"
      ? `${ADOPTED_EXIT}；按日志判为${adopted.end === "clean" ? "正常结束" : "出错"}（${adopted.evidence}）`
      : ADOPTED_EXIT;
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
  /** 日志判出额度用尽时的受阻原因（#267）：不再过关卡，直接受阻。 */
  quota?: string;
  /** 从结构化日志识别出的异常结束（长度用尽、权限被拒、中途退出），写在失败与受阻原因前面。 */
  ending?: string;
  abnormalFatal?: boolean;
  /** 异常结束是思考耗尽单次输出：不判失败而转受阻，由调用方按 thinking.ts 换执行者重跑。 */
  thinking?: boolean;
  /** 从日志识别出的供应商或网络临时错误（transient.ts），同样写在原因前面；重试由调用方按 transient.ts 决定。 */
  transient?: string;
  /** 接管后退出时按日志收尾结构判出的结局（adopted-exit.ts）；只在 exit 为 unknown 时有意义。 */
  adopted?: AdoptedEnd;
}): ExitDecision {
  const { stop, exit } = input;
  const lead = (reason: string) =>
    [input.ending, input.transient, reason].filter(Boolean).join("；");
  if (!stop && input.quota)
    return {
      event: "block",
      publish: "blocked",
      reason: input.quota,
      retry: false,
    };
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
      reason: lead(
        ended.signal
          ? `执行者被信号 ${ended.signal} 结束`
          : `执行者退出码 ${ended.code}`,
      ),
      retry: false,
    };
  }
  if (exit === "unknown" && input.adopted?.end === "error")
    return {
      event: "exit_fail",
      publish: "failed",
      reason: lead(
        `${ADOPTED_EXIT}；日志显示出错结束：${input.adopted.evidence}`,
      ),
      retry: false,
    };
  // 日志判为正常结束的，与退出码 0 一样过关卡。
  if (
    input.abnormalFatal &&
    exit === "unknown" &&
    input.adopted?.end !== "clean"
  )
    return {
      event: "exit_fail",
      publish: "failed",
      reason: exitText(exit),
      retry: false,
    };
  if (input.abnormalFatal && input.ending)
    return input.thinking
      ? {
          event: "block",
          publish: "blocked",
          reason: input.ending,
          retry: false,
        }
      : {
          event: "exit_fail",
          publish: "failed",
          reason: input.ending,
          retry: false,
        };
  const verdict = input.verdict;
  if (!verdict) throw new Error("正常退出须先给出关卡结论");
  if (verdict.passed)
    return { event: "exit_ok", publish: "done", retry: false };
  const failed = verdict.failed
    .map((result) => `${result.gate}：${result.evidence}`)
    .join("；");
  const unavailable = verdict.failed.find((result) => result.unavailable);
  return {
    event: "block",
    publish: unavailable ? "ci_unavailable" : "blocked",
    reason: lead(
      unavailable
        ? `${unavailable.evidence}${
            verdict.failed.length > 1
              ? `；其余关卡不过：${verdict.failed
                  .filter((result) => result !== unavailable)
                  .map((result) => `${result.gate}：${result.evidence}`)
                  .join("；")}`
              : ""
          }`
        : verdict.awaitingCi
          ? `等 CI：${failed}`
          : `关卡不过：${failed}`,
    ),
    retry: false,
  };
}
