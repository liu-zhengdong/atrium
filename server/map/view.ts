import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { oneLine } from "../text-width.ts";
import { priorityOf, type Priority } from "../tasks/priority.ts";
import { runningHostNames } from "../hosts/model.ts";
import {
  all,
  nodeByAddress,
  nodePath,
  nodes,
  one,
  ref,
  type NodeRow,
} from "../org/model.ts";
import { overviewOf, type Overview, type Part } from "../org/overview.ts";
import { chainPoints, nodePoints, type Point } from "../org/points.ts";
import { leaderBriefs, type LeaderBrief } from "../leaders/model.ts";
import { choicesForNodes, pendingChoices } from "../choices/store.ts";
import { materialsForNode } from "../materials/store.ts";
import { taskPeople, type Person, type TaskPeople } from "./who.ts";
import { rollups } from "../tasks/rollup-ledger.ts";
import { progressOf, rollupLabel, type RollupStatus } from "../tasks/rollup.ts";

/**
 * 全景图的只读视图（#322 第 4 步）：网页与 `atrium map --json` 共用同一份。
 * 任务按「归属部分」计：part_id，没有归属时退回负责节点 node_id；计数按子树汇总。
 * 执行者最近动作来自看板（runner.top）的日志解析，由路由注入，这里只按短号对上。
 */

export type Counts = { running: number; blocked: number; open: number };
export type Dot = "running" | "blocked" | "idle";
export type MapTreeNode = {
  ref: string;
  name: string;
  alias: string;
  analogy: string;
  kind: NodeRow["kind"];
  what: string;
  archived: boolean;
  dot: Dot;
  tasks: Counts;
  /** 登记过的 leader 与其最近一次唤醒；节点没有 aN leader 或未登记时不给。 */
  leader_state?: LeaderBrief;
  /** 超出 depth 或本次名额（TREE_NODES_MAX）时不展开或只给前几块，children_count 是下层总数。 */
  children?: MapTreeNode[];
  children_count: number;
};
/** 看板里的一行在全景里用到的部分（`runner.top` 的 rows）。 */
export type LiveRow = {
  ref: string;
  status: string;
  worker: string | null;
  started_at: number | null;
  queued_at: number | null;
  reason: string | null;
  log_at: number;
  action: { text: string; kind: string } | null;
};
export type MapTask = {
  ref: string;
  title: string;
  status: string;
  queued: boolean;
  /** 优先级：紧急、修复、普通、闲时。 */
  priority: Priority;
  worker: string | null;
  host_name?: string | null;
  started_at: number | null;
  updated_at: number;
  reason: string | null;
  action: string | null;
  log_at: number | null;
  part: string | null;
  pr_url: string | null;
  issue: number | null;
  /** PR 交付后的合入阶段：merge_queued / merging / merged / online；没进合入队列为 null。 */
  delivery_stage: string | null;
  ended_at: number | null;
  /** 专员（`task add --by`）：短号与名称；没指定为 null。 */
  job: { ref: string; name: string } | null;
  /** leader 派的（建任务的 aN 与名字）；用户与运行时建的为 null。 */
  by: Person | null;
  /** 最新一条备注，作者给名字（a1 → Atrium 负责人，u1 → 你）。 */
  note: TaskPeople["note"];
  /** 父任务（t190）；顶层为 null。网页据此把总任务的子任务收进总任务那一行。 */
  parent?: string | null;
  /** 总任务（t190）：按全部子孙汇总的状态、进度与直接子任务；不是总任务为 null。 */
  total?: MapTotal | null;
};
export type MapTotal = {
  status: RollupStatus;
  label: string;
  progress: string;
  running: number;
  stuck: number;
  /** 直接子任务（至多 TOTAL_CHILDREN 个）；更多的在 more 里计数。 */
  children: {
    ref: string;
    title: string;
    status: string;
    delivery_stage: string | null;
    total: boolean;
  }[];
  more: number;
};
const TOTAL_CHILDREN = 30;
/** 组成部分的一行：在 Part 之外带一句「做什么」和下面还有几块。 */
export type MapPart = Part & {
  kind: NodeRow["kind"];
  what: string;
  parts: number;
};
export const DEPTH_MAX = 8;
const OPEN = "('todo','running','blocked')";
const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** 本块第一句：人话「是什么」；一行以内。 */
export function firstLine(text: string, max = 80): string {
  const line = text.split("\n", 1)[0]!.trim();
  const chars = Array.from(line);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : line;
}

