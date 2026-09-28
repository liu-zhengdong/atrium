import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { atomically, one } from "./ledger-model.ts";
import { getJobRole } from "./job-roles.ts";
import {
  latestDeliveryByWorkerJob,
  latestDeliveryTaskId,
  listDeliveries,
  workerStats,
  type WorkerStat,
} from "./delivery-records.ts";
import { adviceDue, adviceFor } from "./worker-advice.ts";
import { modelKey, parseWorker, resolveWorker, TRUSTS } from "./profiles.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { patchFront, readProfile, writeProfile } from "./worker-profiles.ts";
import type { EventInbox } from "./events.ts";

/** `workers show` / 执行者页展示的交付明细上限；统计仍看全部交付。 */
const DELIVERY_DETAIL_LIMIT = 200;

type LatestDelivery = { task_id: number; job_id: number | null };
/** 每位执行者×专员最近一条交付（SQL 取好），建议只认这一条。 */
function latestMap(
  rows: ReturnType<typeof latestDeliveryByWorkerJob>,
): Map<string, LatestDelivery> {
  const map = new Map<string, LatestDelivery>();
  for (const row of rows)
    map.set(`${row.worker}\u0000${row.role ?? ""}`, {
      task_id: row.task_id,
      job_id: row.job_id,
    });
  return map;
}
function pendingSuggestions(
  db: DatabaseSync,
  latest: ReadonlyMap<string, LatestDelivery>,
  stats: WorkerStat[],
) {
  return stats.flatMap((stat) => {
    const advice = adviceFor(stat);
    if (!advice) return [];
    const row = latest.get(`${stat.worker}\u0000${stat.role ?? ""}`);
    if (!row) return [];
    const confirmations = db
      .prepare(
        "SELECT detail FROM task_events WHERE task_id=? AND kind='worker_advice_confirmed' ORDER BY id DESC LIMIT 20",
      )
      .all(row.task_id) as { detail: string }[];
    const confirmed = confirmations.some(({ detail }) => {
      try {
        const data = JSON.parse(detail) as Record<string, unknown>;
        return (
          data.worker === stat.worker &&
          data.role === (row.job_id === null ? null : `r${row.job_id}`) &&
          data.action === advice.action
        );
      } catch {
        return false;
      }
    });
    return confirmed ? [] : [{ stat, advice }];
  });
}

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
  const latest = latestMap(latestDeliveryByWorkerJob(db, { job: job?.id }));
  return {
    role: job ?? null,
    stats,
    suggestions: pendingSuggestions(db, latest, stats),
  };
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
    suggestions: pendingSuggestions(
      db,
      latestMap(latestDeliveryByWorkerJob(db, { worker: resolved.id })),
      stats,
    ),
  };
}
/**
 * 同一组合、同一专员、同一建议上次投给秘书的时刻（没投过为 null）。
 * 只翻这个组合在这个专员下交付过的任务上的事件（交付表与事件表都走索引）。
 */
function lastAdviceAt(
  db: DatabaseSync,
  worker: string,
  jobId: number,
  action: string,
): number | null {
  const row = one<{ at: number | null }>(
    db,
    `SELECT MAX(at) AS at FROM task_events
     WHERE task_id IN (SELECT task_id FROM task_deliveries WHERE worker=? AND job_id=?)
       AND kind='worker_advice' AND json_valid(detail)
       AND json_extract(detail,'$.worker')=? AND json_extract(detail,'$.role')=?
       AND json_extract(detail,'$.action')=?`,
    worker,
    jobId,
    worker,
    `r${jobId}`,
    action,
  );
  return row?.at ?? null;
}
/**
 * 有充分样本才提醒秘书；同一组合同一建议 7 天内只投一次（t277），确认前只生成建议。
 * 建议是知会级（event-level.ts），进 digest，不叫醒秘书。
 */
