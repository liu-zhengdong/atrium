import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { all, nodeByAddress, one, ref as nodeRef } from "../org/model.ts";
import { LOCAL_USER, SECRETARY } from "../../shared/user.ts";
import { atomically, parseTaskRef } from "../tasks/ledger-model.ts";

/**
 * 决定记录（t97）：用户、秘书与 leader 各自追加的取舍与原因，给自己回看、换人接手用。
 * 和全景「要点」不同：要点是执行者要守的产品约束，决定记录是「为什么这么定」的账；已成规矩的可沉淀成要点（curate.ts）。
 * 每条：日期、谁拍板（u1／secretary／aN）、决定、原因、可选关联（issue、一个或多个节点、任务）、是否「原则」；
 * 用户拍板的记在用户那份（u1），秘书、leader 的记录只放各自的（t211，recordOf）。
 * 被推翻的记 superseded_by 指向新决定、沉淀成要点的记 settled_point，默认都不再列出。判定是纯函数，读写在下半部分。
 */

export const DECISION_LIMITS = { text: 300, why: 1000 };
/** 一条决定至多挂几个节点。 */
export const NODES_MAX = 10;
export const PAGE_MAX = 200;
export const PAGE_DEFAULT = 50;

const DECISION_RE = /^d([1-9][0-9]{0,15})$/;
const LEADER_RE = /^a[1-9][0-9]{0,8}$/;
export const decisionRef = (id: number) => `d${id}`;

const usage = (message: string, next?: string) =>
  new Problem(400, message, "usage", undefined, next);

export function parseDecisionRef(value: unknown, field = "决定"): number {
  const match =
    typeof value === "string" ? DECISION_RE.exec(value.trim()) : null;
  if (!match) throw usage(`${field}: 决定短号应为 d1 这样的格式`);
  return Number(match[1]);
}

/** 谁拍板：u1、secretary（也认「秘书」）或 aN；不给就是记录的主人。纯函数。 */
export function deciderOf(value: unknown, owner: string): string {
  if (value === undefined || value === null || value === "") return owner;
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "秘书") return "secretary";
  if (text === "u1" || text === "secretary" || LEADER_RE.test(text))
    return text;
  throw usage("--by: 谁拍板应为 u1、secretary 或 leader 短号 aN");
}

/** 日期 YYYY-MM-DD（补记旧决定用）；不给取本地今天。纯函数。 */
export function dateOf(value: unknown, now = Date.now()): string {
  if (value === undefined || value === null || value === "") {
    const d = new Date(now);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  const text = typeof value === "string" ? value.trim() : "";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const day = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : null;
  if (
    !match ||
    !day ||
    day.getFullYear() !== Number(match[1]) ||
    day.getMonth() !== Number(match[2]) - 1 ||
    day.getDate() !== Number(match[3])
  )
    throw usage("--date: 日期应为 2026-09-27 这样的格式");
  if (day.getTime() > now) throw usage("--date: 不能是将来的日期");
  return text;
}

export type DecisionInput = {
  text: string;
  why: string;
  by: string;
  date: string;
  issue: number | null;
  nodes: string[];
  task: number | null;
  supersedes: number | null;
  principle: boolean;
};

/** 节点地址：一个或多个（命令行 --node 可给多次），去重、去空白，至多 NODES_MAX 个。纯函数。 */
export function nodeAddresses(value: unknown, flag = "--node"): string[] {
  if (value === undefined || value === null || value === "") return [];
  const list = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string" || !item.trim())
      throw usage(`${flag}: 应为组织节点，如 o3 或 atrium/org`);
    if (!out.includes(item.trim())) out.push(item.trim());
  }
  if (out.length > NODES_MAX)
    throw usage(`${flag}: 一条决定至多挂 ${NODES_MAX} 个节点`);
  return out;
}