export function dotOf(counts: Counts): Dot {
  return counts.running ? "running" : counts.blocked ? "blocked" : "idle";
}

function hasTasks(db: DatabaseSync) {
  return all<{ name: string }>(db, "PRAGMA table_info(tasks)").some(
    (c) => c.name === "part_id",
  );
}

/** 各部分的人话字段（org_docs 里 doc='charter' 那一行）。 */
function charters(db: DatabaseSync): Map<number, Record<string, unknown>> {
  const map = new Map<number, Record<string, unknown>>();
  for (const row of all<{ node_id: number; fields: string }>(
    db,
    "SELECT node_id,fields FROM org_docs WHERE doc='charter' LIMIT 600",
  ))
    try {
      map.set(row.node_id, JSON.parse(row.fields) as Record<string, unknown>);
    } catch {
      map.set(row.node_id, {});
    }
  return map;
}

/** 每个节点自己名下（按归属部分）的在跑、卡住、未结数；不含子树。 */
function ownCounts(db: DatabaseSync): Map<number, Counts> {
  const map = new Map<number, Counts>();
  if (!hasTasks(db)) return map;
  for (const row of all<{ id: number; status: string; n: number }>(
    db,
    `SELECT COALESCE(part_id,node_id) AS id,status,COUNT(*) AS n FROM tasks
      WHERE COALESCE(part_id,node_id) IS NOT NULL AND status IN ${OPEN}
      GROUP BY 1,2 LIMIT 1500`,
  )) {
    const c = map.get(row.id) ?? { running: 0, blocked: 0, open: 0 };
    if (row.status === "running") c.running += row.n;
    if (row.status === "blocked") c.blocked += row.n;
    c.open += row.n;
    map.set(row.id, c);
  }
  return map;
}

type Index = {
  list: NodeRow[];
  byId: Map<number, NodeRow>;
  children: Map<number | null, NodeRow[]>;
  fields: Map<number, Record<string, unknown>>;
  counts: Map<number, Counts>;
  leaders: Map<string, LeaderBrief>;
};

function index(db: DatabaseSync): Index {
  const list = nodes(db).filter((node) => node.kind !== "concern");
  const children = new Map<number | null, NodeRow[]>();
  for (const n of list) {
    const siblings = children.get(n.parent_id);
    if (siblings) siblings.push(n);
    else children.set(n.parent_id, [n]);
  }
  const own = ownCounts(db);
  const counts = new Map<number, Counts>();
  const sum = (n: NodeRow): Counts => {
    const c = { ...(own.get(n.id) ?? { running: 0, blocked: 0, open: 0 }) };
    for (const child of children.get(n.id) ?? []) {
      const s = sum(child);
      c.running += s.running;
      c.blocked += s.blocked;
      c.open += s.open;
    }
    counts.set(n.id, c);
    return c;
  };
  for (const root of children.get(null) ?? []) sum(root);
  return {
    list,
    byId: new Map(list.map((n) => [n.id, n])),
    children,
    fields: charters(db),
    counts,
    leaders: leaderBriefs(db),
  };
}

const head = (x: Index, n: NodeRow) => {
  const f = x.fields.get(n.id) ?? {};
  return {
    ref: ref(n.id),
    name: n.name,
    alias: str(f.alias),
    analogy: str(f.analogy),
  };
};

const leaderState = (x: Index, n: NodeRow) => {
  const state = n.leader ? x.leaders.get(n.leader) : undefined;
  return state ? { leader_state: state } : {};
};

