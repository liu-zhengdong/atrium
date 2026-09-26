import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { isAbsolute } from "node:path";
import { Problem } from "../problem.ts";
import {
  FINISHED,
  TASK_STATUSES,
  isTaskStatus,
  transition,
  type TaskEvent,
  type TaskStatus,
} from "./state.ts";

/**
 * 任务账本（#262）。独立于 Store：每个函数显式接收数据库连接，全部参数化查询。
 * 对外短号是 t<id>；接口 JSON 字段与表列同名，另附 ref / parent_ref。
 */

export function ensureTaskTables(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_id INTEGER REFERENCES tasks(id),
      title TEXT NOT NULL,
      brief_path TEXT,
      role TEXT,
      repo TEXT,
      status TEXT NOT NULL CHECK(status IN ('todo','running','done','failed','blocked','cancelled')),
      worker TEXT,
      pid INTEGER, worktree TEXT, branch TEXT,
      pr_url TEXT, ci TEXT,
      result TEXT,
      created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_id,id);
    CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status,id);
    CREATE TABLE IF NOT EXISTS task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL,
      at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT);
    CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id,id);`);
  // 负责人（事件订阅者）是后加的列：老库补上，缺省交给秘书。
  const columns = all<{ name: string }>(db, "PRAGMA table_info(tasks)");
  if (!columns.some((column) => column.name === "owner"))
    db.exec("ALTER TABLE tasks ADD COLUMN owner TEXT");
}

/** 任务没写负责人时，事件交给秘书。 */
export const DEFAULT_OWNER = "secretary";
const OWNER_RE = /^[\p{L}\p{N}_.-]{1,60}$/u;
export function ownerOf(value: unknown, field = "owner") {
  if (typeof value !== "string" || !OWNER_RE.test(value.trim()))
    throw usage(`${field}: 订阅者名只能用字母、数字、_ . -，1～60 字`);
  return value.trim();
}

type TaskRow = {
  id: number;
  parent_id: number | null;
  title: string;
  brief_path: string | null;
  role: string | null;
  repo: string | null;
  status: TaskStatus;
  worker: string | null;
  pid: number | null;
  worktree: string | null;
  branch: string | null;
  pr_url: string | null;
  ci: string | null;
  result: string | null;
  owner: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  updated_at: number;
};
export type Task = TaskRow & { ref: string; parent_ref: string | null };
export type TaskNode = Task & { children: TaskNode[] };
export type TaskEventRow = {
  id: number;
  task_id: number;
  at: number;
  kind: string;
  detail: string | null;
};

export const taskRef = (id: number) => `t${id}`;
const view = (row: TaskRow): Task => ({
  ...row,
  ref: taskRef(row.id),
  parent_ref: row.parent_id === null ? null : taskRef(row.parent_id),
});

const TITLE_MAX = 200;
const TEXT_MAX = 4096;
export const RESULT_MAX_BYTES = 4096;
export const LIST_LIMIT = 200;
export const LIST_MAX = 500;
export const TREE_MAX = 2000;
const EVENTS_SHOWN = 50;

const usage = (message: string, next?: string) =>
  new Problem(400, message, "usage", undefined, next);

/** 接口与命令行都接受 t12 或 12；其余一律拒绝。 */
export function parseTaskRef(value: unknown, field = "id"): number {
  const text = typeof value === "number" ? String(value) : value;
  const match =
    typeof text === "string"
      ? /^t?([1-9][0-9]{0,15})$/.exec(text.trim())
      : null;
  const id = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(id))
    throw usage(`${field}: 任务短号应为 t1 这样的格式`);
  return id;
}

function one<T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]) {
  return db.prepare(sql).get(...params) as T | undefined;
}
function all<T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]) {
  return db.prepare(sql).all(...params) as T[];
}
export function atomically<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function row(db: DatabaseSync, id: number) {
  return one<TaskRow>(db, "SELECT * FROM tasks WHERE id=?", id);
}
function requireRow(db: DatabaseSync, id: number) {
  const found = row(db, id);
  if (!found)
    throw new Problem(
      404,
      `任务 ${taskRef(id)} 不存在`,
      "not_found",
      undefined,
      "atrium task ls",
    );
  return found;
}
function addEvent(
  db: DatabaseSync,
  id: number,
  at: number,
  kind: string,
  detail?: unknown,
) {
  db.prepare(
    "INSERT INTO task_events(task_id,at,kind,detail) VALUES (?,?,?,?)",
  ).run(
    id,
    at,
    kind,
    detail === undefined
      ? null
      : typeof detail === "string"
        ? detail
        : JSON.stringify(detail),
  );
}

// ---- 入口校验：HTTP 与领域函数共用这一处 ----

const optionalText = (value: unknown, field: string, max = TEXT_MAX) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw usage(`${field}: 应为文本`);
  const text = value.trim();
  if (!text) return null;
  if (text.length > max) throw usage(`${field}: 不能超过 ${max} 字`);
  return text;
};
const title = (value: unknown) => {
  if (typeof value !== "string" || !value.trim())
    throw usage("title: 标题不能为空");
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length > TITLE_MAX)
    throw usage(`title: 标题不能超过 ${TITLE_MAX} 字`);
  return text;
};
export const statusOf = (value: unknown, field = "status") => {
  if (!isTaskStatus(value))
    throw usage(`${field}: 只能是 ${TASK_STATUSES.join("、")}`);
  return value;
};
const repoOf = (value: unknown) => {
  const repo = optionalText(value, "repo");
  if (repo && !isAbsolute(repo)) throw usage("repo: 应为绝对路径");
  return repo;
};
const objectOf = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw usage("请求体应为 JSON 对象");
  return value as Record<string, unknown>;
};
const onlyKeys = (input: Record<string, unknown>, allowed: string[]) => {
  const extra = Object.keys(input).filter((key) => !allowed.includes(key));
  if (extra.length)
    throw usage(
      `不认识的字段：${extra.join("、")}；可用 ${allowed.join("、")}`,
    );
};
function parentOf(db: DatabaseSync, value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  const id = parseTaskRef(value, "parent");
  if (!row(db, id))
    throw usage(`parent: 父任务 ${taskRef(id)} 不存在`, "atrium task ls");
  return id;
}

export type NewTask = {
  title: string;
  parent?: string | number | null;
  role?: string | null;
  repo?: string | null;
  brief_path?: string | null;
  owner?: string | null;
};

export function createTask(
  db: DatabaseSync,
  body: unknown,
  now = Date.now(),
): Task {
  const input = objectOf(body);
  onlyKeys(input, ["title", "parent", "role", "repo", "brief_path", "owner"]);
  const values = {
    owner:
      input.owner === undefined || input.owner === null || input.owner === ""
        ? null
        : ownerOf(input.owner),
    title: title(input.title),
    role: optionalText(input.role, "role", 200),
    repo: repoOf(input.repo),
    brief_path: optionalText(input.brief_path, "brief_path"),
  };
  return atomically(db, () => {
    const parent = parentOf(db, input.parent);
    const { lastInsertRowid } = db
      .prepare(
        "INSERT INTO tasks(parent_id,title,brief_path,role,repo,owner,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'todo',?,?)",
      )
      .run(
        parent,
        values.title,
        values.brief_path,
        values.role,
        values.repo,
        values.owner,
        now,
        now,
      );
    const id = Number(lastInsertRowid);
    addEvent(db, id, now, "created", {
      title: values.title,
      ...(parent ? { parent: taskRef(parent) } : {}),
    });
    return view(requireRow(db, id));
  });
}

export function getTask(db: DatabaseSync, reference: unknown) {
  const found = requireRow(db, parseTaskRef(reference));
  const events = all<TaskEventRow>(
    db,
    "SELECT * FROM (SELECT * FROM task_events WHERE task_id=? ORDER BY id DESC LIMIT ?) ORDER BY id",
    found.id,
    EVENTS_SHOWN,
  );
  const children = one<{ n: number }>(
    db,
    "SELECT COUNT(*) AS n FROM tasks WHERE parent_id=?",
    found.id,
  )!.n;
  return { ...view(found), children, events };
}

export function listTasks(
  db: DatabaseSync,
  query: {
    parent?: unknown;
    status?: unknown;
    after?: unknown;
    limit?: unknown;
  },
) {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (query.parent !== undefined && query.parent !== "") {
    where.push("parent_id=?");
    params.push(parentOf(db, query.parent));
  }
  if (query.status !== undefined && query.status !== "") {
    where.push("status=?");
    params.push(statusOf(query.status));
  }
  if (query.after !== undefined && query.after !== "") {
    where.push("id>?");
    params.push(parseTaskRef(query.after, "after"));
  }
  let limit = LIST_LIMIT;
  if (query.limit !== undefined && query.limit !== "") {
    limit = Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > LIST_MAX)
      throw usage(`limit: 应为 1～${LIST_MAX} 的整数`);
  }
  const rows = all<TaskRow>(
    db,
    `SELECT * FROM tasks${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id LIMIT ?`,
    ...params,
    limit + 1,
  );
  const more = rows.length > limit;
  const tasks = rows.slice(0, limit).map(view);
  return { tasks, next_after: more ? tasks.at(-1)!.ref : null };
}

/** root 给定时返回那一棵；不给返回全部顶层任务组成的森林。超出上限标 truncated。 */
export function taskTree(db: DatabaseSync, root?: unknown) {
  const rootId =
    root === undefined || root === "" ? null : parseTaskRef(root, "root");
  if (rootId !== null) requireRow(db, rootId);
  const rows = all<TaskRow>(
    db,
    `WITH RECURSIVE sub(id) AS (
       SELECT id FROM tasks WHERE ${rootId === null ? "parent_id IS NULL" : "id=?"}
       UNION ALL SELECT t.id FROM tasks t JOIN sub ON t.parent_id=sub.id)
     SELECT t.* FROM tasks t JOIN sub USING(id) ORDER BY t.id LIMIT ?`,
    ...(rootId === null ? [] : [rootId]),
    TREE_MAX + 1,
  );
  const truncated = rows.length > TREE_MAX;
  const nodes = new Map<number, TaskNode>();
  for (const found of rows.slice(0, TREE_MAX))
    nodes.set(found.id, { ...view(found), children: [] });
  const roots: TaskNode[] = [];
  // 按 id 升序：父任务总比子任务先建，先出现。
  for (const node of nodes.values()) {
    const parent =
      node.parent_id === null || node.id === rootId
        ? undefined
        : nodes.get(node.parent_id);
    if (parent) parent.children.push(node);
    else if (node.parent_id === null || node.id === rootId) roots.push(node);
  }
  return { tasks: roots, truncated };
}

/** 人工修正：title / brief_path / role / status；status 经状态机的 manual_set。 */
export function updateTask(
  db: DatabaseSync,
  reference: unknown,
  body: unknown,
  now = Date.now(),
): Task {
  const id = parseTaskRef(reference);
  const input = objectOf(body);
  onlyKeys(input, ["title", "brief_path", "role", "status"]);
  if (!Object.keys(input).length)
    throw usage("至少修改一项：title、brief_path、role、status");
  const fields: Record<string, string | null> = {};
  if ("title" in input) fields.title = title(input.title);
  if ("brief_path" in input)
    fields.brief_path = optionalText(input.brief_path, "brief_path");
  if ("role" in input) fields.role = optionalText(input.role, "role", 200);
  const target = "status" in input ? statusOf(input.status) : undefined;
  return atomically(db, () => {
    const current = requireRow(db, id);
    const changed = Object.fromEntries(
      Object.entries(fields).filter(
        ([key, value]) => current[key as keyof TaskRow] !== value,
      ),
    );
    if (Object.keys(changed).length) {
      db.prepare(
        `UPDATE tasks SET ${Object.keys(changed)
          .map((key) => `${key}=?`)
          .join(",")},updated_at=? WHERE id=?`,
      ).run(...Object.values(changed), now, id);
      addEvent(db, id, now, "edited", changed);
    }
    if (target !== undefined)
      applyTransition(db, current, { kind: "manual_set", to: target }, now);
    return view(requireRow(db, id));
  });
}

/** 执行者这一侧可以随状态一起写入的运行字段。 */
export type RunFields = Partial<
  Pick<
    TaskRow,
    "worker" | "pid" | "worktree" | "branch" | "pr_url" | "ci" | "result"
  >
>;
const RUN_FIELDS = [
  "worker",
  "pid",
  "worktree",
  "branch",
  "pr_url",
  "ci",
  "result",
] as const;

/** 结果摘要只留末尾 4 KB（按 UTF-8 字节，不切断字符）。 */
export function clipResult(text: string) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= RESULT_MAX_BYTES) return text;
  let start = bytes.length - RESULT_MAX_BYTES;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
}

function applyTransition(
  db: DatabaseSync,
  current: TaskRow,
  event: TaskEvent,
  now: number,
  fields: RunFields = {},
  detail?: unknown,
) {
  const next = transition(current.status, event);
  if (!next.ok)
    throw new Problem(
      409,
      `${taskRef(current.id)}：${next.reason}`,
      "conflict",
      undefined,
      `atrium task show ${taskRef(current.id)}`,
    );
  const sets: string[] = [];
  const params: SQLInputValue[] = [];
  for (const key of RUN_FIELDS)
    if (key in fields) {
      sets.push(`${key}=?`);
      const value = fields[key] ?? null;
      params.push(
        key === "result" && typeof value === "string"
          ? clipResult(value)
          : value,
      );
    }
  if (next.changed) {
    sets.push("status=?");
    params.push(next.status);
    if (next.status === "running") {
      sets.push("started_at=?", "ended_at=NULL");
      params.push(now);
    }
    if (FINISHED.has(next.status)) {
      sets.push("ended_at=?");
      params.push(now);
    }
    if (next.status === "todo" || next.status === "blocked")
      sets.push("ended_at=NULL");
  }
  if (sets.length) {
    db.prepare(
      `UPDATE tasks SET ${sets.join(",")},updated_at=? WHERE id=?`,
    ).run(...params, now, current.id);
  }
  if (next.changed || sets.length)
    addEvent(db, current.id, now, event.kind, {
      from: current.status,
      to: next.status,
      ...(detail === undefined ? {} : { detail }),
    });
  return next.status;
}

/**
 * 给执行者一侧（run / stop / 退出回收 / 重启自愈）用：按事件转移并一并写运行字段。
 * 拒绝时抛 409，数据不变。
 */
export function advanceTask(
  db: DatabaseSync,
  reference: unknown,
  event: TaskEvent,
  fields: RunFields = {},
  detail?: unknown,
  now = Date.now(),
): Task {
  const id = parseTaskRef(reference);
  return atomically(db, () => {
    applyTransition(db, requireRow(db, id), event, now, fields, detail);
    return view(requireRow(db, id));
  });
}

/** 只改运行字段、不改状态（如 CI 轮询写回 ci），并记一条事件。 */
export function patchRunFields(
  db: DatabaseSync,
  reference: unknown,
  fields: RunFields,
  kind: string,
  detail?: unknown,
  now = Date.now(),
): Task {
  const id = parseTaskRef(reference);
  return atomically(db, () => {
    requireRow(db, id);
    const keys = RUN_FIELDS.filter((key) => key in fields);
    if (keys.length)
      db.prepare(
        `UPDATE tasks SET ${keys.map((key) => `${key}=?`).join(",")},updated_at=? WHERE id=?`,
      ).run(
        ...keys.map((key) => {
          const value = fields[key] ?? null;
          return key === "result" && typeof value === "string"
            ? clipResult(value)
            : value;
        }),
        now,
        id,
      );
    addEvent(db, id, now, kind, detail);
    return view(requireRow(db, id));
  });
}

/** 只记事件、不改状态（如日志里发现 PR）。 */
export function noteTask(
  db: DatabaseSync,
  reference: unknown,
  kind: string,
  detail?: unknown,
  now = Date.now(),
) {
  const id = parseTaskRef(reference);
  requireRow(db, id);
  addEvent(db, id, now, kind, detail);
}
