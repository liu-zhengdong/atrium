import type { PaceEntry } from "../dispatch/prepare.ts";

export type Headroom = { points: number; reason: string };

/** 各账号的富余：100 − 给用户保留的百分比 − 已用；同一账号多个窗口取最紧的。 */
export function quotaHeadroom(
  pace: readonly PaceEntry[] | undefined,
  reserve: number,
): Map<string, Headroom> {
  const result = new Map<string, Headroom>();
  for (const entry of pace ?? [])
    if (entry.usedPercent !== null && entry.usedPercent !== undefined) {
      const room = {
        points: 100 - reserve - entry.usedPercent,
        reason: `账号 ${entry.providerId} 已用 ${entry.usedPercent}%，须给用户保留 ${reserve}%`,
      };
      const previous = result.get(entry.providerId);
      if (!previous || room.points < previous.points)
        result.set(entry.providerId, room);
    }
  return result;
}
