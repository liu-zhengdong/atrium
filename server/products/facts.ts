import type { DatabaseSync } from "node:sqlite";
import { all, nodes, one, ref, type NodeRow } from "../org/model.ts";
import { charterFields } from "../org/write.ts";
import { overviewOf } from "../org/overview.ts";
import { SECRETARY } from "../leaders/route.ts";
import { partRoute } from "../leaders/subscriber.ts";
import { choicesForNodes } from "../choices/store.ts";
import {
  decisionLine,
  views,
  type Row as DecisionRow,
} from "../memos/decisions.ts";
import { dayLabel, localOffset, type Offset } from "../schedules/plan.ts";
import { oneLine } from "../text-width.ts";
import type { ResearchFacts } from "./brief.ts";
import type { ProductRow } from "./model.ts";

/**
 * 研究任务的材料（IO；排版在 brief.ts）：父节点的全景、它这一块的选项单与决定记录、
 * 巡检发现、近 30 天失败或被打回的任务与完成上线的任务。每类一条有界查询，不在循环里查库。
 * 范围是父节点及其下层，不含产品部（研究任务不算材料）。
 */

const DAYS_30 = 30 * 86_400_000;
const TASKS_SCANNED = 200;
const SHOWN = 20;

const hasTable = (db: DatabaseSync, name: string) =>
  !!one(
    db,
    "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?",
    name,
  );

/** 父节点及其下层（未归档），跳过各产品部（研究任务不算材料）；至多 200 个。 */
function scopeOf(
  list: readonly NodeRow[],
  rootId: number,
  skip: ReadonlySet<number>,
) {
  const children = new Map<number, NodeRow[]>();
  for (const n of list)
    if (n.parent_id !== null)
      children.set(n.parent_id, [...(children.get(n.parent_id) ?? []), n]);
  const out = [rootId];
  for (let i = 0; i < out.length && out.length < 200; i++)
    for (const c of children.get(out[i]!) ?? [])
      if (c.archived_at === null && !skip.has(c.id) && out.length < 200)
        out.push(c.id);
  return out;
}

const marks = (ids: readonly unknown[]) => ids.map(() => "?").join(",");

/**
 * 这一块的有效决定：挂在范围内节点上的（含选项单没选的），加上这一块 leader 没挂节点的；
 * 这一块没有 leader 时不带秘书的全局决定。已沉淀成要点的不再列（要点另有）。
 */
function decisionsOf(
  db: DatabaseSync,
  scope: readonly number[],
  leader: string | null,
): string[] {
  if (!hasTable(db, "decisions")) return [];
  const rows = all<DecisionRow>(
    db,
    `SELECT * FROM decisions
      WHERE superseded_by IS NULL AND settled_point IS NULL
        AND (id IN (SELECT decision_id FROM decision_nodes WHERE node_id IN (${marks(scope)}))${leader ? " OR (owner=? AND id NOT IN (SELECT decision_id FROM decision_nodes))" : ""})
      ORDER BY decided_on DESC,id DESC LIMIT ?`,
    ...scope,
    ...(leader ? [leader] : []),
    SHOWN,
  );
  return views(db, rows).map(decisionLine);
}

type TaskRow = {
  id: number;
  title: string;
  status: string;
  delivery_stage: string | null;
  release_version: string | null;
};
type EventRow = { task_id: number; kind: string; detail: string | null };

const SETBACK_EVENTS = [
  "exit_fail",
  "block",
  "merge_returned",
  "merge_blocked",
  "review_rejected",
];
const SETBACK_TEXT: Record<string, string> = {
  failed: "失败",
  blocked: "卡住",
  merge_returned: "合入时被打回",
  merge_blocked: "合入被挡",
  review_rejected: "审阅打回",
};

const reasonOf = (detail: string | null) => {
  try {
    const parsed = JSON.parse(detail ?? "{}") as { reason?: unknown };
    return typeof parsed.reason === "string" && parsed.reason.trim()
      ? oneLine(parsed.reason, 120)
      : null;
  } catch {
    return null;
  }
};

