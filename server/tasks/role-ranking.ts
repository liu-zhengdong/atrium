import type { WorkerStat } from "./delivery-records.ts";
import { parseWorker } from "./profiles.ts";
/** 有至少五次样本时，一次通过率调整角色候选的顺序；样本少保持角色的人工优先顺序。 */
export function rankRoleWorkers(
  preferred: readonly string[],
  stats: readonly WorkerStat[],
  role: string,
): string[] {
  const rate = new Map(
    stats
      .filter((s) => s.role === role && !s.low_data)
      .map((s) => [`${s.scope}:${s.worker}`, s.first_pass_rate ?? 0]),
  );
  const score = (worker: string) => {
    const spec = parseWorker(worker);
    return (
      rate.get(`combination:${worker}`) ??
      rate.get(`model:${spec.tool}${spec.model ? `+${spec.model}` : ""}`) ??
      rate.get(`tool:${spec.tool}`) ??
      0.5
    );
  };
  const observed = stats
    .filter((s) => s.scope === "combination" && s.role === role && !s.low_data)
    .sort((a, b) => (b.first_pass_rate ?? 0) - (a.first_pass_rate ?? 0))
    .map((s) => s.worker)
    .filter((worker) => {
      try {
        parseWorker(worker);
        return true;
      } catch {
        return false;
      }
    });
  const candidates = [...new Set([...preferred, ...observed])];
  return candidates
    .map((worker, index) => ({
      worker,
      index,
      priority: index - (score(worker) - 0.5) * (preferred.length + 1),
    }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .map((x) => x.worker);
}
