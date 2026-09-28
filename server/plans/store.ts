import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { all, nodeByAddress, nodes, one, ref } from "../org/model.ts";
import { contextOf } from "../map/context.ts";
import { taskDir } from "../tasks/active.ts";
import { clipBrief } from "../tasks/brief.ts";
import { atomically, createTask, getTask, type Task } from "../tasks/ledger.ts";
import { parseTaskRef, taskRef } from "../tasks/ledger-model.ts";
import { taskPartId } from "../leaders/subscriber.ts";
import { specialistsForTask } from "../tasks/specialist-scope.ts";
import {
  itemBrief,
  orderedItems,
  pickSpecialists,
  parsePlan,
  partVerdict,
  PLAN_FILE,
  PLAN_FILE_MAX,
  planBrief,
  validatePlan,
  type Plan,
} from "./model.ts";

/**
 * 规划任务的账（t275）：`task_plans` 一件规划任务一行，记给哪件总任务规划、任务完成时读到的清单或错误、
 * 采纳（建了哪些子任务）或驳回。规划任务是总任务下的帮手子任务（不让总任务因它变成「有子任务」），
 * 不交 PR、不带仓库（不建 worktree），执行者在任务目录的 work 下写 plan.json，只在本机跑。旧运行时没有同名表。
 */
