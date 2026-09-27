import type { DatabaseSync } from "node:sqlite";
import {
  all,
  one,
  atomically,
  type TaskEventRow,
  type TaskRow,
} from "./ledger-model.ts";
import { parseWorker } from "./profiles.ts";
import { getJobRole } from "./job-roles.ts";

export type DeliveryRow = {
  id: number;
  task_id: number;
  start_event_id: number;
  worker: string;
  tool: string;
  model: string | null;
  effort: string | null;
  job_id: number | null;
  risk: string | null;
  part_id: number | null;
  started_at: number;
  ended_at: number | null;
  outcome: string | null;
  final_outcome: string | null;
  historical: number;
  job_rev: number | null;
  job_checks: string | null;
};
export type Delivery = DeliveryRow & {
  task_ref: string;
  task_title: string;
  final_result: string;
  job_ref: string | null;
  job_name: string | null;
  duration_ms: number | null;
  diff: { files: number; added: number; deleted: number } | null;
  gate_returns: string[];
  gate_return_count: number;
  merge_returns: string[];
  rebase_conflicts: number;
  incidents: string[];
  first_pass: boolean | null;
  merged: boolean;
  usage_points: number | null;
  usage_basis: string | null;
  verdict: string | null;
  verdict_note: string | null;
};
type EventDetail = Record<string, unknown>;
const detail = (event: TaskEventRow): EventDetail => {
  try {
    const x = JSON.parse(event.detail ?? "null") as unknown;
    return x && typeof x === "object" && !Array.isArray(x)
      ? (x as EventDetail)
      : {};
  } catch {
    return {};
  }
};
const inner = (event: TaskEventRow) => {
  const d = detail(event).detail;
  return d && typeof d === "object" && !Array.isArray(d)
    ? (d as EventDetail)
    : {};
};
const text = (x: unknown) => (typeof x === "string" ? x : null);
const number = (x: unknown) =>
  typeof x === "number" && Number.isFinite(x) ? x : null;
export const isRebaseConflict = (reason: string) =>
  /rebase\s*冲突|变基\s*冲突|rebase\s+conflict/i.test(reason);