/**
 * 这一块归谁管：自己或最近的上级登记过的 leader（事件也按这个投）。
 * from 是 leader 挂在哪一块；挂在本块时为 null。一路都没有时为 null（事件投秘书）。
 */
export type NodeLead = LeaderBrief & {
  from: { ref: string; name: string; alias: string } | null;
};
function leadOf(x: Index, n: NodeRow): NodeLead | null {
  for (let c: NodeRow | undefined = n; c;) {
    const brief = c.leader ? x.leaders.get(c.leader) : undefined;
    if (brief) {
      const h = head(x, c);
      return {
        ...brief,
        from: c === n ? null : { ref: h.ref, name: h.name, alias: h.alias },
      };
    }
    c = c.parent_id === null ? undefined : x.byId.get(c.parent_id);
  }
  return null;
}

/** 一次返回最多展开这么多块；组织再大也不拒绝，超出的层只给下层个数，按需再取（`atrium map oN`、网页点开）。 */
export const TREE_NODES_MAX = 1000;

/**
 * 广度优先分名额：浅层先展开，名额用完的块不再往下；一块的下层多于剩余名额时只给前几块。
 * 返回每块这次展开几个下层（没有的不展开）。
 */
export function expandPlan(
  children: ReadonlyMap<number | null, readonly { id: number }[]>,
  start: number,
  depth: number,
  max = TREE_NODES_MAX,
): Map<number, number> {
  const plan = new Map<number, number>();
  let left = max - 1;
  let level = [start];
  for (let d = 0; d < depth && level.length && left > 0; d++) {
    const next: number[] = [];
    for (const id of level) {
      const kids = children.get(id) ?? [];
      const take = Math.min(kids.length, left);
      if (!take) continue;
      plan.set(id, take);
      left -= take;
      for (let i = 0; i < take; i++) next.push(kids[i]!.id);
    }
    level = next;
  }
  return plan;
}

function treeNode(
  x: Index,
  n: NodeRow,
  plan: ReadonlyMap<number, number>,
): MapTreeNode {
  const f = x.fields.get(n.id) ?? {};
  const counts = x.counts.get(n.id) ?? { running: 0, blocked: 0, open: 0 };
  const kids = x.children.get(n.id) ?? [];
  const take = plan.get(n.id);
  return {
    ...head(x, n),
    kind: n.kind,
    what: firstLine(str(f.what)),
    archived: n.archived_at !== null,
    dot: dotOf(counts),
    tasks: counts,
    ...leaderState(x, n),
    ...(take
      ? { children: kids.slice(0, take).map((c) => treeNode(x, c, plan)) }
      : {}),
    children_count: kids.length,
  };
}

export function parseDepth(value: unknown, fallback = DEPTH_MAX): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > DEPTH_MAX)
    throw new Problem(400, `--depth 应为 0～${DEPTH_MAX} 的整数`, "usage");
  return n;
}

/** 全景树：从 root（缺省组织根）往下 depth 层。 */
export function mapTree(db: DatabaseSync, root?: string, depth = DEPTH_MAX) {
  const x = index(db);
  const start = root
    ? nodeByAddress(db, root)
    : (x.children.get(null) ?? [])[0];
  if (!start)
    return {
      root: null,
      tree: null,
      next: "atrium org import --repo 仓库",
    };
  if (start.kind === "concern")
    throw new Problem(
      404,
      `关注点节点 ${root} 已下线，请查看专员名单`,
      "not_found",
    );
  return {
    root: ref(start.id),
    tree: treeNode(x, start, expandPlan(x.children, start.id, depth)),
  };
}

/** 子树所有节点 id（含自己）。 */
function subtree(x: Index, id: number): number[] {
  const ids = [id];
  for (let i = 0; i < ids.length; i++)
    for (const c of x.children.get(ids[i]!) ?? []) ids.push(c.id);
  return ids;
}

