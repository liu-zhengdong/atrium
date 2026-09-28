import { Problem } from "../problem.ts";
import { parseWorker } from "./profiles.ts";

/**
 * 任务大小（t276，决定 d135）：小活不必都派高强度，挑快且便宜的组合；中、大派强的。
 *
 * - 三档：small / medium / large，存 `tasks.size`；没写为 null，挑人时按详述长度与牵涉范围粗估（estimateSize），
 *   粗估只给中或大，小只能明确写（免得把该用强模型的活悄悄降给弱的）。
 * - 自动挑人（task pick、不写 --worker 的 task run、自动派）按大小调整排序（pick.ts pickView）：
 *   合适的组合（sizeFits）排在其余能接的前面，超速或没有额度读数（旧数）的不算合适；专员优先执行者仍在最前（小活时其中快的先）；
 *   能不能接（额度、max_risk、trust、避开）照旧，紧急任务照旧按一次通过率与速度。
 *
 * 纯函数；读库拼事实在 pick-runtime.ts。
 */

export const SIZES = ["small", "medium", "large"] as const;
export type Size = (typeof SIZES)[number];

export const SIZE_LABEL: Record<Size, string> = {
  small: "小",
  medium: "中",
  large: "大",
};

const ALIASES: Record<string, Size> = {
  small: "small",
  medium: "medium",
  large: "large",
  小: "small",
  中: "medium",
  大: "large",
};

/** 接口与命令行都接受「小 / 中 / 大」或 small / medium / large；其余一律拒绝。 */
export function parseSize(value: unknown): Size {
  const found =
    typeof value === "string" ? ALIASES[value.trim().toLowerCase()] : undefined;
  if (!found) throw new Problem(400, "size: 只能是 小、中 或 大", "usage");
  return found;
}

/** 详述超过这么多字按大估。 */
export const LARGE_BRIEF_CHARS = 4000;
/** 牵涉这么多个部分以上按大估。 */
export const LARGE_ALSO_PARTS = 2;

/** 没写大小时的粗估：详述很长或牵涉多个部分为大，其余为中；不估小。 */
export function estimateSize(task: {
  brief?: string | null;
  also?: readonly string[];
}): Size {
  const chars = [...(task.brief ?? "").trim()].length;
  const parts = task.also?.length ?? 0;
  return chars > LARGE_BRIEF_CHARS || parts >= LARGE_ALSO_PARTS
    ? "large"
    : "medium";
}

/** 生效的大小：写了按写的，没写粗估；estimated 标明是估的。 */
export function effectiveSize(task: {
  size?: string | null;
  brief?: string | null;
  also?: readonly string[];
}): { size: Size; estimated: boolean } {
  const written = SIZES.find((s) => s === task.size);
  return written
    ? { size: written, estimated: false }
    : { size: estimateSize(task), estimated: true };
}

/** 各档额外放进候选的组合（工具已装才放）；只写工具的补档案或适配器的默认模型。 */
export const SIZE_WORKERS: Record<"fast" | "strong", readonly string[]> = {
  fast: [
    "cursor+auto",
    "codex:low",
    "opencode+opencode-go/deepseek-v4.1-flash",
  ],
  strong: ["claude:high", "codex:high"],
};

const FAST_EFFORTS = ["none", "minimal", "low"];
const STRONG_EFFORTS = ["high", "xhigh", "max"];

/**
 * 组合快慢：强度 high 以上为强；强度 low 以下、cursor+auto、快组合表里的模型为快；其余（没写强度的默认组合）不归类。
 * 标识不合法的不归类。
 */
export function speedOf(worker: string): "fast" | "strong" | null {
  let spec;
  try {
    spec = parseWorker(worker);
  } catch {
    return null;
  }
  if (spec.effort && STRONG_EFFORTS.includes(spec.effort)) return "strong";
  if (spec.effort && FAST_EFFORTS.includes(spec.effort)) return "fast";
  const listed = SIZE_WORKERS.fast.some((entry) => {
    const fast = parseWorker(entry);
    return fast.model && fast.tool === spec.tool && fast.model === spec.model;
  });
  return listed ? "fast" : null;
}

/** 这一档要的组合：小要快的，中、大要强的。 */
export const wantedSpeed = (size: Size) =>
  size === "small" ? "fast" : "strong";

/** 组合合不合这一档。 */
export const sizeFits = (size: Size, worker: string) =>
  speedOf(worker) === wantedSpeed(size);

/** 这一档额外放进候选的组合。 */
export const sizeWorkers = (size: Size) => SIZE_WORKERS[wantedSpeed(size)];

const WANTED_TEXT = { fast: "快且便宜的组合", strong: "高强度组合" } as const;

/** 大小的说法：「小活」「中活（没写大小，按中估）」。 */
export const sizeText = (size: Size, estimated: boolean) =>
  `${SIZE_LABEL[size]}活${estimated ? `（没写大小，按${SIZE_LABEL[size]}估）` : ""}`;

/**
 * 推荐理由里大小那一句；候选里没有合这一档的组合（没装）时不说。
 * top：推荐的那位合不合这一档、是不是专员优先执行者。
 */
export function sizeReason(
  facts: { size: Size; estimated: boolean },
  top: { fits: boolean; preferred: boolean },
  anyFits: boolean,
): string | null {
  if (!anyFits) return null;
  const size = sizeText(facts.size, facts.estimated);
  const want = WANTED_TEXT[wantedSpeed(facts.size)];
  if (top.fits) return `${size}优先${want}`;
  if (top.preferred) return `${size}不按大小换：专员优先执行者在前`;
  return `${size}，${want}都不能接、正忙、超速或没有额度读数，按额度挑`;
}
