/**
 * 合入队列还要多久（t254）：纯函数，穷举测试；数据在 merge-queue-view.ts 取。
 * 按最近合入的每件从「开始合入」到「已合入」的平均用时估：排着的每件一份，正在合入的那件扣掉已经用掉的。
 * 提前检查复用上的件合得快，平均用时跟着变短，估计自然跟上。
 */

/** 取最近多少件合入来算平均。 */
export const ETA_SAMPLES = 20;
/** 只看最近这么久内合入的（太久以前的机器、检查耗时不代表现在）。 */
export const ETA_WINDOW_MS = 24 * 60 * 60_000;
/** 一件用时的上限：等重跑、等人工核对的离群值不把平均拉歪。 */
export const ETA_SAMPLE_CAP_MS = 60 * 60_000;

export type MergeQueueView = {
  /** 排队合入的件数。 */
  waiting: number;
  /** 正在合入的件数（0 或 1）。 */
  merging: number;
  /** 最近每件平均用时；没有样本为 null。 */
  per_ms: number | null;
  /** 全部合完还要多久；没有样本为 null。 */
  eta_ms: number | null;
};

export function mergeEta(input: {
  waiting: number;
  /** 正在合入的那件已经用了多久；没有在合入的为 null。 */
  merging: { elapsed_ms: number } | null;
  /** 最近每件合入的用时（毫秒）。 */
  samples: readonly number[];
}): MergeQueueView {
  const samples = input.samples
    .filter((ms) => Number.isFinite(ms) && ms >= 0)
    .slice(0, ETA_SAMPLES)
    .map((ms) => Math.min(ms, ETA_SAMPLE_CAP_MS));
  const waiting = Math.max(0, Math.floor(input.waiting));
  const merging = input.merging ? 1 : 0;
  if (!samples.length) return { waiting, merging, per_ms: null, eta_ms: null };
  const per = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
  // 正在合入的超过平均还没完：按还要一分钟算，不写成 0。
  const current = input.merging
    ? Math.max(per - Math.max(0, input.merging.elapsed_ms), 60_000)
    : 0;
  return {
    waiting,
    merging,
    per_ms: per,
    eta_ms: waiting || merging ? waiting * per + current : 0,
  };
}

/** 「约 25 分钟」「约 2 小时 10 分」「约 3 小时」；不到一分钟算一分钟。 */
export function etaText(ms: number) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `约 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `约 ${hours} 小时${rest ? ` ${rest} 分` : ""}`;
}

/**
 * 看板与状态栏的一段：「排队合入 16 · 还要约 2 小时 10 分」（合完正在合入的与排着的全部）；
 * 没有排着的为 null（只剩正在合入的那件，看板另有「合入中」），没有样本只写件数。
 */
export function mergeQueueText(view: MergeQueueView | null | undefined) {
  if (!view?.waiting) return null;
  const wait = view.eta_ms ? ` · 还要${etaText(view.eta_ms)}` : "";
  return `排队合入 ${view.waiting}${wait}`;
}