export type TaskRow = {
  id: number;
  title: string;
  status: string;
  worker: string | null;
  host_id?: number | null;
  started_at: number | null;
  updated_at: number;
  part: number | null;
  pr_url: string | null;
  issue: number | null;
  repo: string | null;
  delivery_stage: string | null;
  ended_at: number | null;
  job_id: number | null;
  prio?: string | null;
  parent_id?: number | null;
};

/** 部分页上的总任务（t190）：汇总与直接子任务，按 id 集合批量取；旧库没有 helper 列时不算。 */
export function mapTotals(
  db: DatabaseSync,
  ids: readonly number[],
): Map<number, MapTotal> {
  const result = new Map<number, MapTotal>();
  if (!ids.length || !hasColumn(db, "tasks", "helper")) return result;
  const summaries = rollups(db, ids);
  if (!summaries.size) return result;
  const totals = [...summaries.keys()];
  const children = all<{
    id: number;
    parent_id: number;
    title: string;
    status: string;
    delivery_stage: string | null;
    total: number;
  }>(
    db,
    `SELECT id,parent_id,title,status,delivery_stage,
       EXISTS(SELECT 1 FROM tasks c WHERE c.parent_id=tasks.id AND c.helper=0) AS total
     FROM tasks WHERE helper=0 AND parent_id IN (${totals.map(() => "?").join(",")})
     ORDER BY id LIMIT ?`,
    ...totals,
    totals.length * TOTAL_CHILDREN,
  );
  const byParent = new Map<number, typeof children>();
  for (const c of children) {
    const list = byParent.get(c.parent_id) ?? [];
    list.push(c);
    byParent.set(c.parent_id, list);
  }
  for (const [id, rollup] of summaries) {
    const mine = byParent.get(id) ?? [];
    result.set(id, {
      status: rollup.status,
      label: rollupLabel(rollup),
      progress: progressOf(rollup),
      running: rollup.running,
      stuck: rollup.stuck,
      children: mine.slice(0, TOTAL_CHILDREN).map((c) => ({
        ref: `t${c.id}`,
        title: oneLine(c.title, TASK_LINE_WIDTH),
        status: c.status,
        delivery_stage: c.delivery_stage,
        total: !!c.total,
      })),
      more: Math.max(0, mine.length - TOTAL_CHILDREN),
    });
  }
  return result;
}

/** 角色短号 → 名称；旧库没有角色表时为空。 */
export function jobNames(db: DatabaseSync): Map<number, string> {
  if (
    !one(
      db,
      "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='job_roles'",
    )
  )
    return new Map();
  return new Map(
    all<{ id: number; name: string }>(
      db,
      "SELECT id,name FROM job_roles ORDER BY id LIMIT 200",
    ).map((r) => [r.id, r.name]),
  );
}

/** 全景任务行里原因、最近动作、备注的显示宽度上限：单行，全文看 `task show`。 */
export const TASK_LINE_WIDTH = 120;

export function taskView(
  row: TaskRow,
  live?: LiveRow,
  jobs: ReadonlyMap<number, string> = new Map(),
  people?: TaskPeople,
  involved: {
    total?: MapTotal | null;
    host?: string | null;
  } = {},
): MapTask {
  return {
    parent: row.parent_id == null ? null : `t${row.parent_id}`,
    total: involved.total ?? null,
    ref: `t${row.id}`,
    title: row.title,
    status: row.status,
    queued: live?.queued_at != null,
    priority: priorityOf(row.prio),
    worker: row.worker ?? live?.worker ?? null,
    host_name: row.status === "running" ? (involved.host ?? null) : null,
    started_at: row.started_at,
    updated_at: row.updated_at,
    reason: live?.reason ? oneLine(live.reason, TASK_LINE_WIDTH) : null,
    action: live?.action?.text
      ? oneLine(live.action.text, TASK_LINE_WIDTH)
      : null,
    log_at: live?.log_at || null,
    part: row.part === null ? null : ref(row.part),
    pr_url: row.pr_url,
    issue: row.issue,
    delivery_stage: row.delivery_stage ?? null,
    ended_at: row.ended_at ?? null,
    job:
      row.job_id != null && jobs.has(row.job_id)
        ? { ref: `r${row.job_id}`, name: jobs.get(row.job_id)! }
        : null,
    by: people?.by ?? null,
    note: people?.note
      ? { ...people.note, text: oneLine(people.note.text, TASK_LINE_WIDTH) }
      : null,
  };
}

