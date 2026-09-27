import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { all, nodeByAddress, one, ref as nodeRef } from "../org/model.ts";
import { parseTaskRef } from "../tasks/ledger-model.ts";

/**
 * 决定记录（t97）：秘书与 leader 各自追加的取舍与原因，给自己回看、换人接手用。
 * 和全景「要点」不同：要点是执行者要守的产品约束，决定记录是「为什么这么定」的账。
 * 每条：日期、谁拍板（u1／secretary／aN）、决定、原因、可选关联（issue、节点、任务）；
 * 被推翻的记 superseded_by 指向新决定，默认不再列出。判定是纯函数，读写在下半部分。
 */

export const DECISION_LIMITS = { text: 300, why: 1000 };
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
  node: string | null;
  task: number | null;
  supersedes: number | null;
};

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
  let node: string | null = null;
  if (given(input.node)) {
    if (typeof input.node !== "string")
      throw usage("--node: 应为组织节点，如 o3 或 atrium/org");
    node = input.node.trim();
  }
  return {
    text: field("text", "决定", "决定"),
    why: field("why", "--why", "原因"),
    by: deciderOf(input.by, owner),
    date: dateOf(input.date, now),
    issue,
    node,
    task: given(input.task) ? parseTaskRef(input.task, "--task") : null,
    supersedes: given(input.supersedes)
      ? parseDecisionRef(input.supersedes, "--supersedes")
      : null,
  };
}

export type DecisionFacts = {
  id: number;
  owner: string;
  superseded_by: number | null;
};

/** 推翻判定（纯函数）：同一份记录里、旧的还有效、新的有效且不是同一条。 */
export function supersedeVerdict(
  owner: string,
  old: DecisionFacts,
  next: DecisionFacts,
): string | null {
  if (old.id === next.id) return `${decisionRef(old.id)} 不能推翻自己`;
  for (const d of [old, next])
    if (d.owner !== owner)
      return `${decisionRef(d.id)} 是 ${who(d.owner)} 的决定记录，不在 ${who(owner)} 的记录里（用 --as ${d.owner}）`;
  if (old.superseded_by !== null)
    return `${decisionRef(old.id)} 已被 ${decisionRef(old.superseded_by)} 推翻`;
  if (next.superseded_by !== null)
    return `${decisionRef(next.id)} 自己已被 ${decisionRef(next.superseded_by)} 推翻，改指向有效的决定`;
  return null;
}

export const who = (owner: string) => (owner === "secretary" ? "秘书" : owner);

export type Decision = {
  ref: string;
  owner: string;
  date: string;
  by: string;
  text: string;
  why: string;
  issue: number | null;
  node: string | null;
  /** 关联节点的名称（网页显示用）；节点已删时为 null。 */
  node_name: string | null;
  task: string | null;
  superseded_by: string | null;
  /** 这条推翻了哪些旧决定。 */
  supersedes: string[];
  created_at: number;
};

/**
 * 唤醒提示词附的决定（纯函数）：按给定顺序（新的在前）取，条数与总字数都有上限；
 * 超了就停，不截半条。返回挑中的与没放下的条数。
 */
export function promptDecisions<T extends { text: string; why: string }>(
  list: readonly T[],
  maxItems = 10,
  maxChars = 2000,
): { shown: T[]; omitted: number } {
  const shown: T[] = [];
  let used = 0;
  for (const d of list) {
    const size = Array.from(d.text).length + Array.from(d.why).length + 20;
    if (shown.length >= maxItems || used + size > maxChars) break;
    shown.push(d);
    used += size;
  }
  return { shown, omitted: list.length - shown.length };
}

/** 一行人话（提示词、命令行共用）。 */
export function decisionLine(d: Decision): string {
  const links = [
    d.issue === null ? "" : `#${d.issue}`,
    d.node ?? "",
    d.task ?? "",
  ].filter(Boolean);
  return [
    `${d.ref} ${d.date.slice(5)} ${d.by === "secretary" ? "秘书" : d.by} 定：${d.text}`,
    `——${d.why}`,
    links.length ? `（${links.join(" ")}）` : "",
    d.supersedes.length ? `（推翻 ${d.supersedes.join("、")}）` : "",
    d.superseded_by ? `【已被 ${d.superseded_by} 推翻】` : "",
  ].join("");
}

// ---- 读写 ----

type Row = {
  id: number;
  owner: string;
  decided_on: string;
  decided_by: string;
  text: string;
  why: string;
  issue: number | null;
  node_id: number | null;
  task_id: number | null;
  superseded_by: number | null;
  superseded_at: number | null;
  created_at: number;
};

