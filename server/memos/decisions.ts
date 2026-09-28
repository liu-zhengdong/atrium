import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import {
  all,
  nodeByAddress,
  nodes,
  one,
  ref as nodeRef,
} from "../org/model.ts";
import { LOCAL_USER, SECRETARY } from "../../shared/user.ts";
import { atomically, parseTaskRef } from "../tasks/ledger/ledger-model.ts";
import { marks } from "../sqlite.ts";

/**
 * 决定记录：只记用户拍板的事与原因，给人回看的档案（不附进任何提示词）。要守的规矩写成要点（org/points.ts）；
 * leader、秘书自己的处理过程写任务备注。每条：日期、决定、原因、可选关联（issue、一个或多个节点、任务）；
 * 被推翻的记 superseded_by 指向新决定。早先 leader、秘书记的旧条目留在库里，不再列出也不再新增。
 */

export const DECISION_LIMITS = { text: 300, why: 1000 };
/** 一条决定至多挂几个节点。 */
const NODES_MAX = 10;
export const PAGE_MAX = 200;
export const PAGE_DEFAULT = 50;

const DECISION_RE = /^d([1-9][0-9]{0,15})$/;
export const decisionRef = (id: number) => `d${id}`;

const usage = (message: string, next?: string) =>
  new Problem(400, message, "usage", undefined, next);

function parseDecisionRef(value: unknown, field = "决定"): number {
  const match =
    typeof value === "string" ? DECISION_RE.exec(value.trim()) : null;
  if (!match) throw usage(`${field}: 决定短号应为 d1 这样的格式`);
  return Number(match[1]);
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
  date: string;
  issue: number | null;
  nodes: string[];
  task: number | null;
  supersedes: number | null;
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
  now = Date.now(),
): DecisionInput {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw usage("请求体应为对象");
  const input = body as Record<string, unknown>;
  const keys = ["text", "why", "date", "issue", "node", "task", "supersedes"];
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
  return {
    text: field("text", "决定", "决定"),
    why: field("why", "--why", "原因"),
    date: dateOf(input.date, now),
    issue,
    nodes: nodeAddresses(input.node),
    task: given(input.task) ? parseTaskRef(input.task, "--task") : null,
    supersedes: given(input.supersedes)
      ? parseDecisionRef(input.supersedes, "--supersedes")
      : null,
  };
}

export const who = (by: string) =>
  by === SECRETARY ? "秘书" : by === LOCAL_USER ? "用户" : by;

export type Decision = {
  ref: string;
  date: string;
  by: string;
  text: string;
  why: string;
  issue: number | null;
  /** 挂在哪些节点上（名称网页显示用；节点已删时为 null）。 */
  nodes: { ref: string; name: string | null }[];
  task: string | null;
  superseded_by: string | null;
  /** 这条推翻了哪些旧决定。 */
  supersedes: string[];
  created_at: number;
};

/** 一行人话（命令行、网页共用）。 */
export function decisionLine(d: Decision): string {
  const links = [
    d.issue === null ? "" : `#${d.issue}`,
    ...d.nodes.map((n) => n.ref),
    d.task ?? "",
  ].filter(Boolean);
  return [
    `${d.ref} ${d.date.slice(5)} ${who(d.by)}定：${d.text}`,
    `——${d.why}`,
    links.length ? `（${links.join(" ")}）` : "",
    d.supersedes.length ? `（推翻 ${d.supersedes.join("、")}）` : "",
    d.superseded_by ? `【已被 ${d.superseded_by} 推翻】` : "",
  ].join("");
}

/** 检索词（纯函数）：按空白拆，至多 5 个、每个至多 50 字；全部命中才算。 */
export function searchTerms(value: unknown): string[] {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return [];
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
  superseded_by: number | null;
  superseded_at: number | null;
  created_at: number;
};

function append<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function views(db: DatabaseSync, rows: readonly Row[]): Decision[] {
  const ids = rows.map((r) => r.id);
  const replaced = new Map<number, string[]>();
  const linked = new Map<number, number[]>();
  if (ids.length) {
    for (const r of all<{ id: number; superseded_by: number }>(
      db,
      `SELECT id,superseded_by FROM decisions WHERE superseded_by IN (${marks(ids)}) ORDER BY id LIMIT ${PAGE_MAX * 4}`,
      ...ids,
    ))
      append(replaced, r.superseded_by, decisionRef(r.id));
    for (const r of all<{ decision_id: number; node_id: number }>(
      db,
      `SELECT decision_id,node_id FROM decision_nodes WHERE decision_id IN (${marks(ids)}) ORDER BY decision_id,node_id LIMIT ${PAGE_MAX * NODES_MAX}`,
      ...ids,
    ))
      append(linked, r.decision_id, r.node_id);
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
    superseded_by:
      r.superseded_by === null ? null : decisionRef(r.superseded_by),
    supersedes: replaced.get(r.id) ?? [],
    created_at: r.created_at,
  }));
}

