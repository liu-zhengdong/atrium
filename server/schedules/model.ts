import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { all, nodeByAddress, nodes, one, ref } from "../org/model.ts";
import { briefText } from "../tasks/brief.ts";
import { parseWorker, workerId } from "../tasks/profiles.ts";
import {
  atText,
  everyText,
  firstDue,
  isKind,
  isOpen,
  localOffset,
  parseAt,
  parseEvery,
  type Offset,
  type ScheduleKind,
} from "./plan.ts";

/**
 * 周期任务的账（#404 第 1 步）：schedules 一条一行，sN 用 AUTOINCREMENT 不复用，删掉只标 removed_at；
 * schedule_runs 记每轮的结果（生成、跳过、失败），每条只留最近 RUNS_KEPT 条。旧运行时没有同名表。
 */
export function ensureScheduleTables(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT, node_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('task','patrol','research')),
    every_ms INTEGER NOT NULL, at_minute INTEGER,
    brief TEXT, brief_path TEXT, by TEXT, worker TEXT,
    next_at INTEGER NOT NULL, removed_at INTEGER,
    last_task_id INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS schedules_live ON schedules(next_at)
      WHERE removed_at IS NULL;
    CREATE TABLE IF NOT EXISTS schedule_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, schedule_id INTEGER NOT NULL,
      at INTEGER NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('created','skipped','failed')),
      task_id INTEGER, note TEXT);
    CREATE INDEX IF NOT EXISTS schedule_runs_schedule ON schedule_runs(schedule_id,id);
    CREATE INDEX IF NOT EXISTS schedule_runs_task ON schedule_runs(task_id);`);
}

export const RUNS_KEPT = 20;

export type ScheduleRow = {
  id: number;
  node_id: number;
  title: string;
  kind: ScheduleKind;
  every_ms: number;
  at_minute: number | null;
  brief: string | null;
  brief_path: string | null;
  by: string | null;
  worker: string | null;
  next_at: number;
  removed_at: number | null;
  last_task_id: number | null;
  created_at: number;
  updated_at: number;
};
export type RunRow = {
  id: number;
  schedule_id: number;
  at: number;
  outcome: "created" | "skipped" | "failed";
  task_id: number | null;
  note: string | null;
};

export const scheduleRef = (id: number) => `s${id}`;

export function parseScheduleRef(value: unknown): number {
  const match =
    typeof value === "string" ? /^s([1-9]\d{0,9})$/.exec(value) : null;
  if (!match) throw new Problem(400, "周期任务短号应为 s1 这样的格式", "usage");
  return Number(match[1]);
}

export function scheduleRow(db: DatabaseSync, reference: unknown) {
  const id = parseScheduleRef(reference);
  const row = one<ScheduleRow>(db, "SELECT * FROM schedules WHERE id=?", id);
  if (!row)
    throw new Problem(
      404,
      `周期任务 ${scheduleRef(id)} 不存在`,
      "not_found",
      undefined,
      "atrium schedule ls",
    );
  return row;
}

/** 还开着的（没删）才能改；删掉的只能看。 */
export function liveRow(db: DatabaseSync, reference: unknown) {
  const row = scheduleRow(db, reference);
  if (row.removed_at !== null)
    throw new Problem(409, `${scheduleRef(row.id)} 已删除`, "conflict");
  return row;
}

/** 上一轮还没结束的任务短号（todo / running / blocked）；没有为 null。 */
export function openTask(db: DatabaseSync, row: ScheduleRow): string | null {
  if (row.last_task_id === null) return null;
  const task = one<{ status: string }>(
    db,
    "SELECT status FROM tasks WHERE id=?",
    row.last_task_id,
  );
  return task && isOpen(task.status) ? `t${row.last_task_id}` : null;
}

export function recordRun(
  db: DatabaseSync,
  scheduleId: number,
  outcome: RunRow["outcome"],
  taskId: number | null,
  note: string | null,
  now = Date.now(),
) {
  const { lastInsertRowid } = db
    .prepare(
      "INSERT INTO schedule_runs(schedule_id,at,outcome,task_id,note) VALUES (?,?,?,?,?)",
    )
    .run(scheduleId, now, outcome, taskId, note);
  // 每条周期任务只留最近几轮，账不随时间增长。
  db.prepare(
    `DELETE FROM schedule_runs WHERE schedule_id=? AND id<=(
      SELECT id FROM schedule_runs WHERE schedule_id=? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
  ).run(scheduleId, scheduleId, RUNS_KEPT);
  return Number(lastInsertRowid);
}