export function ensureDeliveryRecords(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS deliveries(id INTEGER PRIMARY KEY AUTOINCREMENT,task_id INTEGER NOT NULL,start_event_id INTEGER NOT NULL UNIQUE,worker TEXT NOT NULL,tool TEXT NOT NULL,model TEXT,effort TEXT,job_id INTEGER,risk TEXT,part_id INTEGER,started_at INTEGER NOT NULL,ended_at INTEGER,outcome TEXT,final_outcome TEXT,historical INTEGER NOT NULL DEFAULT 0,job_rev INTEGER,job_checks TEXT);
  CREATE INDEX IF NOT EXISTS deliveries_worker ON deliveries(tool,model,effort,job_id,id);
  CREATE INDEX IF NOT EXISTS deliveries_task ON deliveries(task_id,id);`);
  const columns = new Set(
    all<{ name: string }>(db, "PRAGMA table_info(deliveries)").map(
      (x) => x.name,
    ),
  );
  if (!columns.has("job_rev"))
    db.exec("ALTER TABLE deliveries ADD COLUMN job_rev INTEGER");
  if (!columns.has("job_checks"))
    db.exec("ALTER TABLE deliveries ADD COLUMN job_checks TEXT");
  if (!columns.has("final_outcome"))
    db.exec("ALTER TABLE deliveries ADD COLUMN final_outcome TEXT");
  backfillDeliveries(db);
}
/** 旧库启动时逐页回填；只用账本事件里的事实，不推测遗失的强度或风险。 */
export function backfillDeliveries(db: DatabaseSync) {
  let after = 0;
  for (;;) {
    const starts = all<TaskEventRow>(
      db,
      "SELECT * FROM task_events WHERE kind='start' AND id>? ORDER BY id LIMIT 200",
      after,
    );
    for (const start of starts) {
      after = start.id;
      if (one(db, "SELECT 1 FROM deliveries WHERE start_event_id=?", start.id))
        continue;
      const task = one<TaskRow>(
        db,
        "SELECT * FROM tasks WHERE id=?",
        start.task_id,
      );
      if (!task) continue;
      const d = inner(start),
        raw = text(d.worker) ?? task.worker;
      if (!raw) continue;
      let spec;
      try {
        spec = parseWorker(raw);
      } catch {
        continue;
      }
      const nextStart = one<TaskEventRow>(
        db,
        "SELECT * FROM task_events WHERE task_id=? AND id>? AND kind='start' ORDER BY id LIMIT 1",
        task.id,
        start.id,
      );
      const end = one<TaskEventRow>(
        db,
        "SELECT * FROM task_events WHERE task_id=? AND id>? AND id<? AND kind IN ('exit_ok','exit_fail','block','manual_set','cancel') ORDER BY id LIMIT 1",
        task.id,
        start.id,
        nextStart?.id ?? Number.MAX_SAFE_INTEGER,
      );
      db.prepare(
        "INSERT OR IGNORE INTO deliveries(task_id,start_event_id,worker,tool,model,effort,job_id,risk,part_id,started_at,ended_at,outcome,historical) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)",
      ).run(
        task.id,
        start.id,
        raw,
        spec.tool,
        spec.model ?? null,
        null,
        task.job_id,
        text(d.risk),
        task.part_id,
        start.at,
        end?.at ?? nextStart?.at ?? null,
        end?.kind ?? (nextStart ? "switched" : null),
      );
    }
    if (starts.length < 200) break;
  }
}
export function startDelivery(
  db: DatabaseSync,
  task: TaskRow,
  eventId: number,
  worker: string,
  risk: string | null,
  at: number,
) {
  let spec: { tool: string; model?: string; effort?: string };
  try {
    spec = parseWorker(worker);
  } catch {
    spec = { tool: worker.split(/[+:]/, 1)[0] ?? worker };
  }
  const job = task.job_id ? getJobRole(db, `r${task.job_id}`) : null;
  db.prepare(
    "UPDATE deliveries SET final_outcome='switched',ended_at=COALESCE(ended_at,?),outcome=COALESCE(outcome,'switched') WHERE id=(SELECT id FROM deliveries WHERE task_id=? ORDER BY id DESC LIMIT 1) AND worker<>? AND COALESCE(final_outcome,'') NOT IN ('merged','cancelled')",
  ).run(at, task.id, worker);
  db.prepare(
    "INSERT OR IGNORE INTO deliveries(task_id,start_event_id,worker,tool,model,effort,job_id,risk,part_id,started_at,historical,job_rev,job_checks) VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?)",
  ).run(
    task.id,
    eventId,
    worker,
    spec.tool,
    spec.model ?? null,
    spec.effort ?? null,
    task.job_id,
    risk,
    task.part_id,
    at,
    job?.rev ?? null,
    job ? JSON.stringify(job.checks) : null,
  );
}
export function activeJobChecks(
  db: DatabaseSync,
  taskId: number,
): string[] | null {
  const row = one<{ job_checks: string | null }>(
    db,
    "SELECT job_checks FROM deliveries WHERE task_id=? ORDER BY id DESC LIMIT 1",
    taskId,
  );
  if (!row?.job_checks) return null;
  try {
    const checks = JSON.parse(row.job_checks) as unknown;
    return Array.isArray(checks) && checks.every((x) => typeof x === "string")
      ? (checks as string[])
      : null;
  } catch {
    return null;
  }
}
export function endDelivery(
  db: DatabaseSync,
  taskId: number,
  outcome: string,
  at: number,
) {
  db.prepare(
    "UPDATE deliveries SET ended_at=?,outcome=?,final_outcome=? WHERE id=(SELECT id FROM deliveries WHERE task_id=? AND ended_at IS NULL ORDER BY id DESC LIMIT 1)",
  ).run(at, outcome, outcome, taskId);
}
export function markDeliveryFinal(
  db: DatabaseSync,
  taskId: number,
  result: string,
) {
  db.prepare(
    "UPDATE deliveries SET final_outcome=? WHERE id=(SELECT id FROM deliveries WHERE task_id=? ORDER BY id DESC LIMIT 1)",
  ).run(result, taskId);
}
export function deliveryFacts(
  row: DeliveryRow,
  task: TaskRow,
  events: TaskEventRow[],
  usage: { points: number; basis: string } | undefined,
  jobName: string | null,
): Delivery {
  const later = events.filter((e) => e.id > row.start_event_id);
  const untilNext = later.find((e) => e.kind === "start");
  const current = later.filter((e) => !untilNext || e.id < untilNext.id);
  const gates = current.filter((e) => e.kind === "gates").map(detail);
  const failedGates = gates.flatMap((d) =>
    Array.isArray(d.results)
      ? d.results
          .filter(
            (x): x is EventDetail =>
              !!x && typeof x === "object" && !Array.isArray(x),
          )
          .filter((x) => x.ok === false && x.pending !== true)
          .map(
            (x) => `${text(x.gate) ?? "关卡"}：${text(x.evidence) ?? "未过"}`,
          )
      : [],
  );
  const mergeReturns = current
    .filter((e) => e.kind === "merge_returned" || e.kind === "merge_blocked")
    .map((e) => text(detail(e).reason) ?? "合入队列退回");
  const conflicts = mergeReturns.filter(isRebaseConflict).length;
  const incidents = [
    ...(current.some(
      (e) => e.kind === "stalled" || /卡死/.test(text(inner(e).reason) ?? ""),
    )
      ? ["卡死"]
      : []),
    ...(current.some((e) => e.kind === "thinking_retry") ? ["思考耗尽"] : []),
    ...(gates.some(
      (d) =>
        Array.isArray(d.results) &&
        d.results.some(
          (x: unknown) =>
            !!x &&
            typeof x === "object" &&
            "gate" in x &&
            (x as EventDetail).gate === "pr_exists" &&
            (x as EventDetail).ok === false,
        ),
    )
      ? ["没开 PR"]
      : []),
    ...(failedGates.some((x) => x.startsWith("claims_verified"))
      ? ["虚报"]
      : []),
    ...(current.some((e) => /worker_guard|worker-guard/.test(e.kind))
      ? ["越界"]
      : []),
  ];
  const gateDiff = gates
    .map((d) => d.diff)
    .find((x) => !!x && typeof x === "object") as EventDetail | undefined;
  const diff = gateDiff
    ? {
        files: number(gateDiff.files) ?? 0,
        added: number(gateDiff.added) ?? 0,
        deleted: number(gateDiff.deleted) ?? number(gateDiff.removed) ?? 0,
      }
    : null;
  const notes = current
    .filter((e) => e.kind === "note")
    .map(detail)
    .filter((d) => ["ok", "fixed", "rejected"].includes(text(d.verdict) ?? ""));
  const lastNote = notes.at(-1);
  const merged =
    current.some((e) => e.kind === "merged") ||
    ((task.delivery_stage === "merged" || task.delivery_stage === "online") &&
      !untilNext);
  const passed = gates.some((d) => d.passed === true);
  return {
    ...row,
    task_ref: `t${row.task_id}`,
    task_title: task.title,
    final_result:
      row.final_outcome === "merged" || merged
        ? "已合入"
        : row.final_outcome === "cancelled"
          ? "取消"
          : row.final_outcome === "switched" ||
              (untilNext && text(inner(untilNext).worker) !== row.worker)
            ? "换人"
            : row.final_outcome === "rebase_conflict"
              ? "变基冲突"
              : row.final_outcome === "returned"
                ? "合入退回"
                : !untilNext && task.status === "cancelled"
                  ? "取消"
                  : row.outcome === "exit_ok"
                    ? "交付"
                    : row.outcome === "exit_fail"
                      ? "失败"
                      : row.outcome === "block"
                        ? "受阻"
                        : (row.outcome ?? "进行中"),
    job_ref: row.job_id ? `r${row.job_id}` : null,
    job_name: jobName,
    duration_ms:
      row.ended_at === null ? null : Math.max(0, row.ended_at - row.started_at),
    diff,
    gate_returns: failedGates,
    gate_return_count: gates.filter(
      (d) =>
        Array.isArray(d.results) &&
        d.results.some(
          (x: unknown) =>
            !!x &&
            typeof x === "object" &&
            "ok" in x &&
            (x as EventDetail).ok === false &&
            (x as EventDetail).pending !== true,
        ),
    ).length,
    merge_returns: mergeReturns.filter((r) => !isRebaseConflict(r)),
    rebase_conflicts: conflicts,
    incidents,
    first_pass:
      row.ended_at === null
        ? null
        : passed &&
          failedGates.length === 0 &&
          mergeReturns.length === conflicts,
    merged,
    usage_points: usage?.basis === "unknown" ? null : (usage?.points ?? null),
    usage_basis: usage?.basis ?? null,
    verdict: text(lastNote?.verdict),
    verdict_note: text(lastNote?.text),
  };
}
export function listDeliveries(
  db: DatabaseSync,
  filter: { worker?: string; job?: number; limit?: number } = {},
) {
  const limit =
    filter.limit === undefined
      ? Number.MAX_SAFE_INTEGER
      : Math.max(1, Math.min(filter.limit, 1000));
  const rows: DeliveryRow[] = [];
  let before = Number.MAX_SAFE_INTEGER;
  while (rows.length < limit) {
    const page = all<DeliveryRow>(
      db,
      "SELECT * FROM deliveries WHERE (? IS NULL OR worker=?) AND (? IS NULL OR job_id=?) AND id<? ORDER BY id DESC LIMIT ?",
      filter.worker ?? null,
      filter.worker ?? null,
      filter.job ?? null,
      filter.job ?? null,
      before,
      Math.min(200, limit - rows.length),
    );
    rows.push(...page);
    if (page.length < 200 || rows.length >= limit) break;
    before = page.at(-1)!.id;
  }
  return rows.flatMap((row) => {
    const task = one<TaskRow>(
      db,
      "SELECT * FROM tasks WHERE id=?",
      row.task_id,
    );
    if (!task) return [];
    const events: TaskEventRow[] = [];
    let cursor = row.start_event_id;
    for (;;) {
      const page = all<TaskEventRow>(
        db,
        "SELECT * FROM task_events WHERE task_id=? AND id>? ORDER BY id LIMIT 200",
        row.task_id,
        cursor,
      );
      events.push(...page);
      if (page.length < 200 || page.some((event) => event.kind === "start"))
        break;
      cursor = page.at(-1)!.id;
    }
    const usage = one<{ points: number; basis: string }>(
      db,
      "SELECT points,basis FROM task_usage WHERE task_id=? AND started_at>=? ORDER BY started_at LIMIT 1",
      row.task_id,
      row.started_at - 2000,
    );
    const job = row.job_id
      ? one<{ name: string }>(
          db,
          "SELECT name FROM job_roles WHERE id=?",
          row.job_id,
        )
      : undefined;
    return [deliveryFacts(row, task, events, usage, job?.name ?? null)];
  });
}
export type WorkerStat = {
  scope: "combination" | "model" | "tool";
  worker: string;
  role: string | null;
  deliveries: number;
  first_pass_rate: number | null;
  average_returns: number;
  median_ms: number | null;
  incidents: number;
  low_data: boolean;
  trust: string | null;
};
export function summarizeDeliveries(
  rows: readonly Delivery[],
  trust: ReadonlyMap<string, string> = new Map(),
): WorkerStat[] {
  const groups = new Map<
    string,
    {
      scope: WorkerStat["scope"];
      worker: string;
      role: string | null;
      rows: Delivery[];
    }
  >();
  for (const row of rows)
    for (const [scope, worker] of [
      ["combination", row.worker],
      ["model", row.model ? `${row.tool}+${row.model}` : row.tool],
      ["tool", row.tool],
    ] as const) {
      const role = row.job_name;
      const key = JSON.stringify([scope, worker, role]);
      const group = groups.get(key) ?? { scope, worker, role, rows: [] };
      group.rows.push(row);
      groups.set(key, group);
    }
  return [...groups.values()]
    .map((g) => {
      const finished = g.rows.filter((r) => r.ended_at !== null);
      const rated = finished.filter((r) => r.first_pass !== null);
      const durations = finished
        .map((r) => r.duration_ms)
        .filter((n): n is number => n !== null)
        .sort((a, b) => a - b);
      const mid = durations.length
        ? durations.length % 2
          ? durations[(durations.length - 1) / 2]!
          : (durations[durations.length / 2 - 1]! +
              durations[durations.length / 2]!) /
            2
        : null;
      return {
        scope: g.scope,
        worker: g.worker,
        role: g.role,
        deliveries: finished.length,
        first_pass_rate: rated.length
          ? rated.filter((r) => r.first_pass).length / rated.length
          : null,
        average_returns: finished.length
          ? finished.reduce(
              (n, r) => n + r.gate_return_count + r.merge_returns.length,
              0,
            ) / finished.length
          : 0,
        median_ms: mid,
        incidents: finished.reduce((n, r) => n + r.incidents.length, 0),
        low_data: finished.length < 5,
        trust: trust.get(g.worker) ?? null,
      };
    })
    .sort(
      (a, b) =>
        (a.role ?? "").localeCompare(b.role ?? "") ||
        a.scope.localeCompare(b.scope) ||
        a.worker.localeCompare(b.worker),
    );
}
export function adviceFor(
  stat: WorkerStat,
): { action: "relax" | "tighten" | "avoid_role"; reason: string } | null {
  if (stat.scope !== "combination" || stat.deliveries < 5) return null;
  if (stat.incidents > 0)
    return {
      action: "tighten",
      reason: `${stat.deliveries} 次交付有 ${stat.incidents} 起事故`,
    };
  if (stat.first_pass_rate !== null && stat.first_pass_rate < 0.5)
    return {
      action: "avoid_role",
      reason: `${stat.role ?? "未指定角色"} ${stat.deliveries} 次交付一次通过率 ${Math.round(stat.first_pass_rate * 100)}%`,
    };
  if (
    stat.first_pass_rate === 1 &&
    stat.deliveries >= 5 &&
    stat.trust !== "high"
  )
    return {
      action: "relax",
      reason: `${stat.deliveries} 次交付均一次通过且无事故`,
    };
  return null;
}