function hasColumn(db: DatabaseSync, table: string, column: string) {
  return all<{ name: string }>(db, `PRAGMA table_info(${table})`).some(
    (c) => c.name === column,
  );
}
export const taskColumns = (db: DatabaseSync) =>
  `id,parent_id,title,status,worker,started_at,updated_at,COALESCE(part_id,node_id) AS part,pr_url,issue,repo,ended_at,${hasColumn(db, "tasks", "host_id") ? "host_id" : "NULL AS host_id"},${hasColumn(db, "tasks", "delivery_stage") ? "delivery_stage" : "NULL AS delivery_stage"},${hasColumn(db, "tasks", "job_id") ? "job_id" : "NULL AS job_id"},${hasColumn(db, "tasks", "prio") ? "prio" : "NULL AS prio"}`;
const MERGING = "delivery_stage IN ('merge_queued','merging')";
/** 任务在部分页上的顺序：在跑、卡住与等合入、待办、其余。 */
const TASK_ORDER = (db: DatabaseSync) =>
  `CASE WHEN status='running' THEN 0 WHEN status='blocked' THEN 1
    WHEN ${hasColumn(db, "tasks", "delivery_stage") ? MERGING : "0"} THEN 1 WHEN status='todo' THEN 2 ELSE 3 END`;

/** 仓库路径 → GitHub 地址：从账本里已有的 PR 链接推出来，推不出的不给链接。 */
function repoUrls(db: DatabaseSync): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of all<{ repo: string; pr_url: string }>(
    db,
    "SELECT repo,pr_url FROM tasks WHERE repo IS NOT NULL AND pr_url LIKE 'https://github.com/%' ORDER BY id DESC LIMIT 2000",
  )) {
    const m = /^(https:\/\/github\.com\/[^/]+\/[^/]+)\/pull\/\d+/.exec(
      row.pr_url,
    );
    if (m && !map.has(row.repo)) map.set(row.repo, m[1]!);
  }
  return map;
}