const textOf = (value: unknown, key: string, max: number) => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !value.trim() || [...value].length > max)
    throw new Problem(400, `${key}: 应为 1～${max} 字`, "usage");
  return value.trim();
};

export type ScheduleInput = {
  node_id: number;
  title: string;
  kind: ScheduleKind;
  every_ms: number;
  at_minute: number | null;
  brief: string | null;
  brief_path: string | null;
  by: string | null;
  worker: string | null;
};

/** 校验请求体（不碰任务表）；节点、专员与详述能不能建出任务由调用方试建一次确认。 */
export function scheduleInput(db: DatabaseSync, raw: unknown): ScheduleInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Problem(400, "请求体应为 JSON 对象", "usage");
  const body = raw as Record<string, unknown>;
  const allowed = [
    "node",
    "title",
    "kind",
    "every",
    "at",
    "brief",
    "brief_path",
    "by",
    "worker",
  ];
  const extra = Object.keys(body).filter((key) => !allowed.includes(key));
  if (extra.length)
    throw new Problem(400, `不认识的字段：${extra.join("、")}`, "usage");
  const kind = body.kind === undefined ? "task" : body.kind;
  if (!isKind(kind))
    throw new Problem(400, "--kind: 只能是 task、patrol 或 research", "usage");
  if (typeof body.node !== "string" || !body.node.trim())
    throw new Problem(400, "节点: 必填，如 o2 或 atrium/cli", "usage");
  const node = nodeByAddress(db, body.node.trim());
  if (node.archived_at !== null)
    throw new Problem(409, `${ref(node.id)} 已归档`, "conflict");
  const every = parseEvery(body.every);
  const at =
    body.at === undefined || body.at === null || body.at === ""
      ? null
      : parseAt(body.at, every);
  const brief = briefText(body.brief, "--brief");
  const by = textOf(body.by, "--by", 100);
  if (kind === "patrol" && (brief || by))
    throw new Problem(
      400,
      "--kind patrol 按节点的 uses 场景轮换，不接 --brief、--by",
      "usage",
    );
  const title =
    textOf(body.title, "标题", 200) ?? (kind === "patrol" ? "体验巡检" : null);
  if (!title) throw new Problem(400, "标题: 必填", "usage");
  const worker =
    typeof body.worker === "string" && body.worker.trim()
      ? workerId(parseWorker(body.worker))
      : null;
  if (body.worker !== undefined && body.worker !== null && !worker)
    throw new Problem(400, "--worker: 应为 工具+模型[:强度]", "usage");
  return {
    node_id: node.id,
    title,
    kind,
    every_ms: every,
    at_minute: at,
    brief,
    brief_path: brief ? textOf(body.brief_path, "brief_path", 1000) : null,
    by,
    worker,
  };
}

export function insertSchedule(
  db: DatabaseSync,
  input: ScheduleInput,
  now = Date.now(),
  offset: Offset = localOffset,
) {
  const { lastInsertRowid } = db
    .prepare(
      "INSERT INTO schedules(node_id,title,kind,every_ms,at_minute,brief,brief_path,by,worker,next_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      input.node_id,
      input.title,
      input.kind,
      input.every_ms,
      input.at_minute,
      input.brief,
      input.brief_path,
      input.by,
      input.worker,
      firstDue(now, input.every_ms, input.at_minute, offset),
      now,
      now,
    );
  return Number(lastInsertRowid);
}

/** 删掉只标记：sN 不复用，已生成的任务照常。 */
export function removeSchedule(db: DatabaseSync, reference: unknown) {
  const row = liveRow(db, reference);
  db.prepare("UPDATE schedules SET removed_at=?,updated_at=? WHERE id=?").run(
    Date.now(),
    Date.now(),
    row.id,
  );
  return row.id;
}

export type ScheduleView = ReturnType<typeof scheduleView>;

