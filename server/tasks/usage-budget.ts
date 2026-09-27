import type { DatabaseSync } from "node:sqlite";
import { nodes, ref } from "../org/model.ts";
import { allShares } from "../org/share-store.ts";
import { ownAmount } from "../org/shares.ts";
import type { PaceEntry } from "./prepare.ts";
import { resetAt, subtreeUsage } from "./usage.ts";

export type Headroom = { points: number; reason: string };

/** 每个显式份额限制整棵子树；不写份额的节点沿用上层共享池。 */
export function quotaHeadroom(
  db: DatabaseSync,
  nodeId: number | null,
  pace: readonly PaceEntry[] | undefined,
  reserve: number,
  now = Date.now(),
): Map<string, Headroom> {
  const result = new Map<string, Headroom>();
  if (!pace) return result;
  if (nodeId === null) {
    for (const entry of pace)
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
  const list = nodes(db);
  const shares = allShares(db);
  let current = list.find((n) => n.id === nodeId);
  const chain = [];
  while (current) {
    chain.push(current);
    current = list.find((n) => n.id === current!.parent_id);
  }
  const descendants = (id: number): number[] => {
    const found = [id];
    for (let i = 0; i < found.length; i++)
      for (const child of list.filter((n) => n.parent_id === found[i]))
        found.push(child.id);
    return found;
  };
  for (const entry of pace) {
    if (entry.usedPercent === null || entry.usedPercent === undefined) continue;
    const reset = resetAt(entry, now);
    let points = 100 - reserve - entry.usedPercent;
    let reason = `账号 ${entry.providerId} 已用 ${entry.usedPercent}%，须给用户保留 ${reserve}%`;
    if (reset !== null)
      for (const node of chain) {
        const amount = ownAmount(
          shares.get(node.id) ?? [],
          "quota",
          entry.providerId,
        );
        if (amount === undefined) continue;
        const used = subtreeUsage(
          db,
          descendants(node.id),
          entry.providerId,
          reset,
        );
        if (amount - used < points) {
          points = amount - used;
          reason = `${ref(node.id)} ${node.name} 在 ${entry.providerId} 的份额 ${amount}，本窗口已用约 ${Number(used.toFixed(2))}`;
        }
      }
    const previous = result.get(entry.providerId);
    if (!previous || points < previous.points)
      result.set(entry.providerId, { points, reason });
  }
  return result;
}
