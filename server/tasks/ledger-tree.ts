import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  all,
  one,
  parseTaskRef,
  requireRow,
  taskRef,
  TREE_MAX,
  TREE_RECENT,
  TREE_ROOTS,
  TREE_ROOTS_MAX,
  usage,
  type TaskNode,
  type TaskRow,
} from "./ledger-model.ts";
import { childSummaries } from "./ledger-summary.ts";
import { rollups } from "./rollup-ledger.ts";
import { noteViews } from "./notes.ts";

type TreeRow = Pick<
  TaskRow,
  | "id"
  | "parent_id"
  | "title"
  | "status"
  | "deliver"
  | "issue"
  | "worker"
  | "pr_url"
  | "delivery_stage"
>;

export type TaskTree = {
  tasks: TaskNode[];
  /** 节点超过 TREE_MAX，后面的没给。 */
  truncated: boolean;
  /** 顶层还有下一页时给翻页游标（同一范围接着 --after 看）；给了根或已到底为 null。 */
  next_after: string | null;
  /** 这一页之后同一范围还有几个顶层任务。 */
  remaining: number;
  /** 默认范围（未完成的 + 最近已结束的）里没列出的已结束顶层任务数；--all 时为 0。 */
  closed_hidden: number;
};

const COLUMNS =
  "id, parent_id, title, status, deliver, issue, worker, pr_url, delivery_stage";
const OPEN = "status NOT IN ('done','cancelled')";
const CLOSED = "status IN ('done','cancelled')";
const TOP = "parent_id IS NULL";

const count = (db: DatabaseSync, where: string, ...params: SQLInputValue[]) =>
  one<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM tasks WHERE ${where}`,
    ...params,
  )!.n;

function pageOf(query: { all?: unknown; after?: unknown; limit?: unknown }) {
  const given = (value: unknown) => value !== undefined && value !== "";
  if (given(query.all) && !["1", "true", true].includes(query.all as string))
    throw usage("all: 只能是 1");
  let limit = TREE_ROOTS;
  if (given(query.limit)) {
    limit = Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > TREE_ROOTS_MAX)
      throw usage(`limit: 应为 1～${TREE_ROOTS_MAX} 的整数`);
  }
  return {
    all: given(query.all),
    after: given(query.after) ? parseTaskRef(query.after, "after") : 0,
    limit,
    paged: given(query.all) || given(query.after) || given(query.limit),
  };
}

/** 顶层任务一页：默认未完成的按短号翻页，首页另带最近 TREE_RECENT 个已结束的；all 时全部顶层按短号翻页。 */
function topLevel(db: DatabaseSync, page: ReturnType<typeof pageOf>) {
  const scope = page.all ? TOP : `${TOP} AND ${OPEN}`;
  const ids = all<{ id: number }>(
    db,
    `SELECT id FROM tasks WHERE ${scope} AND id>? ORDER BY id LIMIT ?`,
    page.after,
    page.limit + 1,
  ).map((found) => found.id);
  const more = ids.length > page.limit;
  if (more) ids.length = page.limit;
  const last = ids.at(-1);
  const remaining = more ? count(db, `${scope} AND id>?`, last!) : 0;
  if (page.all)
    return {
      ids,
      remaining,
      next_after: more ? taskRef(last!) : null,
      closed_hidden: 0,
    };
  const recent =
    page.after === 0
      ? all<{ id: number }>(
          db,
          `SELECT id FROM tasks WHERE ${TOP} AND ${CLOSED} ORDER BY id DESC LIMIT ?`,
          TREE_RECENT,
        ).map((found) => found.id)
      : [];
  const closed_hidden =
    page.after === 0 && recent.length < TREE_RECENT
      ? 0
      : count(db, `${TOP} AND ${CLOSED}`) - recent.length;
  return {
    ids: [...ids, ...recent],
    remaining,
    next_after: more ? taskRef(last!) : null,
    closed_hidden,
  };
}

/**
 * root 给定时返回那一棵；不给返回顶层任务组成的森林，有界分页（t155）：
 * 默认列未完成的顶层（每页 limit 个，after 翻页）与最近几个已结束的，all 列全部顶层。
 * 只取画树要的列，备注与子任务汇总按 id 集合批量查；节点超出上限标 truncated。
 */
export function taskTree(
  db: DatabaseSync,
  root?: unknown,
  query: { all?: unknown; after?: unknown; limit?: unknown } = {},
): TaskTree {
  const rootId =
    root === undefined || root === "" ? null : parseTaskRef(root, "root");
  const page = pageOf(query);
  if (rootId !== null && page.paged)
    throw usage("all、after、limit 只用于不给 root 时翻顶层任务");
  if (rootId !== null) requireRow(db, rootId);
  const top =
    rootId === null
      ? topLevel(db, page)
      : { ids: [rootId], remaining: 0, next_after: null, closed_hidden: 0 };
  // 递归时就带上画树要的列，最后不再按 id 回表（回表会让规划器扫整张 tasks）。
  const rows = top.ids.length
    ? all<TreeRow>(
        db,
        `WITH RECURSIVE sub(${COLUMNS}) AS (
           SELECT ${COLUMNS} FROM tasks
           WHERE id IN (${top.ids.map(() => "?").join(",")})
           UNION ALL
           SELECT ${COLUMNS.split(", ")
             .map((column) => `t.${column}`)
             .join(", ")}
           FROM tasks t JOIN sub ON t.parent_id=sub.id)
         SELECT * FROM sub ORDER BY id LIMIT ?`,
        ...top.ids,
        TREE_MAX + 1,
      )
    : [];
  const truncated = rows.length > TREE_MAX;
  if (truncated) rows.length = TREE_MAX;
  const ids = rows.map((found) => found.id);
  const summaries = childSummaries(db, ids);
  const totals = rollups(db, [...summaries.keys()]);
  const notes = noteViews(db, rows);
  const roots = new Set(top.ids);
  const nodes = new Map<number, TaskNode>();
  const forest: TaskNode[] = [];
  // 按 id 升序：父任务总比子任务先建，先出现。
  for (const { id, parent_id, ...found } of rows) {
    const node: TaskNode = {
      ref: taskRef(id),
      parent_ref: parent_id === null ? null : taskRef(parent_id),
      ...found,
      ...notes.get(id)!,
      children: [],
      child_summary: summaries.get(id) ?? null,
      rollup: totals.get(id) ?? null,
    };
    nodes.set(id, node);
    if (roots.has(id)) forest.push(node);
    else if (parent_id !== null) nodes.get(parent_id)?.children.push(node);
  }
  return {
    tasks: forest,
    truncated,
    next_after: top.next_after,
    remaining: top.remaining,
    closed_hidden: top.closed_hidden,
  };
}
