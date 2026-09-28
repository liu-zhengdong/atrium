/**
 * 持球与期限：所有「卡住／没进展／没人管」收成一条规则。
 *
 * 每件没结束的事都有持球人（holder.ts 算出是谁、从什么时候起）；下面这张表给每类持球人一个时限与到期动作。
 * 到期先叫醒持球人，再过一个时限还没动就上交上一层（leader → 秘书 → 推给用户）。
 * 统一发一种事件 `overdue`（带持球人、已挂多久、下一步），状态栏与 top 用同一种显示（`heldText`）。
 * 纯函数；巡检在 `overdue-runtime.ts`（leader、发版）、`executors.ts` 的看门狗（执行者）、
 * `check-quiet-watch.ts`（检查）、`secretary-fallback.ts`（秘书）。
 */

const MINUTE = 60_000;

export type DueKind =
  "starting" | "worker" | "check" | "release" | "leader" | "secretary";

export type Due = {
  /** 谁在持球（人话）。 */
  who: string;
  /** 从球到手（执行者、检查是最近一次进展或输出）起，多久算到期。 */
  ms: number;
  /** 到期先做什么。 */
  wake: string;
  /** 叫醒后再过 ms 仍没动，上交给谁；运行时自己处理完就不再上交的为 null。 */
  escalate: string | null;
};

/** 持球人类型 → 时限与到期动作。时限只在这里定。 */
export const DUE: Record<DueKind, Due> = {
  starting: {
    who: "执行者（启动）",
    ms: 3 * MINUTE,
    wake: "判卡死，结束进程树，重试一次；再卡住转失败",
    escalate: null,
  },
  worker: {
    who: "执行者",
    ms: 20 * MINUTE,
    wake: "判卡死，结束进程树，转受阻交负责人",
    escalate: null,
  },
  check: {
    who: "检查",
    ms: 10 * MINUTE,
    wake: "结束检查：已查出失败用例的按没过交回执行者，没有的按没跑成重跑",
    escalate: null,
  },
  release: {
    who: "发版",
    ms: 30 * MINUTE,
    wake: "告诉负责人去看仓库的发版工作流",
    escalate: null,
  },
  leader: {
    who: "leader",
    ms: 30 * MINUTE,
    wake: "再叫醒 leader 一次",
    escalate: "上一层（上级 leader 或秘书）",
  },
  secretary: {
    who: "秘书",
    ms: 3 * MINUTE,
    wake: "后台叫醒秘书处理",
    escalate: "推给用户",
  },
};

export type DueStep = "none" | "wake" | "escalate";

/**
 * 这一刻该做什么：没到期 none；到期且这一段还没叫醒过 wake；叫醒后又过了一个时限、有上一层的 escalate。
 * wokeAt 早于 since 的是上一段的叫醒，不算。
 */
export function dueStep(input: {
  kind: DueKind;
  since: number;
  wokeAt: number | null;
  now: number;
}): DueStep {
  const { ms, escalate } = DUE[input.kind];
  if (input.now - input.since < ms) return "none";
  if (input.wokeAt === null || input.wokeAt < input.since) return "wake";
  return escalate && input.now - input.wokeAt >= ms ? "escalate" : "none";
}

/** 时长的人话：「45 分钟」「3 小时」「2 天」；不到 1 分钟为空串。 */
export function spanText(ms: number): string {
  if (!(ms >= MINUTE)) return "";
  const minutes = Math.floor(ms / MINUTE);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} 小时` : `${Math.floor(hours / 24)} 天`;
}

/**
 * 状态栏与 top 的同一种写法：挂到时限的四分之一才说「N 分钟没动」，到期再加「已超时」。
 */
export function heldText(kind: DueKind, ms: number): string {
  const { ms: limit } = DUE[kind];
  if (!(ms >= limit / 4) || !spanText(ms)) return "";
  return `${spanText(ms)}没动${ms >= limit ? "，已超时" : ""}`;
}

/** `overdue` 事件的内容：持球人、已挂多久、下一步。 */
export function overdueDetail(input: {
  kind: DueKind;
  step: "wake" | "escalate";
  who: string | null;
  heldMs: number;
  title?: string;
  /** 这一步之后接手的人（上交给谁）；叫醒时就是持球人。 */
  to?: string;
  next?: string;
}) {
  const due = DUE[input.kind];
  const held = spanText(input.heldMs) || "不到 1 分钟";
  const action =
    input.step === "wake" ? due.wake : `上交${input.to ? ` ${input.to}` : ""}`;
  return {
    holder: input.kind,
    who: input.who,
    held_ms: input.heldMs,
    step: input.step,
    ...(input.title ? { title: input.title } : {}),
    reason: `${due.who}${input.who ? ` ${input.who}` : ""} 已 ${held}没动（时限 ${spanText(due.ms)}）：${action}`,
    ...(input.next ? { next: input.next } : {}),
  };
}

/** 运行时自己处理的到期（执行者、检查、发版）只作知会；要人动手的（叫醒 leader、上交）要处理。 */
export const overdueInfo = (detail: unknown) => {
  const holder = (detail as { holder?: unknown } | null)?.holder;
  return holder === "starting" || holder === "worker" || holder === "check";
};
