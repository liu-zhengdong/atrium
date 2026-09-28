import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  all,
  one,
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
const DELIVERY_COLUMNS =
  "id,task_id,start_event_id,worker,tool,model,effort,job_id,started_at,ended_at,outcome,final_outcome,historical,job_rev,job_checks";
export const isRebaseConflict = (reason: string) =>
  /rebase\s*冲突|变基\s*冲突|rebase\s+conflict/i.test(reason);
/** 一次交付窗口内的事实：只取本轮 start 之后、下一次 start 之前的事件（纯函数）。 */
type WindowFacts = {
  untilNext: TaskEventRow | undefined;
  current: TaskEventRow[];
  gates: EventDetail[];
  failedGates: string[];
  mergeReturns: string[];
  conflicts: number;
  incidents: string[];
  passed: boolean;
  gateReturnCount: number;
};
function windowOf(row: DeliveryRow, events: TaskEventRow[]): WindowFacts {
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
  return {
    untilNext,
    current,
    gates,
    failedGates,
    mergeReturns,
    conflicts,
    incidents,
    passed: gates.some((d) => d.passed === true),
    gateReturnCount: gates.filter(
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
  };
}
const firstPassOf = (row: DeliveryRow, w: WindowFacts): boolean | null =>
  row.ended_at === null
    ? null
    : w.passed &&
      w.failedGates.length === 0 &&
      w.mergeReturns.length === w.conflicts;
/**
 * 交付统计只需要一小组事实（#t123）：交给 SQL 读、不在 JS 里回表。逐字段与原 Delivery 一致，
 * 但不用任务标题、简报等大字段，也不为每条交付单独查事件、用量、岗位。
 */
export type DeliveryMetric = {
  id: number;
  task_id: number;
  worker: string;
  tool: string;
  model: string | null;
  job_id: number | null;
  job_name: string | null;
  ended_at: number | null;
  first_pass: boolean | null;
  duration_ms: number | null;
  gate_return_count: number;
  merge_return_count: number;
  incident_count: number;
};
/** 五类事故各自占一位；用位图去重，避免同一类重复计数。 */
const INCIDENT_BITS: Record<string, number> = {
  卡死: 1,
  思考耗尽: 2,
  "没开 PR": 4,
  虚报: 8,
  越界: 16,
};
const popcount = (n: number) => {
  let count = 0;
  for (let x = n; x; x &= x - 1) count++;
  return count;
};
export function ensureDeliveryRecords(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_deliveries(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    start_event_id INTEGER NOT NULL UNIQUE,
    worker TEXT NOT NULL,
    tool TEXT NOT NULL,
    model TEXT,
    effort TEXT,
    job_id INTEGER,
    risk TEXT,
    part_id INTEGER,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    outcome TEXT,
    final_outcome TEXT,
    historical INTEGER NOT NULL DEFAULT 0,
    job_rev INTEGER,
    job_checks TEXT,
    first_pass INTEGER,
    gate_return_count INTEGER NOT NULL DEFAULT 0,
    merge_return_count INTEGER NOT NULL DEFAULT 0,
    incident_count INTEGER NOT NULL DEFAULT 0,
    incident_flags INTEGER NOT NULL DEFAULT 0,
    gate_passed INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER)`);
  const columns = new Set(
    all<{ name: string }>(db, "PRAGMA table_info(task_deliveries)").map(
      (x) => x.name,
    ),
  );
  for (const [name, ddl] of [
    ["job_rev", "ALTER TABLE task_deliveries ADD COLUMN job_rev INTEGER"],
    ["job_checks", "ALTER TABLE task_deliveries ADD COLUMN job_checks TEXT"],
    [
      "final_outcome",
      "ALTER TABLE task_deliveries ADD COLUMN final_outcome TEXT",
    ],
  ] as const)
    if (!columns.has(name)) db.exec(ddl);
  // 统计事实（#t123）：旧库在这里补列；此后由 applyDeliveryEvent 增量维护。
  if (!columns.has("first_pass"))
    db.exec(`ALTER TABLE task_deliveries ADD COLUMN first_pass INTEGER;
      ALTER TABLE task_deliveries ADD COLUMN gate_return_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE task_deliveries ADD COLUMN merge_return_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE task_deliveries ADD COLUMN incident_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE task_deliveries ADD COLUMN incident_flags INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE task_deliveries ADD COLUMN gate_passed INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE task_deliveries ADD COLUMN duration_ms INTEGER`);
  // 索引统一放在补列之后：旧库先有表，缺的列补好再建引用它们的索引。
  db.exec(`CREATE INDEX IF NOT EXISTS task_deliveries_worker ON task_deliveries(tool,model,effort,job_id,id);
  CREATE INDEX IF NOT EXISTS task_deliveries_task ON task_deliveries(task_id,id);
  -- 交付统计按 worker / job 过滤：开头的索引让查询只碰命中的行，不扫整张表。
  CREATE INDEX IF NOT EXISTS task_deliveries_worker_id ON task_deliveries(worker,job_id,id);
  CREATE INDEX IF NOT EXISTS task_deliveries_job_id ON task_deliveries(job_id,id);
  -- 「某执行者最近几条」用 worker,id 直接倒序取，不再走 (worker,job_id,id) 触发排序。
  CREATE INDEX IF NOT EXISTS task_deliveries_worker_seq ON task_deliveries(worker,id);
  -- 统计与中位耗时只用这些列：覆盖索引让无过滤的聚合也不回表读整行。
  CREATE INDEX IF NOT EXISTS task_deliveries_facts ON task_deliveries(worker,job_id,ended_at,first_pass,duration_ms,gate_return_count,merge_return_count,incident_count,tool,model);
  -- 按专员过滤的统计同理，job_id 打头才走得进覆盖索引。
  CREATE INDEX IF NOT EXISTS task_deliveries_job_facts ON task_deliveries(job_id,ended_at,first_pass,duration_ms,gate_return_count,merge_return_count,incident_count,worker,tool,model);
  -- 启动时只补「已结束但没事实」的少数行；部分索引让这次检查不随交付数变慢。
  CREATE INDEX IF NOT EXISTS task_deliveries_missing_facts ON task_deliveries(id) WHERE ended_at IS NOT NULL AND duration_ms IS NULL;
  DROP INDEX IF EXISTS task_deliveries_stats;
  DROP INDEX IF EXISTS task_deliveries_med_worker;
  DROP INDEX IF EXISTS task_deliveries_med_model;
  DROP INDEX IF EXISTS task_deliveries_med_tool;`);
}
/**
 * 写入一条任务事件后同步交付事实（#t123）：只碰最近一轮交付，只认统计相关的事件，
 * 其余直接返回，不查库。这是交付事实的唯一增量维护点。
 */
export function applyDeliveryEvent(
  db: DatabaseSync,
  taskId: number,
  kind: string,
  rawDetail: unknown,
) {
  const parsed =
    rawDetail && typeof rawDetail === "object" && !Array.isArray(rawDetail)
      ? (rawDetail as EventDetail)
      : (() => {
          try {
            const x = JSON.parse(String(rawDetail ?? "null")) as unknown;
            return x && typeof x === "object" && !Array.isArray(x)
              ? (x as EventDetail)
              : {};
          } catch {
            return {};
          }
        })();
  const d = parsed;
  const innerDetail =
    d.detail && typeof d.detail === "object" && !Array.isArray(d.detail)
      ? (d.detail as EventDetail)
      : {};
  const reason = text(innerDetail.reason) ?? "";
  let bit = 0;
  if (kind === "stalled" || /卡死/.test(reason)) bit |= INCIDENT_BITS["卡死"]!;
  if (kind === "thinking_retry") bit |= INCIDENT_BITS["思考耗尽"]!;
  if (/worker_guard|worker-guard/.test(kind)) bit |= INCIDENT_BITS["越界"]!;
  let gateReturn = 0,
    gatePassed = 0,
    mergeReturn = 0;
  if (kind === "gates") {
    const results = Array.isArray(d.results) ? d.results : [];
    let failed = false;
    for (const x of results) {
      if (!x || typeof x !== "object" || Array.isArray(x)) continue;
      const r = x as EventDetail;
      if (r.ok === false && r.pending !== true) {
        failed = true;
        if ((text(r.gate) ?? "").startsWith("claims_verified"))
          bit |= INCIDENT_BITS["虚报"]!;
      }
      if (r.gate === "pr_exists" && r.ok === false)
        bit |= INCIDENT_BITS["没开 PR"]!;
    }
    if (failed) gateReturn = 1;
    if (d.passed === true) gatePassed = 1;
  } else if (kind === "merge_returned" || kind === "merge_blocked") {
    if (!isRebaseConflict(text(d.reason) ?? "合入队列退回")) mergeReturn = 1;
  }
  if (!bit && !gateReturn && !gatePassed && !mergeReturn) return;
  const row = one<{
    id: number;
    ended_at: number | null;
    first_pass: number | null;
    gate_passed: number;
    gate_return_count: number;
    merge_return_count: number;
    incident_count: number;
    incident_flags: number;
  }>(
    db,
    "SELECT id,ended_at,first_pass,gate_passed,gate_return_count,merge_return_count,incident_count,incident_flags FROM task_deliveries WHERE task_id=? ORDER BY id DESC LIMIT 1",
    taskId,
  );
  if (!row) return;
  const incident_flags = row.incident_flags | bit;
  const incident_count =
    row.incident_count + popcount(bit & ~row.incident_flags);
  const gate_passed = row.gate_passed || gatePassed ? 1 : 0;
  const gate_return_count = row.gate_return_count + gateReturn;
  const merge_return_count = row.merge_return_count + mergeReturn;
  const first_pass =
    row.ended_at === null
      ? row.first_pass
      : gate_passed === 1 && gate_return_count === 0 && merge_return_count === 0
        ? 1
        : 0;
  db.prepare(
    "UPDATE task_deliveries SET first_pass=?,gate_passed=?,gate_return_count=?,merge_return_count=?,incident_count=?,incident_flags=? WHERE id=?",
  ).run(
    first_pass,
    gate_passed,
    gate_return_count,
    merge_return_count,
    incident_count,
    incident_flags,
    row.id,
  );
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
  const previous = one<{
    id: number;
    worker: string;
    final_outcome: string | null;
    started_at: number;
    ended_at: number | null;
    gate_passed: number;
    gate_return_count: number;
    merge_return_count: number;
  }>(
    db,
    "SELECT id,worker,final_outcome,started_at,ended_at,gate_passed,gate_return_count,merge_return_count FROM task_deliveries WHERE task_id=? ORDER BY id DESC LIMIT 1",
    task.id,
  );
  if (
    previous &&
    previous.worker !== worker &&
    previous.final_outcome !== "merged" &&
    previous.final_outcome !== "cancelled"
  ) {
    const endedAt = previous.ended_at ?? at;
    db.prepare(
      "UPDATE task_deliveries SET final_outcome='switched',ended_at=?,outcome=COALESCE(outcome,'switched'),duration_ms=?,first_pass=? WHERE id=?",
    ).run(
      endedAt,
      Math.max(0, endedAt - previous.started_at),
      previous.gate_passed === 1 &&
        previous.gate_return_count === 0 &&
        previous.merge_return_count === 0
        ? 1
        : 0,
      previous.id,
    );
  }
  db.prepare(
    "INSERT OR IGNORE INTO task_deliveries(task_id,start_event_id,worker,tool,model,effort,job_id,risk,part_id,started_at,historical,job_rev,job_checks) VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?)",
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
    "SELECT job_checks FROM task_deliveries WHERE task_id=? ORDER BY id DESC LIMIT 1",
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
    "UPDATE task_deliveries SET ended_at=?,outcome=?,final_outcome=?,duration_ms=MAX(0,?-started_at),first_pass=CASE WHEN gate_passed=1 AND gate_return_count=0 AND merge_return_count=0 THEN 1 ELSE 0 END WHERE id=(SELECT id FROM task_deliveries WHERE task_id=? AND ended_at IS NULL ORDER BY id DESC LIMIT 1)",
  ).run(at, outcome, outcome, at, taskId);
}
export function markDeliveryFinal(
  db: DatabaseSync,
  taskId: number,
  result: string,
) {
  db.prepare(
    "UPDATE task_deliveries SET final_outcome=? WHERE id=(SELECT id FROM task_deliveries WHERE task_id=? ORDER BY id DESC LIMIT 1)",
  ).run(result, taskId);
}
export type TaskLite = Pick<
  TaskRow,
  "id" | "title" | "status" | "delivery_stage"
>;
/** 读一条交付：从事件现算（事件不清理，交付事实一直查得到）。 */
export function deliveryFacts(
  row: DeliveryRow,
  task: TaskLite,
  events: TaskEventRow[],
  usage: { points: number; basis: string } | undefined,
  jobName: string | null,
): Delivery {
  const w = windowOf(row, events);
  const gateDiff = w.gates
    .map((d) => d.diff)
    .find((x) => !!x && typeof x === "object") as EventDetail | undefined;
  const diff = gateDiff
    ? {
        files: number(gateDiff.files) ?? 0,
        added: number(gateDiff.added) ?? 0,
        deleted: number(gateDiff.deleted) ?? number(gateDiff.removed) ?? 0,
      }
    : null;
  const notes = w.current
    .filter((e) => e.kind === "note")
    .map(detail)
    .filter((d) => ["ok", "fixed", "rejected"].includes(text(d.verdict) ?? ""));
  const lastNote = notes.at(-1);
  const merged =
    w.current.some((e) => e.kind === "merged") ||
    ((task.delivery_stage === "merged" || task.delivery_stage === "online") &&
      !w.untilNext);
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
              (w.untilNext && text(inner(w.untilNext).worker) !== row.worker)
            ? "换人"
            : row.final_outcome === "rebase_conflict"
              ? "变基冲突"
              : row.final_outcome === "returned"
                ? "合入退回"
                : !w.untilNext && task.status === "cancelled"
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
    gate_returns: w.failedGates,
    gate_return_count: w.gateReturnCount,
    merge_returns: w.mergeReturns.filter((r) => !isRebaseConflict(r)),
    rebase_conflicts: w.conflicts,
    incidents: w.incidents,
    first_pass: firstPassOf(row, w),
    merged,
    usage_points: usage?.basis === "unknown" ? null : (usage?.points ?? null),
    usage_basis: usage?.basis ?? null,
    verdict: text(lastNote?.verdict),
    verdict_note: text(lastNote?.text),
  };
}
function page<T>(items: readonly T[], size: number, fn: (slice: T[]) => void) {
  for (let i = 0; i < items.length; i += size) fn(items.slice(i, i + size));
}
const marksOf = (n: number) => Array.from({ length: n }, () => "?").join(",");
/** 交付统计的过滤条件：只写实际给的项，查询计划才用得上索引，也避免 `? IS NULL` 这种写法。 */
function deliveryWhere(filter: { worker?: string; job?: number }): {
  sql: string;
  params: SQLInputValue[];
} {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  if (filter.worker !== undefined) {
    clauses.push("worker=?");
    params.push(filter.worker);
  }
  if (filter.job !== undefined && filter.job !== null) {
    clauses.push("job_id=?");
    params.push(filter.job);
  }
  return {
    sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}
/** 展示交付事实要看的事件（比统计多 merged、note）。 */
const DISPLAY_EVENTS =
  "kind IN ('start','gates','merge_returned','merge_blocked','stalled','thinking_retry','merged','note') OR kind LIKE '%worker_guard%' OR kind LIKE '%worker-guard%' OR detail LIKE '%卡死%'";
function jobNamesOf(db: DatabaseSync, ids: readonly number[]) {
  const map = new Map<number, string>();
  page(ids, 200, (slice) => {
    for (const r of all<{ id: number; name: string }>(
      db,
      `SELECT id,name FROM job_roles WHERE id IN (${marksOf(slice.length)})`,
      ...slice,
    ))
      map.set(r.id, r.name);
  });
  return map;
}
function taskEventsFor(
  db: DatabaseSync,
  taskIds: readonly number[],
  kinds: string,
): TaskEventRow[] {
  const out: TaskEventRow[] = [];
  const sorted = [...taskIds].sort((a, b) => a - b);
  page(sorted, 200, (slice) => {
    out.push(
      ...all<TaskEventRow>(
        db,
        `SELECT id,task_id,kind,detail FROM task_events WHERE task_id IN (${marksOf(slice.length)}) AND (${kinds}) ORDER BY task_id,id`,
        ...slice,
      ),
    );
  });
  return out;
}
function allJobNames(db: DatabaseSync) {
  return new Map(
    all<{ id: number; name: string }>(db, "SELECT id,name FROM job_roles").map(
      (r) => [r.id, r.name],
    ),
  );
}
type StatScope = WorkerStat["scope"];
type StatFilter = { worker?: string; job?: number };
type StatOpts = { limitPerWorker?: number; roleNull?: boolean };
type StatCounts = {
  worker?: string;
  tool?: string;
  model?: string | null;
  job_id?: number | null;
  finished: number;
  rated: number;
  passes: number;
  returns_sum: number;
  incidents_sum: number;
};
const SCOPE_KEYS: Record<StatScope, readonly string[]> = {
  combination: ["worker", "job_id"],
  model: ["tool", "model", "job_id"],
  tool: ["tool", "job_id"],
};
const scopeKeys = (scope: StatScope, roleNull: boolean): string[] =>
  (roleNull
    ? SCOPE_KEYS[scope].filter((k) => k !== "job_id")
    : SCOPE_KEYS[scope]) as string[];
const keyOf = (...parts: readonly (string | number | null | undefined)[]) =>
  parts
    .map((p) => (p === null || p === undefined ? "" : String(p)))
    .join("\u0000");
/** 三种口径的分组键，与旧实现的分组口径一致（专员为空时不含 job_id）。 */
const comboKey = (worker: string, jobId: number | null) => keyOf(worker, jobId);
const modelKey = (tool: string, model: string | null, jobId: number | null) =>
  keyOf(tool, model, jobId);
const toolKey = (tool: string, jobId: number | null) => keyOf(tool, jobId);
const keysOf = (scope: StatScope, r: StatCounts, roleNull: boolean) => {
  const jobId = roleNull ? null : (r.job_id ?? null);
  return scope === "combination"
    ? comboKey(r.worker!, jobId)
    : scope === "model"
      ? modelKey(r.tool!, r.model ?? null, jobId)
      : toolKey(r.tool!, jobId);
};
/** 统计的来源与过滤：limitPerWorker 时只看每位执行者最近若干条（子查询有界）。 */
function statSource(
  filter: StatFilter,
  opts: StatOpts,
): { from: string; where: string; params: SQLInputValue[] } {
  if (opts.limitPerWorker !== undefined)
    return {
      from: "(SELECT * FROM task_deliveries WHERE worker=? ORDER BY id DESC LIMIT ?)",
      where: "",
      params: [
        filter.worker ?? "",
        Math.max(1, Math.min(opts.limitPerWorker, 1000)),
      ],
    };
  const conds: string[] = [];
  const params: SQLInputValue[] = [];
  if (filter.worker !== undefined) {
    conds.push("worker=?");
    params.push(filter.worker);
  }
  if (filter.job !== undefined && filter.job !== null) {
    conds.push("job_id=?");
    params.push(filter.job);
  }
  return {
    from: "task_deliveries",
    where: conds.length ? `WHERE ${conds.join(" AND ")}` : "",
    params,
  };
}
/**
 * 一组统计的次数：次数、一次通过、退回、事故全在库里按组算（#t123），不读交付明细。
 */
function countRows(
  db: DatabaseSync,
  scope: StatScope,
  filter: StatFilter,
  opts: StatOpts,
): StatCounts[] {
  const select = scopeKeys(scope, opts.roleNull === true).join(",");
  const { from, where, params } = statSource(filter, opts);
  return all<StatCounts>(
    db,
    `SELECT ${select},
       SUM(CASE WHEN ended_at IS NOT NULL THEN 1 ELSE 0 END) AS finished,
       SUM(CASE WHEN ended_at IS NOT NULL AND first_pass IS NOT NULL THEN 1 ELSE 0 END) AS rated,
       SUM(CASE WHEN ended_at IS NOT NULL AND first_pass=1 THEN 1 ELSE 0 END) AS passes,
       SUM(CASE WHEN ended_at IS NOT NULL THEN gate_return_count + merge_return_count ELSE 0 END) AS returns_sum,
       SUM(CASE WHEN ended_at IS NOT NULL THEN incident_count ELSE 0 END) AS incidents_sum
     FROM ${from} ${where}
     GROUP BY ${select}`,
    ...params,
  );
}
const medianOf = (values: number[]): number | null => {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const n = values.length;
  return n % 2
    ? values[(n - 1) / 2]!
    : (values[n / 2 - 1]! + values[n / 2]!) / 2;
};
/**
 * 中位耗时（#t123）：只取每组的耗时列（worker/tool/model/job_id + duration_ms），一次读完，
 * 按三种口径各归一次组取中位；不读交付明细，也不读简报。这是 review 允许的两种取法之一。
 */
function medianByScope(
  db: DatabaseSync,
  filter: StatFilter,
  opts: StatOpts,
): Record<StatScope, Map<string, number | null>> {
  const roleNull = opts.roleNull === true;
  const { from, where, params } = statSource(filter, opts);
  const clause = where
    ? `${where} AND duration_ms IS NOT NULL`
    : "WHERE duration_ms IS NOT NULL";
  const rows = all<{
    worker: string;
    tool: string;
    model: string | null;
    job_id: number | null;
    duration_ms: number;
  }>(
    db,
    `SELECT worker,tool,model,job_id,duration_ms FROM ${from} ${clause}`,
    ...params,
  );
  // 用嵌套 Map（键都是原始值）归组，避免给每条交付拼三次字符串键。
  const combo = new Map<string, Map<number, number[]>>();
  const byTool = new Map<string, Map<number, number[]>>();
  const model = new Map<string, Map<string, Map<number, number[]>>>();
  const push = (
    map: Map<string, Map<number, number[]>>,
    first: string,
    job: number,
    dur: number,
  ) => {
    let jobs = map.get(first);
    if (!jobs) map.set(first, (jobs = new Map()));
    const list = jobs.get(job);
    if (list) list.push(dur);
    else jobs.set(job, [dur]);
  };
  for (const r of rows) {
    const job = roleNull ? -1 : (r.job_id ?? -1);
    push(combo, r.worker, job, r.duration_ms);
    push(byTool, r.tool, job, r.duration_ms);
    let models = model.get(r.tool);
    if (!models) model.set(r.tool, (models = new Map()));
    const mk = r.model ?? "";
    let jobs = models.get(mk);
    if (!jobs) models.set(mk, (jobs = new Map()));
    const list = jobs.get(job);
    if (list) list.push(r.duration_ms);
    else jobs.set(job, [r.duration_ms]);
  }
  const jobOf = (job: number) => (roleNull || job < 0 ? null : job);
  const out = {} as Record<StatScope, Map<string, number | null>>;
  const comboMap = new Map<string, number | null>();
  for (const [worker, jobs] of combo)
    for (const [job, list] of jobs)
      comboMap.set(comboKey(worker, jobOf(job)), medianOf(list));
  out.combination = comboMap;
  const toolMap = new Map<string, number | null>();
  for (const [tool, jobs] of byTool)
    for (const [job, list] of jobs)
      toolMap.set(toolKey(tool, jobOf(job)), medianOf(list));
  out.tool = toolMap;
  const modelMap = new Map<string, number | null>();
  for (const [tool, models] of model)
    for (const [mk, jobs] of models)
      for (const [job, list] of jobs)
        modelMap.set(
          modelKey(tool, mk === "" ? null : mk, jobOf(job)),
          medianOf(list),
        );
  out.model = modelMap;
  return out;
}
const statSort = (a: WorkerStat, b: WorkerStat) =>
  (a.role ?? "").localeCompare(b.role ?? "") ||
  a.scope.localeCompare(b.scope) ||
  a.worker.localeCompare(b.worker);
/**
 * 交付统计（#t123）：次数、一次通过率、平均退回次数、事故数用 SQL GROUP BY 算，
 * 中位耗时只取每组的耗时列；不逐条读交付或事件，也不读简报等大字段。
 */
export function workerStats(
  db: DatabaseSync,
  filter: StatFilter = {},
  opts: StatOpts = {},
): WorkerStat[] {
  const jobNames = allJobNames(db);
  const roleNull = opts.roleNull === true;
  const medians = medianByScope(db, filter, opts);
  const stats: WorkerStat[] = [];
  for (const scope of ["combination", "model", "tool"] as const) {
    for (const r of countRows(db, scope, filter, opts)) {
      const jobId = roleNull ? null : (r.job_id ?? null);
      const worker =
        scope === "combination"
          ? r.worker!
          : scope === "model"
            ? r.model
              ? `${r.tool}+${r.model}`
              : r.tool!
            : r.tool!;
      const key = keysOf(scope, r, roleNull);
      const finished = Number(r.finished ?? 0);
      const rated = Number(r.rated ?? 0);
      stats.push({
        scope,
        worker,
        role: jobId === null ? null : (jobNames.get(jobId) ?? null),
        deliveries: finished,
        first_pass_rate: rated ? Number(r.passes ?? 0) / rated : null,
        average_returns: finished ? Number(r.returns_sum) / finished : 0,
        median_ms: medians[scope].get(key) ?? null,
        incidents: Number(r.incidents_sum),
        low_data: finished < 5,
        trust: null,
      });
    }
  }
  return stats.sort(statSort);
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
  const { sql: base, params } = deliveryWhere(filter);
  while (rows.length < limit) {
    const clause = base ? `${base} AND id<?` : "WHERE id<?";
    const batch = all<DeliveryRow>(
      db,
      `SELECT ${DELIVERY_COLUMNS} FROM task_deliveries ${clause} ORDER BY id DESC LIMIT ?`,
      ...params,
      before,
      Math.min(200, limit - rows.length),
    );
    rows.push(...batch);
    if (batch.length < 200 || rows.length >= limit) break;
    before = batch.at(-1)!.id;
  }
  if (!rows.length) return [];
  const taskIds = [...new Set(rows.map((r) => r.task_id))].sort(
    (a, b) => a - b,
  );
  const liveIds = taskIds;
  const taskMap = new Map<number, TaskLite>();
  page(taskIds, 200, (slice) => {
    for (const t of all<TaskLite>(
      db,
      `SELECT id,title,status,delivery_stage FROM tasks WHERE id IN (${marksOf(slice.length)})`,
      ...slice,
    ))
      taskMap.set(t.id, t);
  });
  const jobMap = jobNamesOf(
    db,
    rows.map((r) => r.job_id).filter((x): x is number => x !== null),
  );
  const eventsByTask = new Map<number, TaskEventRow[]>();
  for (const event of taskEventsFor(db, liveIds, DISPLAY_EVENTS)) {
    const list = eventsByTask.get(event.task_id) ?? [];
    list.push(event);
    eventsByTask.set(event.task_id, list);
  }
  const usageByTask = new Map<number, UsageLite[]>();
  page(liveIds, 200, (slice) => {
    for (const u of all<UsageLite>(
      db,
      `SELECT task_id,started_at,points,basis FROM task_usage WHERE task_id IN (${marksOf(slice.length)})`,
      ...slice,
    )) {
      const list = usageByTask.get(u.task_id) ?? [];
      list.push(u);
      usageByTask.set(u.task_id, list);
    }
  });
  return rows.flatMap((row) => {
    const task = taskMap.get(row.task_id);
    if (!task) return [];
    return [
      deliveryFacts(
        row,
        task,
        eventsByTask.get(row.task_id) ?? [],
        pickUsage(usageByTask.get(row.task_id), row),
        row.job_id === null ? null : (jobMap.get(row.job_id) ?? null),
      ),
    ];
  });
}
type UsageLite = {
  task_id: number;
  started_at: number;
  points: number;
  basis: string;
};
function pickUsage(
  list: readonly UsageLite[] | undefined,
  row: DeliveryRow,
): { points: number; basis: string } | undefined {
  if (!list?.length) return undefined;
  const threshold = row.started_at - 2000;
  let best: UsageLite | undefined;
  for (const u of list)
    if (u.started_at >= threshold && (!best || u.started_at < best.started_at))
      best = u;
  return best ? { points: best.points, basis: best.basis } : undefined;
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
/** 与 summarizeDeliveries 同一算法，但吃的是 SQL 取好的小事实，不用整条交付。 */
export function summarizeMetrics(
  rows: readonly DeliveryMetric[],
  trust: ReadonlyMap<string, string> = new Map(),
): WorkerStat[] {
  const groups = new Map<
    string,
    {
      scope: WorkerStat["scope"];
      worker: string;
      role: string | null;
      rows: DeliveryMetric[];
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
              (n, r) => n + r.gate_return_count + r.merge_return_count,
              0,
            ) / finished.length
          : 0,
        median_ms: mid,
        incidents: finished.reduce((n, r) => n + r.incident_count, 0),
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
/** 旧入口：用手上的整条交付折成统计事实，结果与 summarizeMetrics 一致。 */
export function summarizeDeliveries(
  rows: readonly Delivery[],
  trust: ReadonlyMap<string, string> = new Map(),
): WorkerStat[] {
  return summarizeMetrics(
    rows.map((d) => ({
      id: d.id,
      task_id: d.task_id,
      worker: d.worker,
      tool: d.tool,
      model: d.model,
      job_id: d.job_id,
      job_name: d.job_name,
      ended_at: d.ended_at,
      first_pass: d.first_pass,
      duration_ms: d.duration_ms,
      gate_return_count: d.gate_return_count,
      merge_return_count: d.merge_returns.length,
      incident_count: d.incidents.length,
    })),
    trust,
  );
}