/** 新决定的字段校验（纯函数）：只认列出的字段，参数名用命令行的。 */
export function validateDecision(
  body: unknown,
  owner: string,
  now = Date.now(),
): DecisionInput {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw usage("请求体应为对象");
  const input = body as Record<string, unknown>;
  const keys = [
    "text",
    "why",
    "by",
    "date",
    "issue",
    "node",
    "task",
    "supersedes",
    "principle",
  ];
  for (const key of Object.keys(input))
    if (!keys.includes(key)) throw usage(`${key}: 是未知字段`);
  const field = (key: "text" | "why", flag: string, label: string) => {
    const value = input[key];
    if (typeof value !== "string" || !value.trim())
      throw usage(`${flag}: ${label}不能为空`);
    const text = value.trim();
    if (Array.from(text).length > DECISION_LIMITS[key])
      throw usage(`${flag}: ${label}不能超过 ${DECISION_LIMITS[key]} 字`);
    return text;
  };
  const given = (value: unknown) =>
    value !== undefined && value !== null && value !== "";
  let issue: number | null = null;
  if (given(input.issue)) {
    const text = String(input.issue).trim().replace(/^#/, "");
    if (!/^[1-9][0-9]{0,8}$/.test(text))
      throw usage("--issue: 应为 issue 号，如 355");
    issue = Number(text);
  }
  if (given(input.principle) && typeof input.principle !== "boolean")
    throw usage("--principle: 应为开关");
  return {
    text: field("text", "决定", "决定"),
    why: field("why", "--why", "原因"),
    by: deciderOf(input.by, owner),
    date: dateOf(input.date, now),
    issue,
    nodes: nodeAddresses(input.node),
    task: given(input.task) ? parseTaskRef(input.task, "--task") : null,
    supersedes: given(input.supersedes)
      ? parseDecisionRef(input.supersedes, "--supersedes")
      : null,
    principle: input.principle === true,
  };
}

/**
 * 记进谁那份（纯函数，t211）：用户拍板的（--by u1）进用户自己那份；其余进 --as 那份。
 * 用户那份只放用户定的：--as u1 却写别人拍板的，报错让去掉 --as。
 */
export function recordOf(owner: string, by: string): string {
  if (by === LOCAL_USER) return LOCAL_USER;
  if (owner === LOCAL_USER)
    throw usage(
      `--as: 用户的决定记录只放 u1 定的；${who(by)}定的记进它自己那份（用 --as ${by}）`,
    );
  return owner;
}

/** 秘书与用户令牌能动的记录：秘书的与用户的；leader 只能动自己的。纯函数。 */
export const recordsOf = (owner: string): string[] =>
  owner === SECRETARY || owner === LOCAL_USER
    ? [SECRETARY, LOCAL_USER]
    : [owner];

export type DecisionFacts = {
  id: number;
  owner: string;
  superseded_by: number | null;
};

/**
 * 推翻判定（纯函数）：旧的在自己能动的记录里（秘书与用户的算一处，leader 只有自己的）、还有效；
 * 新的有效、不是同一条，在同一处或是用户那份（用户推翻秘书、leader 早先的定法）。
 */
export function supersedeVerdict(
  owner: string,
  old: DecisionFacts,
  next: DecisionFacts,
): string | null {
  if (old.id === next.id) return `${decisionRef(old.id)} 不能推翻自己`;
  const records = recordsOf(owner);
  for (const d of [old, next])
    if (!records.includes(d.owner) && !(d === next && d.owner === LOCAL_USER))
      return `${decisionRef(d.id)} 是 ${who(d.owner)} 的决定记录，不在 ${who(owner)} 的记录里（用 --as ${d.owner}）`;
  if (old.superseded_by !== null)
    return `${decisionRef(old.id)} 已被 ${decisionRef(old.superseded_by)} 推翻`;
  if (next.superseded_by !== null)
    return `${decisionRef(next.id)} 自己已被 ${decisionRef(next.superseded_by)} 推翻，改指向有效的决定`;
  return null;
}

export const who = (owner: string) =>
  owner === SECRETARY ? "秘书" : owner === LOCAL_USER ? "用户" : owner;

export type Decision = {
  ref: string;
  owner: string;
  date: string;
  by: string;
  text: string;
  why: string;
  issue: number | null;
  /** 挂在哪些节点上（名称网页显示用；节点已删时为 null）。 */
  nodes: { ref: string; name: string | null }[];
  task: string | null;
  /** 标了「原则」：摘要里总是列出。 */
  principle: boolean;
  /** 已沉淀到哪条要点（kN）。 */
  settled_to: string | null;
  superseded_by: string | null;
  /** 这条推翻了哪些旧决定。 */
  supersedes: string[];
  /** 最近一次撤销推翻：谁、为什么、原先被哪条推翻。 */
  restored: { by: string; why: string; at: number; from: string | null } | null;
  created_at: number;
};

/** 一行人话（提示词、命令行共用）。 */
export function decisionLine(d: Decision): string {
  const links = [
    d.issue === null ? "" : `#${d.issue}`,
    ...d.nodes.map((n) => n.ref),
    d.task ?? "",
  ].filter(Boolean);
  return [
    `${d.ref} ${d.date.slice(5)} ${d.by === SECRETARY ? "秘书" : d.by} 定${d.principle ? "（原则）" : ""}：${d.text}`,
    `——${d.why}`,
    links.length ? `（${links.join(" ")}）` : "",
    d.supersedes.length ? `（推翻 ${d.supersedes.join("、")}）` : "",
    d.superseded_by ? `【已被 ${d.superseded_by} 推翻】` : "",
    d.settled_to ? `【已沉淀到 ${d.settled_to}】` : "",
  ].join("");
}

/** 检索词（纯函数）：按空白拆，至多 5 个、每个至多 50 字；全部命中才算。 */
export function searchTerms(value: unknown): string[] {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw usage("关键词: 不能为空");
  const terms = [...new Set(text.split(/\s+/))];
  if (terms.length > 5) throw usage("关键词: 至多 5 个");
  if (terms.some((t) => Array.from(t).length > 50))
    throw usage("关键词: 每个至多 50 字");
  return terms;
}

/** LIKE 的通配符转义（配 ESCAPE '\\'）。纯函数。 */
export const likePattern = (term: string) =>
  `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// ---- 读写 ----

export type Row = {
  id: number;
  owner: string;
  decided_on: string;
  decided_by: string;
  text: string;
  why: string;
  issue: number | null;
  task_id: number | null;
  principle: number;
  settled_point: number | null;
  superseded_by: number | null;
  superseded_at: number | null;
  created_at: number;
};

const marks = (list: readonly unknown[]) => list.map(() => "?").join(",");

export function views(db: DatabaseSync, rows: readonly Row[]): Decision[] {
  const ids = rows.map((r) => r.id);
  const replaced = new Map<number, string[]>();
  const linked = new Map<number, number[]>();
  const restored = new Map<number, Decision["restored"]>();
  if (ids.length) {
    for (const r of all<{ id: number; superseded_by: number }>(
      db,
      `SELECT id,superseded_by FROM decisions WHERE superseded_by IN (${marks(ids)}) ORDER BY id LIMIT ${PAGE_MAX * 4}`,
      ...ids,
    ))
      replaced.set(r.superseded_by, [
        ...(replaced.get(r.superseded_by) ?? []),
        decisionRef(r.id),
      ]);
    for (const r of all<{ decision_id: number; node_id: number }>(
      db,
      `SELECT decision_id,node_id FROM decision_nodes WHERE decision_id IN (${marks(ids)}) ORDER BY decision_id,node_id LIMIT ${PAGE_MAX * NODES_MAX}`,
      ...ids,
    ))
      linked.set(r.decision_id, [
        ...(linked.get(r.decision_id) ?? []),
        r.node_id,
      ]);
    for (const r of all<{
      decision_id: number;
      actor: string;
      why: string;
      detail: string | null;
      created_at: number;
    }>(
      db,
      `SELECT decision_id,actor,why,detail,created_at FROM decision_changes WHERE kind='unsupersede' AND decision_id IN (${marks(ids)}) ORDER BY id LIMIT ${PAGE_MAX * 4}`,
      ...ids,
    ))
      restored.set(r.decision_id, {
        by: r.actor,
        why: r.why,
        at: r.created_at,
        from: r.detail,
      });
  }
  const nodeIds = [...new Set([...linked.values()].flat())];
  const names = new Map(
    nodeIds.length
      ? all<{ id: number; name: string }>(
          db,
          `SELECT id,name FROM org_nodes WHERE id IN (${marks(nodeIds)}) LIMIT ${PAGE_MAX * NODES_MAX}`,
          ...nodeIds,
        ).map((n) => [n.id, n.name])
      : [],
  );
  return rows.map((r) => ({
    ref: decisionRef(r.id),
    owner: r.owner,
    date: r.decided_on,
    by: r.decided_by,
    text: r.text,
    why: r.why,
    issue: r.issue,
    nodes: (linked.get(r.id) ?? []).map((id) => ({
      ref: nodeRef(id),
      name: names.get(id) ?? null,
    })),
    task: r.task_id === null ? null : `t${r.task_id}`,
    principle: r.principle === 1,
    settled_to: r.settled_point === null ? null : `k${r.settled_point}`,
    superseded_by:
      r.superseded_by === null ? null : decisionRef(r.superseded_by),
    supersedes: replaced.get(r.id) ?? [],
    restored: restored.get(r.id) ?? null,
    created_at: r.created_at,
  }));
}

export function requireRow(db: DatabaseSync, id: number, owner?: string): Row {
  const row = one<Row>(db, "SELECT * FROM decisions WHERE id=?", id);
  if (!row)
    throw new Problem(
      404,
      `决定 ${decisionRef(id)} 不存在`,
      "not_found",
      undefined,
      `atrium decision ls${owner && owner !== SECRETARY ? ` --as ${owner}` : ""} --all`,
    );
  return row;
}

export function getDecision(db: DatabaseSync, id: number) {
  return views(db, [requireRow(db, id)])[0]!;
}

/** 给决定挂节点（已挂的不重复）；节点须存在。 */
export function linkNodes(
  db: DatabaseSync,
  id: number,
  addresses: readonly string[],
) {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO decision_nodes(decision_id,node_id) VALUES(?,?)",
  );
  const count = () =>
    one<{ n: number }>(
      db,
      "SELECT count(*) AS n FROM decision_nodes WHERE decision_id=?",
      id,
    )!.n;
  for (const address of addresses)
    insert.run(id, nodeByAddress(db, address).id);
  if (count() > NODES_MAX)
    throw usage(`--node: 一条决定至多挂 ${NODES_MAX} 个节点`);
}

function supersede(
  db: DatabaseSync,
  owner: string,
  oldId: number,
  nextId: number,
  now: number,
) {
  const old = requireRow(db, oldId, owner);
  const next = requireRow(db, nextId, owner);
  const problem = supersedeVerdict(owner, old, next);
  if (problem)
    throw new Problem(
      409,
      problem,
      "conflict",
      undefined,
      `atrium decision ls --as ${owner} --all`,
    );
  db.prepare(
    "UPDATE decisions SET superseded_by=?,superseded_at=? WHERE id=?",
  ).run(nextId, now, oldId);
}

/** leader 负责的（未归档）节点：它转记用户拍板的决定没挂节点时挂这些，免得自己的摘要里看不到。 */
function ledNodes(db: DatabaseSync, leader: string): string[] {
  if (!LEADER_RE.test(leader)) return [];
  return all<{ id: number }>(
    db,
    `SELECT id FROM org_nodes WHERE leader=? AND archived_at IS NULL ORDER BY id LIMIT ${NODES_MAX}`,
    leader,
  ).map((n) => nodeRef(n.id));
}

export function addDecision(
  db: DatabaseSync,
  owner: string,
  body: unknown,
  now = Date.now(),
): Decision {
  const input = validateDecision(body, owner, now);
  const record = recordOf(owner, input.by);
  return atomically(db, () => {
    if (
      input.task !== null &&
      !one(db, "SELECT 1 AS ok FROM tasks WHERE id=?", input.task)
    )
      throw new Problem(
        404,
        `--task: 任务 t${input.task} 不存在`,
        "not_found",
        undefined,
        "atrium task ls",
      );
    const id = Number(
      db
        .prepare(
          "INSERT INTO decisions(owner,decided_on,decided_by,text,why,issue,task_id,principle,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          record,
          input.date,
          input.by,
          input.text,
          input.why,
          input.issue,
          input.task,
          input.principle ? 1 : 0,
          now,
        ).lastInsertRowid,
    );
    linkNodes(
      db,
      id,
      input.nodes.length || record === owner
        ? input.nodes
        : ledNodes(db, owner),
    );
    if (input.supersedes !== null)
      supersede(db, owner, input.supersedes, id, now);
    return getDecision(db, id);
  });
}

export function supersedeDecision(
  db: DatabaseSync,
  owner: string,
  reference: unknown,
  body: unknown,
  now = Date.now(),
): { old: Decision; next: Decision } {
  const oldId = parseDecisionRef(reference);
  const input = (body ?? {}) as Record<string, unknown>;
  if (typeof input !== "object" || Array.isArray(input))
    throw usage("请求体应为对象");
  for (const key of Object.keys(input))
    if (key !== "by") throw usage(`${key}: 是未知字段`);
  const nextId = parseDecisionRef(input.by, "--by");
  atomically(db, () => supersede(db, owner, oldId, nextId, now));
  return { old: getDecision(db, oldId), next: getDecision(db, nextId) };
}

export function parseLimit(value: unknown, fallback = PAGE_DEFAULT): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > PAGE_MAX)
    throw usage(`--limit: 应为 1 到 ${PAGE_MAX} 的整数`);
  return n;
}

/**
 * 按范围取决定：几份记录（owners）里的，或挂在几个节点（nodes）上的，两样都给取并集；都不给是全部。
 * 返回 SQL 片段与参数（参数化，节点至多 500 个）。
 */
export type DecisionScope = {
  owners?: readonly string[];
  nodes?: readonly number[];
};
export function scopeWhere(scope: DecisionScope | null) {
  if (!scope) return { sql: "1", args: [] as (string | number)[] };
  const parts: string[] = [];
  const args: (string | number)[] = [];
  if (scope.owners?.length) {
    parts.push(`owner IN (${marks(scope.owners)})`);
    args.push(...scope.owners);
  }
  if (scope.nodes?.length) {
    parts.push(
      `id IN (SELECT decision_id FROM decision_nodes WHERE node_id IN (${marks(scope.nodes)}))`,
    );
    args.push(...scope.nodes);
  }
  return { sql: parts.length ? `(${parts.join(" OR ")})` : "0", args };
}

/** 有效：没被推翻、没沉淀成要点。 */
export const ACTIVE_SQL = "superseded_by IS NULL AND settled_point IS NULL";

/**
 * 按范围列决定，日期新的在前（同一天按记下的先后倒序）；all 为假时只列有效的；
 * terms 给了就是全文检索（决定与原因里全部命中）。分页用上一页最后一条的短号（before）。
 */
export function listDecisions(
  db: DatabaseSync,
  scope: DecisionScope | null,
  options: {
    all?: boolean;
    before?: unknown;
    limit?: number;
    terms?: readonly string[];
  } = {},
) {
  const limit = options.limit ?? PAGE_DEFAULT;
  const base = scopeWhere(scope);
  const where = [base.sql];
  const args = [...base.args];
  for (const term of options.terms ?? []) {
    where.push("(text LIKE ? ESCAPE '\\' OR why LIKE ? ESCAPE '\\')");
    args.push(likePattern(term), likePattern(term));
  }
  const counted = [...where];
  const countArgs = [...args];
  if (!options.all) where.push(ACTIVE_SQL);
  if (
    options.before !== undefined &&
    options.before !== null &&
    options.before !== ""
  ) {
    const cursor = requireRow(db, parseDecisionRef(options.before, "--before"));
    where.push("(decided_on<? OR (decided_on=? AND id<?))");
    args.push(cursor.decided_on, cursor.decided_on, cursor.id);
  }
  const rows = all<Row>(
    db,
    `SELECT * FROM decisions WHERE ${where.join(" AND ")} ORDER BY decided_on DESC,id DESC LIMIT ?`,
    ...args,
    limit + 1,
  );
  const page = rows.slice(0, limit);
  const counts = one<{ active: number; superseded: number; settled: number }>(
    db,
    `SELECT coalesce(sum(superseded_by IS NULL AND settled_point IS NULL),0) AS active,
      coalesce(sum(superseded_by IS NOT NULL),0) AS superseded,
      coalesce(sum(superseded_by IS NULL AND settled_point IS NOT NULL),0) AS settled
      FROM decisions WHERE ${counted.join(" AND ")}`,
    ...countArgs,
  )!;
  return {
    decisions: views(db, page),
    active: counts.active,
    superseded: counts.superseded,
    settled: counts.settled,
    next_before:
      rows.length > limit ? decisionRef(page[page.length - 1]!.id) : null,
  };
}