export function publishWorkerAdvice(
  db: DatabaseSync,
  inbox: EventInbox,
  taskId: number,
  now = Date.now(),
) {
  const task = one<{ job_id: number | null; worker: string | null }>(
    db,
    "SELECT job_id,worker FROM tasks WHERE id=?",
    taskId,
  );
  if (!task?.job_id || !task.worker) return;
  if (
    !one(
      db,
      "SELECT 1 FROM task_deliveries WHERE task_id=? AND worker=? AND job_id=? LIMIT 1",
      taskId,
      task.worker,
      task.job_id,
    )
  )
    return;
  const stats = workerStats(db, {
    job: task.job_id,
    worker: task.worker,
  }).filter((s) => s.scope === "combination");
  const roleRef = `r${task.job_id}`;
  for (const stat of stats) {
    const advice = adviceFor(stat);
    if (!advice) continue;
    if (
      !adviceDue(lastAdviceAt(db, stat.worker, task.job_id, advice.action), now)
    )
      continue;
    const data = {
      worker: stat.worker,
      role: roleRef,
      action: advice.action,
      reason: advice.reason,
    };
    db.prepare(
      "INSERT INTO task_events(task_id,at,kind,detail) VALUES(?,?,?,?)",
    ).run(taskId, now, "worker_advice", JSON.stringify(data));
    inbox.publish({
      subscriber: "secretary",
      taskId,
      source: "workers",
      kind: "worker_advice",
      key: `t${taskId}:worker_advice`,
      detail: data,
    });
  }
}
export async function confirmWorkerAdvice(db: DatabaseSync, body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Problem(400, "请求体应为 JSON 对象", "usage");
  const b = body as Record<string, unknown>;
  if (
    typeof b.worker !== "string" ||
    typeof b.role !== "string" ||
    typeof b.action !== "string"
  )
    throw new Problem(400, "worker、role、action 必填", "usage");
  const role = getJobRole(db, b.role);
  const spec = parseWorker(b.worker);
  if (!spec.model) throw new Problem(400, "worker 须包含模型", "usage");
  const report = await workersReport(db, role.ref);
  const suggestion = report.suggestions.find(
    (x) =>
      x.stat.worker === b.worker &&
      x.stat.role === role.name &&
      x.advice?.action === b.action,
  );
  if (!suggestion)
    throw new Problem(
      409,
      "当前统计没有这条建议，请重新运行 atrium workers 查看",
      "conflict",
    );
  const profile = await resolveWorker(b.worker, db);
  const name = `${spec.tool}+${modelKey(spec.model)}`;
  const file = `combos/${name}`;
  const source = readProfile(db, "combos", name)?.source ?? "";
  if (parseFrontmatter(source).warnings.length)
    throw new Problem(
      409,
      `档案 ${file} 有无法解析的 frontmatter，先用 atrium workers edit ${file} --file 修正后确认`,
      "conflict",
    );
  let key: string, value: string;
  if (b.action === "avoid_role") {
    key = "avoid_jobs";
    const old = profile.profile.rules.avoid_jobs;
    const items = Array.isArray(old)
      ? old.filter((x): x is string => typeof x === "string")
      : [];
    value = JSON.stringify([...new Set([...items, role.ref])]);
  } else {
    key = "trust";
    const actual = profile.profile.rules.trust ?? "unknown";
    const index = TRUSTS.indexOf(actual);
    const next =
      b.action === "relax"
        ? Math.min(TRUSTS.length - 1, index + 1)
        : Math.max(0, index - 1);
    // 组合档案是最具体的一层，写了就以它为准，上层更严也能放宽。
    value = TRUSTS[next]!;
  }
  atomically(db, () => {
    writeProfile(db, {
      layer: "combos",
      name,
      source: patchFront(source, key, value),
      author: "secretary",
      reason: `确认交付记录建议：${role.ref} ${b.action}`,
    });
    db.prepare(
      "INSERT INTO task_events(task_id,at,kind,detail) VALUES(?,?,?,?)",
    ).run(
      suggestion.stat.deliveries
        ? (latestDeliveryTaskId(db, {
            worker: String(b.worker),
            job: role.id,
          }) ?? 0)
        : 0,
      Date.now(),
      "worker_advice_confirmed",
      JSON.stringify({
        worker: b.worker,
        role: role.ref,
        action: b.action,
        file,
      }),
    );
  });
  return {
    worker: b.worker,
    role: role.ref,
    action: b.action,
    file,
    [key]: value,
  };
}