function views(db: DatabaseSync, rows: Row[]): Decision[] {
  const ids = rows.map((r) => r.id);
  const replaced = new Map<number, string[]>();
  if (ids.length)
    for (const r of all<{ id: number; superseded_by: number }>(
      db,
      `SELECT id,superseded_by FROM decisions WHERE superseded_by IN (${ids.map(() => "?").join(",")}) ORDER BY id LIMIT ${PAGE_MAX * 4}`,
      ...ids,
    ))
      replaced.set(r.superseded_by, [
        ...(replaced.get(r.superseded_by) ?? []),
        decisionRef(r.id),
      ]);
  const nodeIds = [
    ...new Set(rows.flatMap((r) => (r.node_id === null ? [] : [r.node_id]))),
  ];
  const names = new Map(
    nodeIds.length
      ? all<{ id: number; name: string }>(
          db,
          `SELECT id,name FROM org_nodes WHERE id IN (${nodeIds.map(() => "?").join(",")}) LIMIT ${PAGE_MAX}`,
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
    node: r.node_id === null ? null : nodeRef(r.node_id),
    node_name: r.node_id === null ? null : (names.get(r.node_id) ?? null),
    task: r.task_id === null ? null : `t${r.task_id}`,
    superseded_by:
      r.superseded_by === null ? null : decisionRef(r.superseded_by),
    supersedes: replaced.get(r.id) ?? [],
    created_at: r.created_at,
  }));
}

function requireRow(db: DatabaseSync, id: number, owner: string): Row {
  const row = one<Row>(db, "SELECT * FROM decisions WHERE id=?", id);
  if (!row)
    throw new Problem(
      404,
      `决定 ${decisionRef(id)} 不存在`,
      "not_found",
      undefined,
      `atrium decision ls --as ${owner} --all`,
    );
  return row;
}

export function getDecision(db: DatabaseSync, id: number, owner: string) {
  return views(db, [requireRow(db, id, owner)])[0]!;
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

export function addDecision(
  db: DatabaseSync,
  owner: string,
  body: unknown,
  now = Date.now(),
): Decision {
  const input = validateDecision(body, owner, now);
  db.exec("BEGIN IMMEDIATE");
  try {
    const node = input.node === null ? null : nodeByAddress(db, input.node).id;
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
          "INSERT INTO decisions(owner,decided_on,decided_by,text,why,issue,node_id,task_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          owner,
          input.date,
          input.by,
          input.text,
          input.why,
          input.issue,
          node,
          input.task,
          now,
        ).lastInsertRowid,
    );
    if (input.supersedes !== null)
      supersede(db, owner, input.supersedes, id, now);
    db.exec("COMMIT");
    return getDecision(db, id, owner);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
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
  db.exec("BEGIN IMMEDIATE");
  try {
    supersede(db, owner, oldId, nextId, now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return {
    old: getDecision(db, oldId, owner),
    next: getDecision(db, nextId, owner),
  };
}

export function parseLimit(value: unknown, fallback = PAGE_DEFAULT): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > PAGE_MAX)
    throw usage(`--limit: 应为 1 到 ${PAGE_MAX} 的整数`);
  return n;
}

/**
 * 一位的决定记录，按日期新的在前（同一天按记下的先后倒序）；all 为假时不列已推翻的。
 * 分页用上一页最后一条的短号（before），按 (日期, 编号) 接着往下取。
 */
export function listDecisions(
  db: DatabaseSync,
  owner: string,
  options: { all?: boolean; before?: unknown; limit?: number } = {},
) {
  const limit = options.limit ?? PAGE_DEFAULT;
  const where = ["owner=?"];
  const args: (string | number)[] = [owner];
  if (!options.all) where.push("superseded_by IS NULL");
  if (
    options.before !== undefined &&
    options.before !== null &&
    options.before !== ""
  ) {
    const cursor = requireRow(
      db,
      parseDecisionRef(options.before, "--before"),
      owner,
    );
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
  const count = (extra: string) =>
    one<{ n: number }>(
      db,
      `SELECT count(*) AS n FROM decisions WHERE owner=?${extra}`,
      owner,
    )!.n;
  return {
    owner,
    decisions: views(db, page),
    active: count(" AND superseded_by IS NULL"),
    superseded: count(" AND superseded_by IS NOT NULL"),
    next_before:
      rows.length > limit ? decisionRef(page[page.length - 1]!.id) : null,
  };
}