/** 选中节点的详情：人话字段、组成、要点、阶段、在推进的任务、PR 与 issue、技术细节。 */
export function mapNode(
  db: DatabaseSync,
  address: string,
  live: readonly LiveRow[] = [],
) {
  const x = index(db);
  const n = nodeByAddress(db, address);
  if (n.kind === "concern")
    throw new Problem(
      404,
      `关注点节点 ${address} 已下线，请查看专员名单`,
      "not_found",
    );
  const fields = x.fields.get(n.id) ?? {};
  const kids = x.children.get(n.id) ?? [];
  const part = (c: NodeRow): MapPart => {
    const counts = x.counts.get(c.id)!;
    const f = x.fields.get(c.id) ?? {};
    return {
      ...head(x, c),
      kind: c.kind,
      what: firstLine(str(f.what), 120),
      archived: c.archived_at !== null,
      parts: (x.children.get(c.id) ?? []).filter(
        (k) => k.kind !== "concern" && k.archived_at === null,
      ).length,
      tasks: {
        todo: counts.open - counts.running - counts.blocked,
        running: counts.running,
        blocked: counts.blocked,
      },
    };
  };
  const overview: Overview = overviewOf(
    fields,
    kids.filter((c) => c.kind !== "concern").map(part),
  );
  const chain: { ref: string; name: string; alias: string }[] = [];
  for (let c: NodeRow | undefined = n; c;) {
    const h = head(x, c);
    chain.unshift({ ref: h.ref, name: h.name, alias: h.alias });
    c = c.parent_id === null ? undefined : x.byId.get(c.parent_id);
  }
  const liveBy = new Map(live.map((row) => [row.ref, row]));
  const ids = subtree(x, n.id);
  const marks = ids.map(() => "?").join(",");
  const rows = hasTasks(db)
    ? all<TaskRow>(
        db,
        `SELECT ${taskColumns(db)} FROM tasks WHERE COALESCE(part_id,node_id) IN (${marks})
          ORDER BY ${TASK_ORDER(db)}, updated_at DESC LIMIT 60`,
        ...ids,
      )
    : [];
  const jobs = jobNames(db);
  const both = rows;
  const hosts = runningHostNames(
    db,
    both.map((r) => (r.status === "running" ? r.host_id : null)),
  );
  const who = taskPeople(
    db,
    both.map((r) => r.id),
  );
  const totals = mapTotals(
    db,
    both.map((r) => r.id),
  );
  const tasks = rows.map((r) =>
    taskView(r, liveBy.get(`t${r.id}`), jobs, who.get(r.id), {
      total: totals.get(r.id),
      host: hosts.get(r.host_id ?? 0),
    }),
  );
  // 总任务按汇总归到在做、卡住、待办或已结束那一组（账本里它从不是 running / blocked）。
  const groupOf = (t: MapTask) =>
    t.total
      ? t.total.status === "running"
        ? "running"
        : t.total.status === "blocked"
          ? "blocked"
          : t.total.status === "todo"
            ? "todo"
            : "recent"
      : ["running", "blocked", "todo"].includes(t.status)
        ? t.status
        : "recent";
  const urls = repoUrls(db);
  const prs = rows
    .filter((r) => r.pr_url)
    .slice(0, 10)
    .map((r) => ({ task: `t${r.id}`, title: r.title, url: r.pr_url! }));
  const issues = new Map<string, { number: number; url: string }>();
  for (const r of rows) {
    const base = r.repo ? urls.get(r.repo) : undefined;
    if (r.issue && base && issues.size < 10)
      issues.set(`${base}#${r.issue}`, {
        number: r.issue,
        url: `${base}/issues/${r.issue}`,
      });
  }
  const repos = all<{ repo: string }>(
    db,
    "SELECT repo FROM org_node_repos WHERE node_id=? ORDER BY repo LIMIT 20",
    n.id,
  ).map((r) => r.repo);
  // 本块（或最近的上级）挂的仓库在 GitHub 上的地址：网页把要点里的测试文件链到那里。
  let repoUrl: string | null = null;
  for (let c: NodeRow | undefined = n; c && !repoUrl;) {
    for (const r of all<{ repo: string }>(
      db,
      "SELECT repo FROM org_node_repos WHERE node_id=? ORDER BY repo LIMIT 20",
      c.id,
    ))
      repoUrl ??=
        urls.get(r.repo) ?? urls.get(r.repo.replace(/\/+$/, "")) ?? null;
    c = c.parent_id === null ? undefined : x.byId.get(c.parent_id);
  }
  return {
    ...head(x, n),
    kind: n.kind,
    path: nodePath(x.list, n),
    leader: n.leader,
    ...leaderState(x, n),
    lead: leadOf(x, n),
    archived: n.archived_at !== null,
    dot: dotOf(x.counts.get(n.id)!),
    counts: x.counts.get(n.id)!,
    chain,
    overview,
    points: nodePoints(db, n.id),
    points_chain: chainPoints(db, n.id).filter((l) => l.node !== ref(n.id)),
    points_below: pointsBelow(db, x, n),
    /** 本块及下层的选项单，开放中的在前；网页「选项」页签。 */
    choices: choicesForNodes(db, ids, x.byId),
    /** 本块挂的资料（没归档的在前，带清理线索）；网页「资料」页签。 */
    materials: materialsForNode(db, n.id),
    tasks: {
      running: tasks.filter((t) => groupOf(t) === "running"),
      blocked: tasks.filter((t) => groupOf(t) === "blocked"),
      todo: tasks.filter((t) => groupOf(t) === "todo").slice(0, 10),
      recent: tasks.filter((t) => groupOf(t) === "recent").slice(0, 20),
    },
    links: { prs, issues: [...issues.values()] },
    detail: {
      repos,
      repo_url: repoUrl,
    },
  };
}
export type MapNode = ReturnType<typeof mapNode>;

