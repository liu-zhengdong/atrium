import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { atomically, one } from "./ledger-model.ts";
import { getJobRole } from "./job-roles.ts";
import {
  adviceFor,
  deliveryMetrics,
  latestDeliveryTaskId,
  listDeliveries,
  summarizeMetrics,
  type DeliveryMetric,
  type WorkerStat,
} from "./delivery-records.ts";
import { modelKey, parseWorker, resolveWorker, TRUSTS } from "./profiles.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { patchFront, readProfile, writeProfile } from "./worker-profiles.ts";
import type { EventInbox } from "./events.ts";

/** `workers show` / 执行者页展示的交付明细上限；统计仍看全部交付。 */
const DELIVERY_DETAIL_LIMIT = 200;

/** 每位执行者×专员最近一条交付的任务短号（一次遍历，不按建议条数查库）。 */
function latestByWorkerRole(metrics: readonly DeliveryMetric[]) {
  const latest = new Map<string, DeliveryMetric>();
  for (const row of metrics) {
    const key = `${row.worker}\u0000${row.job_name ?? ""}`;
    const prev = latest.get(key);
    if (!prev || row.id > prev.id) latest.set(key, row);
  }
  return latest;
}
function pendingSuggestions(
  db: DatabaseSync,
  metrics: DeliveryMetric[],
  stats: WorkerStat[],
) {
  const latest = latestByWorkerRole(metrics);
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
  const metrics = deliveryMetrics(db, { job: job?.id });
  const ids = [
    ...new Set(
      metrics.flatMap((r) => [
        r.worker,
        r.model ? `${r.tool}+${r.model}` : r.tool,
        r.tool,
      ]),
    ),
  ];
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
  const stats = summarizeMetrics(metrics, trust);
  return {
    role: job ?? null,
    stats,
    suggestions: pendingSuggestions(db, metrics, stats),
  };
}
export async function workerReport(db: DatabaseSync, worker: string) {
  parseWorker(worker);
  const resolved = await resolveWorker(worker, db);
  const metrics = deliveryMetrics(db, { worker: resolved.id });
  const stats = summarizeMetrics(
    metrics,
    new Map([[resolved.id, resolved.profile.rules.trust ?? "unknown"]]),
  ).filter((s) => s.scope === "combination");
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
    suggestions: pendingSuggestions(db, metrics, stats),
  };
}
/** 有充分样本才提醒秘书；按统计条件变化去重，确认前只生成建议。 */
export function publishWorkerAdvice(
  db: DatabaseSync,
  inbox: EventInbox,
  taskId: number,
) {
  const task = one<{ job_id: number | null; worker: string | null }>(
    db,
    "SELECT job_id,worker FROM tasks WHERE id=?",
    taskId,
  );
  if (!task?.job_id || !task.worker) return;
  const metrics = deliveryMetrics(db, {
    job: task.job_id,
    worker: task.worker,
  });
  let last: DeliveryMetric | undefined;
  for (const row of metrics)
    if (row.task_id === taskId && (!last || row.id > last.id)) last = row;
  if (!last || last.job_id === null) return;
  const roleRef = `r${last.job_id}`;
  const stats = summarizeMetrics(metrics).filter(
    (s) =>
      s.scope === "combination" &&
      s.worker === last!.worker &&
      s.role === last!.job_name,
  );
  for (const stat of stats) {
    const advice = adviceFor(stat);
    if (!advice) return;
    const event = db
      .prepare(
        "SELECT 1 FROM task_events WHERE task_id=? AND kind='worker_advice' AND detail LIKE ? LIMIT 1",
      )
      .get(taskId, `%${advice.action}%`);
    if (event) return;
    const data = {
      worker: stat.worker,
      role: roleRef,
      action: advice.action,
      reason: advice.reason,
    };
    db.prepare(
      "INSERT INTO task_events(task_id,at,kind,detail) VALUES(?,?,?,?)",
    ).run(taskId, Date.now(), "worker_advice", JSON.stringify(data));
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
    value = TRUSTS[next]!;
    if (
      b.action === "relax" &&
      profile.profile.layers.some(
        (layer) =>
          layer.layer !== "combos" &&
          layer.rules.trust !== undefined &&
          TRUSTS.indexOf(layer.rules.trust) < next,
      )
    )
      throw new Problem(
        409,
        "上层档案的 trust 更严，组合档案无法放宽；请先审查上层档案",
        "conflict",
      );
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
