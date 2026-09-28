import type { DatabaseSync } from "node:sqlite";
import { all, one } from "../org/model.ts";
import {
  listLeaders,
  showLeader,
  type LeaderView,
  type LeaderWake,
} from "../leaders/model.ts";
import { eventWord } from "../leaders/wake.ts";
import { peopleNames, personOf, type Person } from "./who.ts";
import { listDecisions, parseLimit, searchTerms } from "../memos/decisions.ts";
import { readMemo, MEMO_MAX } from "../memos/store.ts";

/**
 * 全景里的负责人（leader）：组织根的「负责人」页签与负责人页（#a1），另有秘书页（#secretary）。
 * 只读：负责哪些部分、用什么执行者、现在在处理什么、备忘、决定记录、最近处理过的事与上交记录。
 * 事件来自事件队列（task_inbox）：投给它的「要处理」事件，与它上交出去的事件。
 */

export type LeaderEventState = "waiting" | "doing" | "done" | "handed_off";
export type MapLeaderEvent = {
  id: number;
  at: number;
  task: { ref: string; title: string } | null;
  /** 人话类型：完成、失败、上线、上交… */
  what: string;
  /** 事件里的原因或说明（一行以内）。 */
  why: string | null;
  /** 下层 leader 上交上来的：谁交的。 */
  from: Person | null;
  count: number;
  state: LeaderEventState;
};
export type MapEscalation = {
  id: number;
  at: number;
  kind: string;
  label: string;
  task: { ref: string; title: string } | null;
  note: string;
  to: Person;
  /** 对方已确认（处理过）。 */
  seen: boolean;
};
export type MapLeaderRow = {
  ref: string;
  name: string;
  worker: string;
  nodes: (LeaderView["nodes"][number] & { alias: string })[];
  wake: LeaderWake | null;
  /** 投给它、还没处理的事（不含过程通知）。 */
  pending: number;
};
/**
 * 备忘与决定记录：用户页、秘书页与负责人页共用。决定只给摘要（原则 + 最近的，t211），
 * 全部与检索走 /api/map/decisions。
 */
type MemoPart = {
  memo: string;
  memo_max: number;
  memo_updated_at: number | null;
};
export type MapLeader = MapLeaderRow &
  MemoPart & {
    kind: "leader";
    events: MapLeaderEvent[];
    escalations: MapEscalation[];
  };
export type MapSecretary = MemoPart & {
  kind: "secretary" | "user";
  ref: "secretary" | "u1";
  name: string;
};

type InboxRow = {
  id: number;
  subscriber: string;
  task_id: number | null;
  source: string;
  kind: string;
  dedupe_key: string;
  detail: string | null;
  count: number;
  created_at: number;
  updated_at: number;
  acked_at: number | null;
  actor: string | null;
  delivered_at: number | null;
  level: string | null;
};

const EVENTS_MAX = 30;
const ESCALATIONS_MAX = 20;

const hasInbox = (db: DatabaseSync) =>
  !!one(
    db,
    "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='task_inbox'",
  );

const parse = (text: string | null): Record<string, unknown> => {
  try {
    const value: unknown = text === null ? null : JSON.parse(text);
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};
const text = (value: unknown, max = 200) => {
  if (typeof value !== "string" || !value.trim()) return null;
  const line = value.replace(/\s+/g, " ").trim();
  const chars = Array.from(line);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : line;
};

function aliases(db: DatabaseSync): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of all<{ node_id: number; fields: string }>(
    db,
    "SELECT node_id,fields FROM org_docs WHERE doc='charter' LIMIT 600",
  )) {
    const alias = text(parse(row.fields).alias, 40);
    if (alias) map.set(`o${row.node_id}`, alias);
  }
  return map;
}

function titles(db: DatabaseSync, ids: number[]): Map<number, string> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  return new Map(
    all<{ id: number; title: string }>(
      db,
      `SELECT id,title FROM tasks WHERE id IN (${unique.map(() => "?").join(",")}) LIMIT ${unique.length}`,
      ...unique,
    ).map((r) => [r.id, r.title]),
  );
}

/** 投给它、还没处理的「要处理」事件数；封顶 99。级别在 SQL 里过滤（#t126），不把知会读出来再丢。 */
function pendingCount(db: DatabaseSync, leader: string) {
  if (!hasInbox(db)) return 0;
  return all<{ kind: string; detail: string | null }>(
    db,
    "SELECT kind,detail FROM task_inbox WHERE subscriber=? AND acked_at IS NULL AND (actor IS NULL OR actor<>subscriber) AND level='action' ORDER BY id DESC LIMIT 200",
    leader,
  ).length;
}

const rowOf = (
  view: LeaderView,
  db: DatabaseSync,
  alias: ReadonlyMap<string, string>,
): MapLeaderRow => ({
  ref: view.ref,
  name: view.name,
  worker: view.worker,
  nodes: view.nodes.map((n) => ({ ...n, alias: alias.get(n.ref) ?? "" })),
  wake: view.wake,
  pending: Math.min(99, pendingCount(db, view.ref)),
});

/** 组织根「负责人」页签：全部已登记的 leader。 */
export function mapLeaders(db: DatabaseSync) {
  const alias = aliases(db);
  return {
    leaders: listLeaders(db).leaders.map((v) => rowOf(v, db, alias)),
  };
}