export function ensurePlanTables(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_plans (
    task_id INTEGER PRIMARY KEY, target_id INTEGER NOT NULL,
    plan TEXT, error TEXT, settled_at INTEGER,
    decision TEXT, decided_at INTEGER, decided_by TEXT, note TEXT,
    adopted TEXT, created_by TEXT, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS task_plans_target ON task_plans(target_id,task_id);`);
  ready.add(db);
}

const ready = new WeakSet<DatabaseSync>();
/** 表在不在（任务运行时单测不建这张表）；建过就记住。 */
function hasPlans(db: DatabaseSync) {
  if (ready.has(db)) return true;
  const ok = !!one(
    db,
    "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='task_plans'",
  );
  if (ok) ready.add(db);
  return ok;
}

type PlanRow = {
  task_id: number;
  target_id: number;
  plan: string | null;
  error: string | null;
  settled_at: number | null;
  decision: "adopted" | "rejected" | null;
  decided_at: number | null;
  decided_by: string | null;
  note: string | null;
  adopted: string | null;
  created_by: string | null;
  created_at: number;
};

const rowOf = (db: DatabaseSync, taskId: number) =>
  one<PlanRow>(db, "SELECT * FROM task_plans WHERE task_id=?", taskId);

/** 这件任务是不是规划任务。 */
export function isPlanTask(db: DatabaseSync, taskId: number) {
  return hasPlans(db) && !!rowOf(db, taskId);
}

const usage = (message: string, next?: string) =>
  new Problem(400, message, "usage", undefined, next);

/** 规划请求：可选的执行者。 */
export function planInput(raw: unknown): { worker: string | undefined } {
  if (raw === undefined || raw === null) return { worker: undefined };
  if (typeof raw !== "object" || Array.isArray(raw))
    throw usage("请求体应为 JSON 对象");
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body))
    if (key !== "worker") throw usage(`${key}: 是未知字段`);
  if (body.worker === undefined || body.worker === null || body.worker === "")
    return { worker: undefined };
  if (typeof body.worker !== "string" || !body.worker.trim())
    throw usage("--worker: 应为 工具+模型[:强度]");
  return { worker: body.worker.trim() };
}

export type PlanStatus =
  "planning" | "failed" | "ready" | "adopted" | "rejected";

function statusOf(row: PlanRow, task: Pick<Task, "status">): PlanStatus {
  if (row.decision === "adopted") return "adopted";
  if (row.decision === "rejected") return "rejected";
  if (row.plan !== null) return "ready";
  if (row.error !== null) return "failed";
  if (task.status === "failed" || task.status === "cancelled") return "failed";
  return "planning";
}

/** 总任务上还没了结的规划（在规划或清单待采纳）；没有为 undefined。 */
function openPlan(db: DatabaseSync, targetId: number) {
  for (const row of all<PlanRow>(
    db,
    "SELECT * FROM task_plans WHERE target_id=? AND decision IS NULL AND error IS NULL ORDER BY task_id DESC LIMIT 20",
    targetId,
  )) {
    const status = statusOf(row, getTask(db, taskRef(row.task_id)));
    if (status === "planning" || status === "ready") return { row, status };
  }
  return undefined;
}

/** 给总任务建规划任务（不派）：已有没了结的规划报冲突；总任务已结束的不再规划。 */
export function createPlanTask(
  db: DatabaseSync,
  reference: unknown,
  by: string | undefined,
  now = Date.now(),
): Task {
  ensurePlanTables(db);
  const target = getTask(db, reference);
  if (target.status === "done" || target.status === "cancelled")
    throw new Problem(
      409,
      `${target.ref} 已${target.status === "done" ? "完成" : "取消"}，不再规划`,
      "conflict",
    );
  if (target.helper)
    throw usage(
      `${target.ref} 是运行时建的帮手任务（审查、会审意见、规划），不规划`,
    );
  const open = openPlan(db, target.id);
  if (open)
    throw new Problem(
      409,
      `${target.ref} 已有规划 ${taskRef(open.row.task_id)}（${open.status === "ready" ? "清单待采纳" : "在规划"}）`,
      "conflict",
      undefined,
      open.status === "ready"
        ? `atrium task adopt-plan ${taskRef(open.row.task_id)} --dry-run`
        : `atrium task wait ${taskRef(open.row.task_id)}`,
    );
  const part = taskPartId(db, target);
  const partNode =
    part === null ? undefined : nodes(db).find((n) => n.id === part);
  const children = all<{ id: number; title: string; status: string }>(
    db,
    "SELECT id,title,status FROM tasks WHERE parent_id=? AND helper=0 ORDER BY id LIMIT 50",
    target.id,
  );
  const brief = one<{ brief: string | null }>(
    db,
    "SELECT brief FROM tasks WHERE id=?",
    target.id,
  )?.brief;
  const specialists = specialistsForTask(db, {
    part,
    also: [],
  }).specialists.map((s) => ({ name: s.name, description: s.description }));
  return atomically(db, () => {
    const task = createTask(
      db,
      {
        title: `规划：${Array.from(target.title).slice(0, 190).join("")}`,
        brief: clipBrief(
          planBrief({
            target: {
              ref: target.ref,
              title: target.title,
              brief: brief ?? null,
              repo: target.repo,
            },
            part: partNode
              ? { ref: ref(partNode.id), name: partNode.name }
              : null,
            context: part === null ? "" : contextOf(db, part).text,
            children: children.map((c) => ({
              ref: taskRef(c.id),
              title: c.title,
              status: c.status,
            })),
            specialists,
          }),
        ),
        deliver: "none",
        parent: target.ref,
      },
      now,
      by,
      { helper: true },
    );
    db.prepare(
      "INSERT INTO task_plans(task_id,target_id,created_by,created_at) VALUES (?,?,?,?)",
    ).run(task.id, target.id, by ?? null, now);
    return task;
  });
}

/** 执行者写清单的位置（没有仓库的任务在任务目录的 work 下干活）。 */
export const planFileOf = (data: string, taskId: number) =>
  join(taskDir(data, taskId), "work", PLAN_FILE);

function readPlanFile(file: string): string | null | { error: string } {
  try {
    if (statSync(file).size > PLAN_FILE_MAX)
      return { error: `${PLAN_FILE} 超过 ${PLAN_FILE_MAX / 1024} KB` };
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export type PlanSettled = {
  kind: "plan_ready" | "plan_failed";
  detail: Record<string, unknown>;
};

/**
 * 规划任务完成（done）时读工作目录里的清单，校验后存进账里：好了投 plan_ready 请负责的 leader 采纳，
 * 读不到或不合格投 plan_failed（不挡任务完成）。不是规划任务返回 undefined；已读到过的不再读。
 */
export function settlePlan(
  db: DatabaseSync,
  data: string,
  taskId: number,
  now = Date.now(),
): PlanSettled | undefined {
  if (!hasPlans(db)) return undefined;
  const row = rowOf(db, taskId);
  // 已采纳或驳回的（规划还在跑时就驳回了）不再投「待采纳」。
  if (!row || row.decision !== null) return undefined;
  const plan = taskRef(taskId);
  const target = getTask(db, taskRef(row.target_id));
  const ready = (value: Plan): PlanSettled => ({
    kind: "plan_ready",
    detail: {
      title: target.title,
      target: target.ref,
      plan,
      tasks: value.tasks.length,
      summary: value.summary,
      next: `atrium task adopt-plan ${plan} --dry-run`,
    },
  });
  if (row.plan !== null) return ready(JSON.parse(row.plan) as Plan);
  const file = planFileOf(data, taskId);
  const raw = readPlanFile(file);
  const parsed =
    raw !== null && typeof raw === "object"
      ? { ok: false as const, error: raw.error }
      : parsePlan(raw);
  if (!parsed.ok) {
    db.prepare(
      "UPDATE task_plans SET error=?,settled_at=? WHERE task_id=?",
    ).run(parsed.error, now, taskId);
    return {
      kind: "plan_failed",
      detail: {
        title: target.title,
        target: target.ref,
        plan,
        plan_error: parsed.error,
        plan_file: file,
        next: `重新规划：atrium task plan-for ${target.ref}`,
      },
    };
  }
  db.prepare(
    "UPDATE task_plans SET plan=?,error=NULL,settled_at=? WHERE task_id=?",
  ).run(JSON.stringify(parsed.value), now, taskId);
  return ready(parsed.value);
}

export type PlanView = {
  plan: string;
  target: string;
  target_title: string;
  status: PlanStatus;
  /** 清单：执行者写的，或这次 --file 给的改过的。 */
  content: Plan | null;
  error: string | null;
  decided_at: number | null;
  decided_by: string | null;
  note: string | null;
  /** 采纳时建的子任务（代号 → 任务）。 */
  adopted: { key: string; ref: string; title: string; after: string[] }[];
  dry_run: boolean;
};

/** 按规划任务找；给的是总任务就取它最近的一份规划。 */
function locate(db: DatabaseSync, reference: string): PlanRow {
  ensurePlanTables(db);
  const id = parseTaskRef(reference, "任务");
  const direct = rowOf(db, id);
  if (direct) return direct;
  const latest = one<PlanRow>(
    db,
    "SELECT * FROM task_plans WHERE target_id=? ORDER BY task_id DESC LIMIT 1",
    id,
  );
  if (latest) return latest;
  getTask(db, reference);
  throw new Problem(
    404,
    `${taskRef(id)} 不是规划任务，也没有规划过`,
    "not_found",
    undefined,
    `atrium task plan-for ${taskRef(id)}`,
  );
}

function viewOf(
  db: DatabaseSync,
  row: PlanRow,
  content: Plan | null,
  dryRun: boolean,
): PlanView {
  const task = getTask(db, taskRef(row.task_id));
  const target = getTask(db, taskRef(row.target_id));
  let adopted: PlanView["adopted"] = [];
  try {
    adopted = row.adopted
      ? (JSON.parse(row.adopted) as PlanView["adopted"])
      : [];
  } catch {
    adopted = [];
  }
  return {
    plan: task.ref,
    target: target.ref,
    target_title: target.title,
    status: statusOf(row, task),
    content,
    error: row.error,
    decided_at: row.decided_at,
    decided_by: row.decided_by,
    note: row.note,
    adopted,
    dry_run: dryRun,
  };
}

const stored = (row: PlanRow) =>
  row.plan === null ? null : (JSON.parse(row.plan) as Plan);

export function showPlan(db: DatabaseSync, reference: string): PlanView {
  const row = locate(db, reference);
  return viewOf(db, row, stored(row), true);
}

function notReady(db: DatabaseSync, row: PlanRow, verb: string): Problem {
  const view = viewOf(db, row, stored(row), false);
  const plan = view.plan;
  if (view.status === "adopted" || view.status === "rejected")
    return new Problem(
      409,
      `${plan} 已${view.status === "adopted" ? "采纳" : "驳回"}（${view.decided_by ?? "?"}），不再${verb}`,
      "conflict",
      undefined,
      `atrium task tree ${view.target}`,
    );
  if (view.status === "failed")
    return new Problem(
      409,
      `${plan} 没出可用的清单：${view.error ?? "规划任务没做完"}`,
      "conflict",
      undefined,
      `atrium task plan-for ${view.target}`,
    );
  return new Problem(
    409,
    `${plan} 的清单还没好（规划任务在跑或在等）`,
    "conflict",
    undefined,
    `atrium task wait ${plan}`,
  );
}

/**
 * 看清单（dry_run）或采纳：按依赖先后在总任务下批量建子任务（详述带来源、建议的专员、依赖，开自动派），
 * 就绪的由排期巡检自动派出；plan 给了就用改过的清单（同样校验）。归属部分只能是总任务所在部分或其下。
 * 一件建不起来（专员不在范围、部分不对）整批不建。同一份规划只采纳一次。
 */
export function adoptPlan(
  db: DatabaseSync,
  reference: string,
  raw: unknown,
  actor: string,
  leader: string | undefined,
  now = Date.now(),
): PlanView {
  const row = locate(db, reference);
  if (
    raw !== undefined &&
    raw !== null &&
    (typeof raw !== "object" || Array.isArray(raw))
  )
    throw usage("请求体应为 JSON 对象");
  const body = (raw ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(body))
    if (!["plan", "dry_run"].includes(key)) throw usage(`${key}: 是未知字段`);
  let content = stored(row);
  if (body.plan !== undefined && body.plan !== null) {
    const edited = validatePlan(body.plan);
    if (!edited.ok) throw usage(`--file: ${edited.error}`);
    content = edited.value;
  }
  if (body.dry_run === true) return viewOf(db, row, content, true);
  if (row.decision !== null || row.plan === null)
    throw notReady(db, row, "采纳");
  const target = getTask(db, taskRef(row.target_id));
  if (target.status === "done" || target.status === "cancelled")
    throw new Problem(
      409,
      `${target.ref} 已${target.status === "done" ? "完成" : "取消"}，不再按规划建子任务`,
      "conflict",
    );
  const plan = content!;
  const home = taskPartId(db, target);
  const list = nodes(db);
  const parents = new Map(list.map((n) => [n.id, n.parent_id]));
  const parts = new Map<string, number>();
  for (const [index, item] of plan.tasks.entries()) {
    if (!item.part) continue;
    const node = nodeByAddress(db, item.part);
    const verdict = partVerdict({
      where: `tasks[${index}]（${item.key}）`,
      part: node.id,
      home,
      parents,
    });
    if (verdict) throw usage(verdict);
    parts.set(item.key, node.id);
  }
  const source = {
    target: target.ref,
    title: target.title,
    plan: taskRef(row.task_id),
    by: actor,
  };
  const deliver = target.deliver === "none" ? "none" : "pr";
  // 各件归属部分可请的专员（同一部分只算一次）；请不动的记进详述，不挡采纳。
  const scopes = new Map<number | null, { name: string; ref: string }[]>();
  const specialists = (part: number | null) => {
    if (!scopes.has(part))
      scopes.set(
        part,
        specialistsForTask(db, { part, also: [] }).specialists.map((s) => ({
          name: s.name,
          ref: s.ref,
        })),
      );
    return scopes.get(part)!;
  };
  atomically(db, () => {
    const refs = new Map<string, string>();
    const out: PlanView["adopted"] = [];
    for (const item of orderedItems(plan)) {
      const after = item.after.map((key) => refs.get(key)!);
      const part = parts.get(item.key);
      const picked = pickSpecialists(item, specialists(part ?? home));
      let task: Task;
      try {
        task = createTask(
          db,
          {
            title: item.title,
            brief: clipBrief(itemBrief(item, source, picked.dropped)),
            parent: target.ref,
            deliver,
            ...(target.repo ? { repo: target.repo } : {}),
            ...(part !== undefined ? { part: ref(part) } : {}),
            ...(picked.by ? { by: picked.by } : {}),
            ...(picked.ask.length ? { ask: picked.ask.join(",") } : {}),
            ...(after.length ? { after: after.join(",") } : {}),
            auto: true,
          },
          now,
          leader,
        );
      } catch (error) {
        if (error instanceof Problem)
          throw new Problem(
            error.statusCode,
            `清单 ${item.key}「${item.title}」建不起来：${error.message}；改了清单再采纳（--file），整批都没建`,
            error.code,
          );
        throw error;
      }
      refs.set(item.key, task.ref);
      out.push({ key: item.key, ref: task.ref, title: item.title, after });
    }
    db.prepare(
      "UPDATE task_plans SET decision='adopted',decided_at=?,decided_by=?,plan=?,adopted=? WHERE task_id=? AND decision IS NULL",
    ).run(now, actor, JSON.stringify(plan), JSON.stringify(out), row.task_id);
  });
  return viewOf(db, rowOf(db, row.task_id)!, plan, false);
}

/** 驳回：写明原因；要重来再 plan-for（可先捎话补充）。 */
export function rejectPlan(
  db: DatabaseSync,
  reference: string,
  raw: unknown,
  actor: string,
  now = Date.now(),
): PlanView {
  const row = locate(db, reference);
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw usage("请求体应为 JSON 对象");
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body))
    if (key !== "note") throw usage(`${key}: 是未知字段`);
  if (typeof body.note !== "string" || !body.note.trim())
    throw usage("--note: 写明为什么驳回（下次规划照着改）");
  const note = Array.from(body.note.trim()).slice(0, 2000).join("");
  if (row.decision !== null) throw notReady(db, row, "驳回");
  db.prepare(
    "UPDATE task_plans SET decision='rejected',decided_at=?,decided_by=?,note=? WHERE task_id=? AND decision IS NULL",
  ).run(now, actor, note, row.task_id);
  return viewOf(db, rowOf(db, row.task_id)!, stored(row), false);
}
