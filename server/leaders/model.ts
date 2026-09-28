import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import {
  all,
  nodePath,
  nodes,
  one,
  ref as nodeRef,
  transaction,
} from "../org/model.ts";
import { parseWorker, workerId } from "../tasks/workers/profiles.ts";
import {
  ensureMemoTables,
  MEMO_MAX,
  memoText,
  readMemo,
  readMemos,
  writeMemo,
  type Memo,
} from "../memos/store.ts";

export { MEMO_MAX, memoProblem } from "../memos/store.ts";

/**
 * leader 登记（#338 之后的 leader 层）：aN 是固定身份，存名称、执行者组合与最近一次唤醒。
 * 备忘与秘书的共用 memos 表（memos/store.ts）；org_leaders.memo 是早先的列，启动时迁过去后不再读写。
 * 负责哪些节点不在这里存，看 org_nodes.leader。短号全局一致、不复用：新号取登记过的与节点引用过的最大号加一。
 */

export const LEADER_RE = /^a([1-9][0-9]{0,8})$/;
export const NAME_MAX = 40;

export type WakeStatus = "running" | "done" | "failed" | "handed_off";

type Row = {
  id: number;
  name: string;
  worker: string;
  created_at: number;
  updated_at: number;
  wake_at: number | null;
  wake_ended_at: number | null;
  wake_status: WakeStatus | null;
  wake_summary: string | null;
  wake_note: string | null;
  wake_failures: number;
  wakes: number;
};

export type LeaderWake = {
  at: number;
  ended_at: number | null;
  status: WakeStatus;
  /** 这次在处理什么：事件一句话摘要。 */
  summary: string | null;
  /** 失败或转交的原因。 */
  note: string | null;
  failures: number;
  count: number;
};

export type LeaderView = {
  ref: string;
  name: string;
  worker: string;
  memo: string;
  memo_max: number;
  nodes: { ref: string; name: string; path: string }[];
  wake: LeaderWake | null;
  created_at: number;
  updated_at: number;
};