function tasksOf(db: DatabaseSync, scope: readonly number[], since: number) {
  const tasks = all<TaskRow>(
    db,
    `SELECT id,title,status,delivery_stage,release_version FROM tasks
      WHERE (part_id IN (${marks(scope)}) OR (part_id IS NULL AND node_id IN (${marks(scope)})))
        AND updated_at>=? ORDER BY updated_at DESC,id DESC LIMIT ?`,
    ...scope,
    ...scope,
    since,
    TASKS_SCANNED,
  );
  if (!tasks.length) return { setbacks: [], shipped: [] };
  const ids = tasks.map((t) => t.id);
  // 每件任务最近一次挫折（失败、卡住、打回）：一条 IN 查询，新的在前，取第一次见到的。
  const latest = new Map<number, EventRow>();
  for (const e of all<EventRow>(
    db,
    `SELECT task_id,kind,detail FROM task_events
      WHERE task_id IN (${marks(ids)}) AND kind IN (${marks(SETBACK_EVENTS)})
      ORDER BY id DESC LIMIT ?`,
    ...ids,
    ...SETBACK_EVENTS,
    ids.length * 4,
  ))
    if (!latest.has(e.task_id)) latest.set(e.task_id, e);
  const setbacks: ResearchFacts["setbacks"] = [];
  const shipped: ResearchFacts["shipped"] = [];
  for (const t of tasks) {
    const event = latest.get(t.id);
    const title = oneLine(t.title, 60);
    if (t.status === "failed" || t.status === "blocked")
      setbacks.push({
        ref: `t${t.id}`,
        title,
        what: SETBACK_TEXT[t.status]!,
        why: event ? reasonOf(event.detail) : null,
      });
    else if (
      event &&
      (event.kind === "merge_returned" || event.kind === "review_rejected")
    )
      setbacks.push({
        ref: `t${t.id}`,
        title,
        what: `${SETBACK_TEXT[event.kind]}（现在${t.status === "done" ? "已完成" : "还在做"}）`,
        why: reasonOf(event.detail),
      });
    if (t.status === "done")
      shipped.push({
        ref: `t${t.id}`,
        title,
        what:
          t.delivery_stage === "online"
            ? `已上线${t.release_version ? ` v${t.release_version}` : ""}`
            : t.delivery_stage === "merged"
              ? "已合入"
              : "已完成",
      });
  }
  return {
    setbacks: setbacks.slice(0, SHOWN),
    shipped: shipped.slice(0, SHOWN),
  };
}

/** 几个节点章程里的人话名：一条 IN 查询。 */
function aliasesOf(db: DatabaseSync, ids: readonly number[]) {
  const out = new Map<number, string>();
  if (!ids.length) return out;
  for (const r of all<{ node_id: number; fields: string }>(
    db,
    `SELECT node_id,fields FROM org_docs WHERE doc='charter' AND node_id IN (${marks(ids)})`,
    ...ids,
  ))
    try {
      const alias = (JSON.parse(r.fields) as { alias?: unknown }).alias;
      if (typeof alias === "string" && alias.trim())
        out.set(r.node_id, alias.trim());
    } catch {
      /* 坏字段不给人话名。 */
    }
  return out;
}

function findingsOf(db: DatabaseSync, scope: readonly number[]) {
  if (!hasTable(db, "patrol_findings")) return [];
  return all<{ id: number; phenomenon: string; kind: string; status: string }>(
    db,
    `SELECT id,phenomenon,kind,status FROM patrol_findings
      WHERE node_id IN (${marks(scope)}) ORDER BY id DESC LIMIT ?`,
    ...scope,
    SHOWN,
  ).map((f) => ({
    ref: `f${f.id}`,
    phenomenon: oneLine(f.phenomenon, 100),
    kind: f.kind,
    status: f.status,
  }));
}

export function researchFacts(
  db: DatabaseSync,
  product: ProductRow,
  now = Date.now(),
  offset: Offset = localOffset,
): ResearchFacts {
  const list = nodes(db);
  const byId = new Map(list.map((n) => [n.id, n]));
  const parent = byId.get(product.parent_id);
  const productNode = byId.get(product.node_id);
  const fields = parent ? charterFields(db, parent.id) : {};
  const overview = overviewOf(fields, []);
  const products = new Set(
    all<{ node_id: number }>(
      db,
      "SELECT node_id FROM products ORDER BY node_id LIMIT 500",
    ).map((r) => r.node_id),
  );
  products.add(product.node_id);
  const scope = parent ? scopeOf(list, parent.id, products) : [];
  const siblings = list
    .filter(
      (n) =>
        n.parent_id === product.parent_id &&
        n.archived_at === null &&
        n.id !== product.node_id &&
        n.kind !== "concern",
    )
    .slice(0, 20);
  const aliases = aliasesOf(
    db,
    siblings.map((n) => n.id),
  );
  const parts = siblings.map((n) => {
    const alias = aliases.get(n.id);
    return alias && alias !== n.name ? `${n.name}（${alias}）` : n.name;
  });
  const choices = scope.length
    ? choicesForNodes(db, scope, byId, 10).map((c) => ({
        ref: c.ref,
        title: oneLine(c.title, 60),
        status_text: c.status_text,
        open: c.status === "open",
        picked: c.options.filter((o) => o.picked === true).map((o) => o.title),
        skipped: c.options
          .filter((o) => o.picked === false)
          .map((o) => o.title),
        note: c.note ? oneLine(c.note, 120) : null,
      }))
    : [];
  const route = parent ? partRoute(db, parent.id).subscriber : SECRETARY;
  const { setbacks, shipped } = scope.length
    ? tasksOf(db, scope, now - DAYS_30)
    : { setbacks: [], shipped: [] };
  return {
    names: {
      parent: {
        ref: ref(product.parent_id),
        name: parent?.name ?? ref(product.parent_id),
        alias: overview.alias,
      },
      product: {
        ref: ref(product.node_id),
        name: productNode?.name ?? ref(product.node_id),
      },
    },
    date: dayLabel(now, offset),
    overview: {
      what: overview.what,
      uses: overview.uses,
      flow: overview.flow,
      now: overview.now,
      next: overview.next,
    },
    parts,
    choices,
    decisions: scope.length
      ? decisionsOf(db, scope, route === SECRETARY ? null : route)
      : [],
    findings: scope.length ? findingsOf(db, scope) : [],
    setbacks,
    shipped,
  };
}