function scheduleView(
  row: ScheduleRow,
  names: ReadonlyMap<number, string>,
  last: { ref: string; status: string } | null,
) {
  return {
    id: row.id,
    ref: scheduleRef(row.id),
    node: ref(row.node_id),
    node_name: names.get(row.node_id) ?? null,
    title: row.title,
    kind: row.kind,
    every: everyText(row.every_ms),
    at: row.at_minute === null ? null : atText(row.at_minute),
    by: row.by,
    worker: row.worker,
    has_brief: row.brief !== null,
    state: row.removed_at !== null ? ("removed" as const) : ("active" as const),
    next_at: row.removed_at !== null ? null : row.next_at,
    last_task: last,
    created_at: row.created_at,
  };
}

const namesOf = (db: DatabaseSync) =>
  new Map(nodes(db).map((node) => [node.id, node.name]));

/** 最近一轮任务及其状态：一条 IN 查询取回整页。 */
function lastTasks(db: DatabaseSync, rows: readonly ScheduleRow[]) {
  const ids = rows.flatMap((row) =>
    row.last_task_id === null ? [] : [row.last_task_id],
  );
  if (!ids.length) return new Map<number, string>();
  return new Map(
    all<{ id: number; status: string }>(
      db,
      `SELECT id,status FROM tasks WHERE id IN (${ids.map(() => "?").join(",")})`,
      ...ids,
    ).map((task) => [task.id, task.status]),
  );
}

const lastOf = (row: ScheduleRow, statuses: ReadonlyMap<number, string>) =>
  row.last_task_id === null
    ? null
    : {
        ref: `t${row.last_task_id}`,
        status: statuses.get(row.last_task_id) ?? "missing",
      };

export const LIST_LIMIT = 200;

/** 列表：缺省不列已删除的；按节点过滤时含下层部分；按 sN 游标分页。 */
export function listSchedules(
  db: DatabaseSync,
  query: { node?: string; all?: boolean; after?: number; limit?: number },
) {
  const limit = Math.min(Math.max(query.limit ?? LIST_LIMIT, 1), LIST_LIMIT);
  const list = nodes(db);
  let scope: number[] | null = null;
  if (query.node) {
    const root = nodeByAddress(db, query.node).id;
    const children = new Map<number, number[]>();
    for (const node of list) {
      if (node.parent_id === null) continue;
      const siblings = children.get(node.parent_id);
      if (siblings) siblings.push(node.id);
      else children.set(node.parent_id, [node.id]);
    }
    scope = [];
    const stack = [root];
    const seen = new Set<number>();
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      scope.push(id);
      stack.push(...(children.get(id) ?? []));
    }
  }
  const rows = all<ScheduleRow>(
    db,
    `SELECT * FROM schedules WHERE id>? ${query.all ? "" : "AND removed_at IS NULL"}
      ${scope ? `AND node_id IN (${scope.map(() => "?").join(",")})` : ""}
      ORDER BY id LIMIT ?`,
    query.after ?? 0,
    ...(scope ?? []),
    limit + 1,
  );
  const page = rows.slice(0, limit);
  const names = new Map(list.map((node) => [node.id, node.name]));
  const statuses = lastTasks(db, page);
  return {
    schedules: page.map((row) =>
      scheduleView(row, names, lastOf(row, statuses)),
    ),
    next_after: rows.length > limit ? scheduleRef(page.at(-1)!.id) : null,
  };
}

/** 单条：带详述全文与最近几轮的结果。 */
export function showSchedule(db: DatabaseSync, reference: unknown) {
  const row = scheduleRow(db, reference);
  const runs = all<RunRow>(
    db,
    "SELECT * FROM schedule_runs WHERE schedule_id=? ORDER BY id DESC LIMIT ?",
    row.id,
    RUNS_KEPT,
  );
  return {
    ...scheduleView(row, namesOf(db), lastOf(row, lastTasks(db, [row]))),
    brief: row.brief,
    brief_path: row.brief_path,
    runs: runs.map((run) => ({
      at: run.at,
      outcome: run.outcome,
      task: run.task_id === null ? null : `t${run.task_id}`,
      note: run.note,
    })),
  };
}

/** 到点的（没删除），按到点先后，一次至多 limit 条；暂停由调用方按 server/pause.ts 跳过。 */
export function dueSchedules(db: DatabaseSync, now: number, limit = 50) {
  return all<ScheduleRow>(
    db,
    "SELECT * FROM schedules WHERE removed_at IS NULL AND next_at<=? ORDER BY next_at,id LIMIT ?",
    now,
    limit,
  );
}
