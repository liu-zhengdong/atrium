import type { Exit, Stop } from "./outcome.ts";
import { parseReviewVerdict } from "./review.ts";

/**
 * 结论补答（t209）：合入前审阅靠回复最后一行的固定格式给结论。
 * 格式没写对时不当没结论卡住或打回，先让同一执行者续上会话补答一次。纯函数；
 * 认哪类任务、读摘要、登记捎话在 conclusion-runtime.ts，续上会话沿用捎话（tell-runtime.ts）。
 */

export type ConclusionKind = "review";

/** 摘要里有没有读得出的结论。 */
export function hasConclusion(kind: ConclusionKind, text: string): boolean {
  return kind === "review" && parseReviewVerdict(text) !== null;
}

const LAST_LINE: Record<ConclusionKind, string> = {
  review:
    "`审阅结论：通过` 或 `审阅结论：打回`（打回时把必须改的问题——文件:行、现象、怎么改——写在前面）",
};

/** 捎给执行者的补答要求。 */
export const askText = (kind: ConclusionKind) =>
  [
    "你上一条回复的最后一行没有按格式写结论，运行时读不出来。",
    "不用重新调查，也不要改文件：把上一条回复按原意完整重写一遍（可以精简），最后一行只写",
    `${LAST_LINE[kind]}。`,
  ].join("\n");

/** 这一轮退出后要不要补答：结论类任务、正常结束、不是被停下、这一轮还没补答过、读不出结论。 */
export function shouldAsk(input: {
  kind: ConclusionKind | undefined;
  exit: Exit;
  stop?: Stop;
  /** 这一轮（最近一次拉起以来）已经要求过补答。 */
  asked: boolean;
  text: string;
}): boolean {
  if (!input.kind || input.stop || input.asked) return false;
  const clean =
    input.exit === "unknown" ||
    (input.exit.code === 0 && input.exit.signal === null);
  return clean && !hasConclusion(input.kind, input.text);
}
