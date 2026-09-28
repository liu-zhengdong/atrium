import type { WorkerStat } from "./delivery-records.ts";

/**
 * 执行者升降建议的阈值（t277）：都写在这里，改口径只改这一处。
 * 收紧就是给系统加限制（d48 尽量少加限制），只在事故有一定规模时建议：
 * 最近 ADVICE_WINDOW 次交付里事故至少 TIGHTEN_MIN_INCIDENTS 起、且占比至少 TIGHTEN_MIN_RATE。
 */
export const ADVICE_MIN_DELIVERIES = 5;
/** 看最近多少次交付判收紧（按结束先后）。 */
export const ADVICE_WINDOW = 20;
export const TIGHTEN_MIN_INCIDENTS = 3;
export const TIGHTEN_MIN_RATE = 0.15;
/** 同一组合、同一专员、同一建议多久内不重复投给秘书。 */
export const ADVICE_REPEAT_MS = 7 * 24 * 60 * 60 * 1000;

export type AdviceAction = "relax" | "tighten" | "avoid_role";
export type Advice = { action: AdviceAction; reason: string };

/** 按一行统计给建议；样本不够或没有值得提的就不给。 */
export function adviceFor(stat: WorkerStat): Advice | null {
  if (stat.scope !== "combination" || stat.deliveries < ADVICE_MIN_DELIVERIES)
    return null;
  if (
    stat.recent_incidents >= TIGHTEN_MIN_INCIDENTS &&
    stat.recent_incidents >= stat.recent_deliveries * TIGHTEN_MIN_RATE
  )
    return {
      action: "tighten",
      reason: `最近 ${stat.recent_deliveries} 次交付有 ${stat.recent_incidents} 起事故`,
    };
  if (stat.first_pass_rate !== null && stat.first_pass_rate < 0.5)
    return {
      action: "avoid_role",
      reason: `${stat.role ?? "未指定专员"} ${stat.deliveries} 次交付一次通过率 ${Math.round(stat.first_pass_rate * 100)}%`,
    };
  if (
    stat.first_pass_rate === 1 &&
    stat.incidents === 0 &&
    stat.trust !== "high"
  )
    return {
      action: "relax",
      reason: `${stat.deliveries} 次交付均一次通过且无事故`,
    };
  return null;
}

/** 上次投出同一建议的时刻（没投过为 null）距今够不够再投。 */
export const adviceDue = (lastAt: number | null, now: number) =>
  lastAt === null || now - lastAt >= ADVICE_REPEAT_MS;
