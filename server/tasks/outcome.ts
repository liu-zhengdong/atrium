import type { AdoptedEnd } from "./adopted-exit.ts";
import type { Verdict } from "./gates.ts";

/**
 * 执行者退出后怎么收尾（#262）：纯函数。输入停止原因、退出情况、关卡结论，
 * 输出状态机事件、投递的事件种类、原因，以及卡死时要不要重试。
 */

export type Stop =
  | { kind: "user"; by?: string }
  | { kind: "stalled"; reason: string }
  | { kind: "idle"; reason: string }
  /** 为送捎话停下、随后带着补充重派（#307 tell 兜底）；只有重派失败才会走到收尾。 */
  | { kind: "tell" }
  /** 被紧急任务抢占暂停（t215）：收尾时记下会话、转受阻，紧急通道清空后续上。 */
  | { kind: "preempt"; by: number; why: "exclusive" | "slot" }
  /** 紧急任务没有进展、换执行者（t215）：停下后由 to 在原工作树接着做。 */
  | { kind: "swap"; reason: string; to: string };

export type Exit =
  { code: number | null; signal: NodeJS.Signals | null } | "unknown";

export type ExitDecision = {
  event: "exit_ok" | "exit_fail" | "block";
  publish: "done" | "failed" | "blocked";
  reason?: string;
  /** 卡死后按档案重试一次。 */
  retry: boolean;
};

/** 接管后退出的执行者没有退出码（服务重启后按 pid 接管，或重启窗口内已经退出）。 */
export const ADOPTED_EXIT = "接管后退出，退出码不可得";

/** 接管后退出按日志判出的结局与依据；判不了为 undefined。 */
export function adoptedText(adopted?: AdoptedEnd) {
  if (!adopted || adopted.end === "unknown") return undefined;
  return `按日志判为${adopted.end === "clean" ? "正常结束" : "异常结束"}（${adopted.evidence}）`;
}

export function exitText(exit: Exit, adopted?: AdoptedEnd) {
  if (exit === "unknown") {
    const judged = adoptedText(adopted);
    return judged ? `${ADOPTED_EXIT}；${judged}` : ADOPTED_EXIT;
  }
  return exit.signal ? `被信号 ${exit.signal} 结束` : `退出码 ${exit.code}`;
}

/**
 * 退出情况写进事件 detail。接管后退出的带上判定依据（judged），`task show` 能看到怎么判的；
 * delivered 为远端已交付（PR 在、CI 过），日志判为异常也照常过关卡。
 */
export function exitDetail(
  exit: Exit,
  adopted?: AdoptedEnd,
  delivered = false,
): Record<string, unknown> {
  if (exit !== "unknown") return { code: exit.code, signal: exit.signal };
  if (!adopted) return { exit: "unknown" };
  const judged = adoptedText(adopted) ?? "日志判不出正常或异常结束";
  // judged 放前面：task show 把事件 detail 截到 80 列。
  return {
    judged:
      delivered && adopted.end === "error"
        ? `${judged}；PR 在且 CI 通过，照常过关卡`
        : judged,
    exit: "unknown",
  };
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
  if (stop?.kind === "tell")
    return {
      event: "exit_fail",
      publish: "failed",
      reason: "为送捎话停下后重派失败",
      retry: false,
    };
  // 抢占与换人在收尾前由运行时接手；走到这里说明接手出错，按受阻留给人看。
  if (stop?.kind === "preempt")
    return {
      event: "block",
      publish: "blocked",
      reason: `被紧急任务 t${stop.by} 抢占暂停`,
      retry: false,
    };
  if (stop?.kind === "swap")
    return {
      event: "block",
      publish: "blocked",
      reason: stop.reason,
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
  return {
    event: "block",
    publish: "blocked",
    reason: lead(`关卡不过：${failed}`),
    retry: false,
  };
}