/** 事件的处理状态：确认过的看有没有转交记录，送达没确认的是在处理，其余在等。 */
export function eventState(
  row: Pick<InboxRow, "acked_at" | "delivered_at">,
  handedOff: boolean,
): LeaderEventState {
  if (row.acked_at !== null) return handedOff ? "handed_off" : "done";
  return row.delivered_at !== null ? "doing" : "waiting";
}

function events(
  db: DatabaseSync,
  leader: string,
  names: ReadonlyMap<string, string>,
): MapLeaderEvent[] {
  const rows = all<InboxRow>(
    db,
    "SELECT * FROM task_inbox WHERE subscriber=? AND (actor IS NULL OR actor<>subscriber) AND level='action' ORDER BY updated_at DESC,id DESC LIMIT 200",
    leader,
  )
    .map((row) => ({ row, detail: parse(row.detail) }))
    .slice(0, EVENTS_MAX);
  // 它没处理完、由运行时转交上一层的：转交事件的去重键是原键加 :handoff，转交与确认在同一刻。
  const handoffs = all<{ dedupe_key: string; updated_at: number }>(
    db,
    "SELECT dedupe_key,updated_at FROM task_inbox WHERE source='leader' AND dedupe_key LIKE '%:handoff' AND json_extract(detail,'$.handoff.from')=? ORDER BY id DESC LIMIT 200",
    leader,
  );
  const handedOff = (row: InboxRow) =>
    row.acked_at !== null &&
    handoffs.some(
      (h) =>
        h.dedupe_key === `${row.dedupe_key}:handoff` &&
        Math.abs(h.updated_at - row.acked_at!) < 60_000,
    );
  const title = titles(
    db,
    rows.flatMap(({ row }) => (row.task_id === null ? [] : [row.task_id])),
  );
  return rows.map(({ row, detail }) => {
    const from = typeof detail.from === "string" ? detail.from : null;
    return {
      id: row.id,
      at: row.updated_at,
      task:
        row.task_id === null
          ? null
          : {
              ref: `t${row.task_id}`,
              title:
                title.get(row.task_id) ??
                text(detail.title, 120) ??
                "（已删除）",
            },
      what:
        row.kind === "escalated" && typeof detail.kind_label === "string"
          ? `上交：${detail.kind_label}`
          : eventWord(row.kind),
      why: text(detail.reason) ?? text(detail.note),
      from: row.kind === "escalated" && from ? personOf(from, names) : null,
      count: row.count,
      state: eventState(row, handedOff(row)),
    };
  });
}

function escalations(
  db: DatabaseSync,
  leader: string,
  names: ReadonlyMap<string, string>,
): MapEscalation[] {
  const rows = all<InboxRow>(
    db,
    `SELECT * FROM task_inbox WHERE source='leader' AND kind='escalated' AND actor=? ORDER BY id DESC LIMIT ${ESCALATIONS_MAX}`,
    leader,
  );
  const title = titles(
    db,
    rows.flatMap((r) => (r.task_id === null ? [] : [r.task_id])),
  );
  return rows.map((row) => {
    const detail = parse(row.detail);
    return {
      id: row.id,
      at: row.created_at,
      kind: typeof detail.kind === "string" ? detail.kind : "",
      label: typeof detail.kind_label === "string" ? detail.kind_label : "上交",
      task:
        row.task_id === null
          ? null
          : {
              ref: `t${row.task_id}`,
              title: title.get(row.task_id) ?? "（已删除）",
            },
      note: text(detail.reason, 600) ?? "",
      to: personOf(row.subscriber, names),
      seen: row.acked_at !== null,
    };
  });
}

function memoPart(db: DatabaseSync, owner: string): MemoPart {
  const memo = readMemo(db, owner);
  return {
    memo: memo.body,
    memo_max: MEMO_MAX,
    memo_updated_at: memo.updated_at,
  };
}

/** 用户页、秘书页与负责人页：u1 是用户，secretary 是秘书；aN 没登记时 404（与 leader show 同一个报错）。 */
export function mapLeader(
  db: DatabaseSync,
  reference: string,
): MapLeader | MapSecretary {
  if (reference === "secretary")
    return {
      kind: "secretary",
      ref: "secretary",
      name: "秘书",
      ...memoPart(db, "secretary"),
    };
  if (reference === "u1")
    return { kind: "user", ref: "u1", name: "你", ...memoPart(db, "u1") };
  const view = showLeader(db, reference);
  const names = peopleNames(db);
  const inbox = hasInbox(db);
  return {
    kind: "leader",
    ...rowOf(view, db, aliases(db)),
    ...memoPart(db, view.ref),
    events: inbox ? events(db, view.ref, names) : [],
    escalations: inbox ? escalations(db, view.ref, names) : [],
  };
}

/**
 * 网页的决定记录：of 是 oN 时只列挂在本块及上级的，否则列全部（决定记录只有用户那一份）；
 * q 给了按关键词检索；all 连已推翻的一起列；before 接着上一页往下。
 */
export function mapDecisions(
  db: DatabaseSync,
  query: Record<string, string | undefined>,
) {
  const of = (query.of ?? "").trim();
  return {
    of,
    ...listDecisions(db, {
      node: /^o[1-9][0-9]{0,8}$/.test(of) ? of : undefined,
      all: query.all === "1",
      before: query.before,
      limit: parseLimit(query.limit),
      terms: searchTerms(query.q),
    }),
  };
}