/** 下层各块（组成部分与专员，深度优先、不含本块与已归档的）自己的要点；空块省略，至多 200 块。 */
function pointsBelow(db: DatabaseSync, x: Index, n: NodeRow) {
  const levels: {
    node: string;
    name: string;
    alias: string;
    points: Point[];
  }[] = [];
  let seen = 0;
  const walk = (parent: NodeRow) => {
    for (const c of x.children.get(parent.id) ?? []) {
      if (c.archived_at !== null || ++seen > 200) continue;
      const points = nodePoints(db, c.id);
      if (points.length)
        levels.push({
          node: ref(c.id),
          name: c.name,
          alias: head(x, c).alias,
          points,
        });
      walk(c);
    }
  };
  walk(n);
  return levels;
}

/** 在跑与排队的任务（`/api/map/now`，网页顶栏「在做 N 件」）：在跑与排队的任务按归属部分归组；没有归属的放「未归属」。 */
export function mapNow(db: DatabaseSync, live: readonly LiveRow[] = []) {
  const active = live.filter(
    (r) => r.status === "running" || r.queued_at !== null,
  );
  const x = index(db);
  const ids = active.map((r) => Number(r.ref.slice(1)));
  const rows =
    ids.length && hasTasks(db)
      ? all<TaskRow>(
          db,
          `SELECT ${taskColumns(db)} FROM tasks WHERE id IN (${ids.map(() => "?").join(",")}) LIMIT 100`,
          ...ids,
        )
      : [];
  const byRef = new Map(active.map((r) => [r.ref, r]));
  const hosts = runningHostNames(
    db,
    rows.map((r) => (r.status === "running" ? r.host_id : null)),
  );
  const jobs = jobNames(db);
  const who = taskPeople(
    db,
    rows.map((r) => r.id),
  );
  const groups = new Map<
    string,
    {
      part: { ref: string; name: string; alias: string } | null;
      tasks: MapTask[];
    }
  >();
  for (const row of rows) {
    const node = row.part === null ? undefined : x.byId.get(row.part);
    const key = node ? ref(node.id) : "";
    const group = groups.get(key) ?? {
      part: node
        ? { ref: ref(node.id), name: node.name, alias: head(x, node).alias }
        : null,
      tasks: [],
    };
    group.tasks.push(
      taskView(row, byRef.get(`t${row.id}`), jobs, who.get(row.id), {
        host: hosts.get(row.host_id ?? 0),
      }),
    );
    groups.set(key, group);
  }
  const list = [...groups.values()].sort(
    (a, b) =>
      b.tasks.length - a.tasks.length ||
      (a.part ? 0 : 1) - (b.part ? 0 : 1) ||
      (a.part?.ref ?? "").localeCompare(b.part?.ref ?? ""),
  );
  return {
    /** 正在处理事件的负责人（顶栏「Atrium 负责人在处理」）。 */
    leaders: [...x.leaders.values()]
      .filter((l) => l.wake?.status === "running")
      .map((l) => ({ ref: l.ref, name: l.name, doing: l.wake!.summary })),
    running: active.filter((r) => r.queued_at === null).length,
    queued: active.filter((r) => r.queued_at !== null).length,
    blocked: live.filter((r) => r.status === "blocked").length,
    groups: list,
    /** 等用户拍板的选项单（组织根页顶部「等你拍板：N」）。 */
    choices: pendingChoices(db),
  };
}

export { mapSignature } from "./watch.ts";
export type { Point };
