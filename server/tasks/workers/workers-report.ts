import type { DatabaseSync } from "node:sqlite";
import { getJobRole } from "./job-roles.ts";
import { listDeliveries, workerStats } from "../gates/delivery-records.ts";
import { parseWorker, resolveWorker } from "./profiles.ts";

/** `atrium workers` / 执行者页展示的交付明细上限；统计仍看全部交付。 */
const DELIVERY_DETAIL_LIMIT = 200;

export async function workersReport(db: DatabaseSync, role?: string) {
  const job = role ? getJobRole(db, role) : undefined;
  const counts = workerStats(db, { job: job?.id });
  const ids = [...new Set(counts.map((s) => s.worker))];
  const trust = new Map(
    await Promise.all(
      ids.map(
        async (id) =>
          [
            id,
            await resolveWorker(id, db)
              .then((x) => x.profile.rules.trust ?? "unknown")
              .catch(() => "unknown"),
          ] as const,
      ),
    ),
  );
  const stats = counts.map((s) => ({
    ...s,
    trust: trust.get(s.worker) ?? null,
  }));
  return { role: job ?? null, stats };
}
export async function workerReport(db: DatabaseSync, worker: string) {
  parseWorker(worker);
  const resolved = await resolveWorker(worker, db);
  const stats = workerStats(db, { worker: resolved.id })
    .filter((s) => s.scope === "combination")
    .map((s) => ({
      ...s,
      trust: resolved.profile.rules.trust ?? "unknown",
    }));
  // 统计看全部交付；明细只给最近一段（网页与命令行都只展示这些）。
  const deliveries = listDeliveries(db, {
    worker: resolved.id,
    limit: DELIVERY_DETAIL_LIMIT,
  });
  return {
    worker: resolved.id,
    tool: resolved.tool,
    model: resolved.model ?? null,
    effort: resolved.effort ?? null,
    profile: resolved.profile,
    stats,
    deliveries,
  };
}