export function ensureLeaderTables(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS org_leaders (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    worker TEXT NOT NULL,
    memo TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    wake_at INTEGER, wake_ended_at INTEGER, wake_status TEXT,
    wake_summary TEXT, wake_note TEXT,
    wake_failures INTEGER NOT NULL DEFAULT 0,
    wakes INTEGER NOT NULL DEFAULT 0)`);
  ensureMemoTables(db);
}

const hasTable = (db: DatabaseSync, name: string) =>
  !!one(
    db,
    "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?",
    name,
  );

export const leaderRef = (id: number) => `a${id}`;

const usage = (message: string, next?: string) =>
  new Problem(400, message, "usage", undefined, next);

/** 解析 aN；格式不对是用法错误。 */
export function leaderId(value: unknown, field = "leader"): number {
  const text = typeof value === "string" ? value.trim() : "";
  const match = LEADER_RE.exec(text);
  if (!match)
    throw usage(`${field}: 应为 leader 短号，如 a1`, "atrium leader ls");
  return Number(match[1]);
}

function rowOf(db: DatabaseSync, id: number): Row | undefined {
  if (!hasTable(db, "org_leaders")) return undefined;
  return one<Row>(db, "SELECT * FROM org_leaders WHERE id=?", id);
}

/** 登记过的 leader；没登记报 404 并给登记命令。 */
export function requireLeader(db: DatabaseSync, value: unknown): Row {
  const id = leaderId(value);
  const row = rowOf(db, id);
  if (!row)
    throw new Problem(
      404,
      `${leaderRef(id)} 没有登记为 leader`,
      "not_found",
      undefined,
      `atrium leader add 名称 --worker claude+opus --id ${leaderRef(id)}`,
    );
  return row;
}

export const isRegistered = (db: DatabaseSync, leader: string) => {
  const match = LEADER_RE.exec(leader);
  return !!match && !!rowOf(db, Number(match[1]));
};

/** 已登记的全部 leader 短号。 */
export function registeredLeaders(db: DatabaseSync): Set<string> {
  if (!hasTable(db, "org_leaders")) return new Set();
  return new Set(
    all<{ id: number }>(
      db,
      "SELECT id FROM org_leaders ORDER BY id LIMIT 500",
    ).map((r) => leaderRef(r.id)),
  );
}

const nameOf = (value: unknown) => {
  if (typeof value !== "string" || !value.trim())
    throw usage("name: 名称不能为空");
  const text = value.replace(/\s+/g, " ").trim();
  if (Array.from(text).length > NAME_MAX)
    throw usage(`name: 名称至多 ${NAME_MAX} 字`);
  return text;
};

const workerOf = (value: unknown) => {
  if (typeof value !== "string" || !value.trim())
    throw usage("worker: 执行者组合不能为空，如 claude+opus:high");
  try {
    return workerId(parseWorker(value));
  } catch (error) {
    throw usage(`worker: ${(error as Error).message}`);
  }
};

const memoOf = (value: unknown, who: string) =>
  memoText(value, `atrium memo show --as ${who}`);

const objectOf = (body: unknown) => {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw usage("请求体应为对象");
  return body as Record<string, unknown>;
};
const onlyKeys = (input: Record<string, unknown>, keys: string[]) => {
  for (const key of Object.keys(input))
    if (!keys.includes(key)) throw usage(`${key}: 是未知字段`);
};

/** 下一个没用过的号：登记过的和节点上引用过的都算用过。 */
function nextId(db: DatabaseSync) {
  let max = 0;
  if (hasTable(db, "org_leaders"))
    max =
      one<{ n: number | null }>(db, "SELECT MAX(id) AS n FROM org_leaders")
        ?.n ?? 0;
  for (const n of nodes(db)) {
    const match = n.leader ? LEADER_RE.exec(n.leader) : null;
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

export function addLeader(db: DatabaseSync, body: unknown, now = Date.now()) {
  const input = objectOf(body);
  onlyKeys(input, ["name", "worker", "memo", "id"]);
  const name = nameOf(input.name);
  const worker = workerOf(input.worker);
  return transaction(db, () => {
    let id: number;
    if (input.id !== undefined && input.id !== null && input.id !== "") {
      id = leaderId(input.id, "id");
      if (rowOf(db, id))
        throw new Problem(
          409,
          `${leaderRef(id)} 已登记`,
          "conflict",
          undefined,
          `atrium leader ls ${leaderRef(id)}`,
        );
    } else id = nextId(db);
    const memo =
      input.memo === undefined ? "" : memoOf(input.memo, leaderRef(id));
    db.prepare(
      "INSERT INTO org_leaders(id,name,worker,created_at,updated_at) VALUES (?,?,?,?,?)",
    ).run(id, name, worker, now, now);
    if (memo) writeMemo(db, leaderRef(id), memo, now);
    return showLeader(db, leaderRef(id));
  });
}

export function editLeader(
  db: DatabaseSync,
  reference: unknown,
  body: unknown,
  now = Date.now(),
) {
  const row = requireLeader(db, reference);
  const input = objectOf(body);
  onlyKeys(input, ["name", "worker", "memo"]);
  if (!Object.keys(input).length)
    throw usage("至少改一项：--name、--worker 或 --memo");
  const name = input.name === undefined ? row.name : nameOf(input.name);
  const worker =
    input.worker === undefined ? row.worker : workerOf(input.worker);
  const memo =
    input.memo === undefined
      ? undefined
      : memoOf(input.memo, leaderRef(row.id));
  transaction(db, () => {
    db.prepare(
      "UPDATE org_leaders SET name=?,worker=?,updated_at=? WHERE id=?",
    ).run(name, worker, now, row.id);
    if (memo !== undefined) writeMemo(db, leaderRef(row.id), memo, now);
  });
  return showLeader(db, leaderRef(row.id));
}

const wakeOf = (row: Row): LeaderWake | null =>
  row.wake_at === null || row.wake_status === null
    ? null
    : {
        at: row.wake_at,
        ended_at: row.wake_ended_at,
        status: row.wake_status,
        summary: row.wake_summary,
        note: row.wake_note,
        failures: row.wake_failures,
        count: row.wakes,
      };

/** 每位 leader 负责的节点（未归档），按节点号。 */
function ledNodes(db: DatabaseSync) {
  const list = nodes(db);
  const map = new Map<string, LeaderView["nodes"]>();
  for (const n of list)
    if (n.leader && n.archived_at === null && LEADER_RE.test(n.leader))
      map.set(n.leader, [
        ...(map.get(n.leader) ?? []),
        { ref: nodeRef(n.id), name: n.name, path: nodePath(list, n) },
      ]);
  return map;
}

const viewOf = (
  row: Row,
  led: Map<string, LeaderView["nodes"]>,
  memo: Memo,
): LeaderView => ({
  ref: leaderRef(row.id),
  name: row.name,
  worker: row.worker,
  memo: memo.body,
  memo_max: MEMO_MAX,
  nodes: led.get(leaderRef(row.id)) ?? [],
  wake: wakeOf(row),
  created_at: row.created_at,
  updated_at: row.updated_at,
});

export function showLeader(db: DatabaseSync, reference: unknown): LeaderView {
  const row = requireLeader(db, reference);
  return viewOf(row, ledNodes(db), readMemo(db, leaderRef(row.id)));
}

/**
 * 全部 leader；节点上引用了但没登记的单列，提示登记。
 * busy 是正在处理的 leader 与一句话（状态栏读它：「Atrium 负责人 在处理 t84 上线」），空闲时为空数组。
 */
export function listLeaders(db: DatabaseSync) {
  const led = ledNodes(db);
  const rows = hasTable(db, "org_leaders")
    ? all<Row>(db, "SELECT * FROM org_leaders ORDER BY id LIMIT 500")
    : [];
  const known = new Set(rows.map((r) => leaderRef(r.id)));
  const memos = readMemos(db);
  const empty: Memo = { body: "", updated_at: null };
  return {
    leaders: rows.map((r) =>
      viewOf(r, led, memos.get(leaderRef(r.id)) ?? empty),
    ),
    busy: rows
      .filter((r) => r.wake_status === "running" && r.wake_at !== null)
      .map((r) => ({
        ref: leaderRef(r.id),
        name: r.name,
        doing: r.wake_summary ?? "",
        since: r.wake_at!,
      })),
    unregistered: [...led]
      .filter(([who]) => !known.has(who))
      .map(([who, list]) => ({ ref: who, nodes: list })),
  };
}

/** 视图（org tree、map、top）用的简要状态：名称与最近一次唤醒。 */
export type LeaderBrief = {
  ref: string;
  name: string;
  wake: LeaderWake | null;
};
export function leaderBriefs(db: DatabaseSync): Map<string, LeaderBrief> {
  const map = new Map<string, LeaderBrief>();
  if (!hasTable(db, "org_leaders")) return map;
  for (const row of all<Row>(
    db,
    "SELECT * FROM org_leaders ORDER BY id LIMIT 500",
  ))
    map.set(leaderRef(row.id), {
      ref: leaderRef(row.id),
      name: row.name,
      wake: wakeOf(row),
    });
  return map;
}

// ---- 唤醒记账（runtime 调用）----

export function markWakeStart(
  db: DatabaseSync,
  leader: string,
  summary: string,
  now = Date.now(),
) {
  db.prepare(
    "UPDATE org_leaders SET wake_at=?,wake_ended_at=NULL,wake_status='running',wake_summary=?,wake_note=NULL,wakes=wakes+1 WHERE id=?",
  ).run(now, summary, leaderId(leader));
}

export function markWakeEnd(
  db: DatabaseSync,
  leader: string,
  status: Exclude<WakeStatus, "running">,
  failures: number,
  note: string | null,
  now = Date.now(),
) {
  db.prepare(
    "UPDATE org_leaders SET wake_ended_at=?,wake_status=?,wake_failures=?,wake_note=? WHERE id=?",
  ).run(now, status, failures, note, leaderId(leader));
}

/** 服务重启时把上次没收尾的唤醒记成失败（进程已随旧服务停掉）。 */
export function closeStaleWakes(db: DatabaseSync, now = Date.now()) {
  if (!hasTable(db, "org_leaders")) return;
  db.prepare(
    "UPDATE org_leaders SET wake_ended_at=?,wake_status='failed',wake_note='服务重启，本次唤醒中断，事件稍后重投' WHERE wake_status='running'",
  ).run(now);
}

export const wakeFailures = (db: DatabaseSync, leader: string) =>
  rowOf(db, leaderId(leader))?.wake_failures ?? 0;