function requireRow(db: DatabaseSync, id: number): Row {
  const row = one<Row>(db, "SELECT * FROM decisions WHERE id=?", id);
  if (!row)
    throw new Problem(
      404,
      `决定 ${decisionRef(id)} 不存在`,
      "not_found",
      undefined,
      "atrium decision ls --all",
    );
  return row;
}

function getDecision(db: DatabaseSync, id: number) {
  return views(db, [requireRow(db, id)])[0]!;
}

/**
 * 记一条用户拍板的决定。choices 拍板时替用户记没选的选项（by 是拍板人，只会是 u1）。
 */
export function addDecision(
  db: DatabaseSync,
  body: unknown,
  now = Date.now(),
): Decision {
  const input = validateDecision(body, now);
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
          "INSERT INTO decisions(owner,decided_on,decided_by,text,why,issue,task_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          LOCAL_USER,
          input.date,
          LOCAL_USER,
          input.text,
          input.why,
          input.issue,
          input.task,
          now,
        ).lastInsertRowid,
    );
    const insert = db.prepare(
      "INSERT OR IGNORE INTO decision_nodes(decision_id,node_id) VALUES(?,?)",
    );
    for (const address of input.nodes)
      insert.run(id, nodeByAddress(db, address).id);
    if (input.supersedes !== null) {
      const old = requireRow(db, input.supersedes);
      if (old.superseded_by !== null)
        throw new Problem(
          409,
          `${decisionRef(old.id)} 已被 ${decisionRef(old.superseded_by)} 推翻`,
          "conflict",
        );
      db.prepare(
        "UPDATE decisions SET superseded_by=?,superseded_at=? WHERE id=?",
      ).run(id, now, old.id);
    }
    return getDecision(db, id);
  });
}

export function parseLimit(value: unknown, fallback = PAGE_DEFAULT): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > PAGE_MAX)
    throw usage(`--limit: 应为 1 到 ${PAGE_MAX} 的整数`);
  return n;
}

/** 节点及其上级（纯函数）：挂在上级的决定也管到这一块。 */
function upward(
  list: readonly { id: number; parent_id: number | null }[],
  start: number,
) {
  const out: number[] = [];
  for (
    let current = list.find((n) => n.id === start);
    current && !out.includes(current.id);
    current = list.find((n) => n.id === current!.parent_id)
  )
    out.push(current.id);
  return out;
}

/**
 * 列决定，日期新的在前（同一天按记下的先后倒序）；node 给了只列挂在它及上级的；all 为假时只列没被推翻的；
 * terms 给了按关键词检索（决定与原因里全部命中）。分页用上一页最后一条的短号（before）。
 */
export function listDecisions(
  db: DatabaseSync,
  options: {
    node?: string;
    all?: boolean;
    before?: unknown;
    limit?: number;
    terms?: readonly string[];
  } = {},
) {
  const limit = options.limit ?? PAGE_DEFAULT;
  // 只列用户拍板的：早先 leader、秘书记的运行流水留在库里，不再列出。
  const where: string[] = ["decided_by=?"];
  const args: (string | number)[] = [LOCAL_USER];
  if (options.node) {
    const ids = upward(nodes(db), nodeByAddress(db, options.node).id);
    where.push(
      `id IN (SELECT decision_id FROM decision_nodes WHERE node_id IN (${marks(ids)}))`,
    );
    args.push(...ids);
  }
  for (const term of options.terms ?? []) {
    where.push("(text LIKE ? ESCAPE '\\' OR why LIKE ? ESCAPE '\\')");
    args.push(likePattern(term), likePattern(term));
  }
  const counted = where.join(" AND ");
  const countArgs = [...args];
  if (!options.all) where.push("superseded_by IS NULL");
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
  const counts = one<{ active: number; superseded: number }>(
    db,
    `SELECT coalesce(sum(superseded_by IS NULL),0) AS active,
      coalesce(sum(superseded_by IS NOT NULL),0) AS superseded
      FROM decisions WHERE ${counted}`,
    ...countArgs,
  )!;
  return {
    decisions: views(db, page),
    active: counts.active,
    superseded: counts.superseded,
    next_before:
      rows.length > limit ? decisionRef(page[page.length - 1]!.id) : null,
  };
}
