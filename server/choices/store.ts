import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import {
  all,
  nodeByAddress,
  nodes,
  one,
  ref,
  type NodeRow,
} from "../org/model.ts";
import { addDecision, decisionRef } from "../memos/decisions.ts";
import { partRoute } from "../leaders/subscriber.ts";
import { atomically, createTask, parseTaskRef } from "../tasks/ledger.ts";
import {
  choiceRef,
  decideVerdict,
  noteOf,
  parseChoiceRef,
  parsePicks,
  pickedBrief,
  skippedDecision,
  statusAfter,
  STATUS_TEXT,
  validateChoice,
  type ChoiceFacts,
  type ChoiceStatus,
  type OptionFacts,
  type PendingChoice,
} from "./model.ts";

/**
 * 选项单的存储（产品部第 2 步）：`choices` 一份一行，`choice_options` 每个选项一行、
 * 拍板后记下建的任务或记的决定。短号 cN 取 AUTOINCREMENT，全局持久不复用。
 * 判定都在 model.ts，这里只读写；拍板在一个事务里建任务、记决定、改状态。
 */

export function ensureChoiceTables(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS choices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    recommend TEXT NOT NULL,
    why TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('open','picked','passed')),
    created_by TEXT NOT NULL,
    task_id INTEGER,
    note TEXT,
    decided_by TEXT,
    decided_at INTEGER,
    created_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS choices_status ON choices(status,id);
  CREATE INDEX IF NOT EXISTS choices_node ON choices(node_id,id);
  CREATE TABLE IF NOT EXISTS choice_options (
    choice_id INTEGER NOT NULL REFERENCES choices(id),
    seq INTEGER NOT NULL,
    title TEXT NOT NULL,
    gain TEXT NOT NULL,
    why_now TEXT NOT NULL,
    cost TEXT NOT NULL,
    skip TEXT NOT NULL,
    basis TEXT NOT NULL,
    picked INTEGER,
    task_id INTEGER,
    decision_id INTEGER,
    PRIMARY KEY(choice_id,seq));`);
}

export const PAGE_DEFAULT = 20;
export const PAGE_MAX = 100;

type Row = {
  id: number;
  node_id: number;
  title: string;
  recommend: string;
  why: string;
  status: ChoiceStatus;
  created_by: string;
  task_id: number | null;
  note: string | null;
  decided_by: string | null;
  decided_at: number | null;
  created_at: number;
};
type OptionRow = {
  choice_id: number;
  seq: number;
  title: string;
  gain: string;
  why_now: string;
  cost: string;
  skip: string;
  basis: string;
  picked: number | null;
  task_id: number | null;
  decision_id: number | null;
};

/** 坏的 JSON 字段按空列表读，不让一条坏记录挡住整页。 */
function list<T>(raw: string, keep: (value: unknown) => value is T): T[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(keep) : [];
  } catch {
    return [];
  }
}
const isNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v);
const isString = (v: unknown): v is string => typeof v === "string";

export type ChoiceOption = {
  seq: number;
  title: string;
  gain: string;
  why_now: string;
  cost: string;
  skip: string;
  basis: string[];
  /** 拍板结果：选中 true、没选 false、还没定 null。 */
  picked: boolean | null;
  task: string | null;
  decision: string | null;
};
export type Choice = {
  ref: string;
  node: string;
  node_name: string;
  node_alias: string;
  title: string;
  status: ChoiceStatus;
  status_text: string;
  recommend: number[];
  why: string;
  created_by: string;
  task: string | null;
  note: string | null;
  decided_by: string | null;
  decided_at: number | null;
  created_at: number;
  options: ChoiceOption[];
};

function aliasOf(db: DatabaseSync, ids: readonly number[]) {
  if (!ids.length) return new Map<number, string>();
  return new Map(
    all<{ node_id: number; fields: string }>(
      db,
      `SELECT node_id,fields FROM org_docs WHERE doc='charter' AND node_id IN (${ids.map(() => "?").join(",")}) LIMIT ${PAGE_MAX}`,
      ...ids,
    ).map((r) => {
      let alias = "";
      try {
        const parsed = JSON.parse(r.fields) as { alias?: unknown };
        if (typeof parsed?.alias === "string") alias = parsed.alias.trim();
      } catch {
        /* 坏字段不给人话名。 */
      }
      return [r.node_id, alias];
    }),
  );
}

function views(db: DatabaseSync, rows: Row[], byId?: Map<number, NodeRow>) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const options = new Map<number, ChoiceOption[]>();
  for (const o of all<OptionRow>(
    db,
    `SELECT * FROM choice_options WHERE choice_id IN (${ids.map(() => "?").join(",")}) ORDER BY choice_id,seq LIMIT ${ids.length * 10}`,
    ...ids,
  ))
    options.set(o.choice_id, [
      ...(options.get(o.choice_id) ?? []),
      {
        seq: o.seq,
        title: o.title,
        gain: o.gain,
        why_now: o.why_now,
        cost: o.cost,
        skip: o.skip,
        basis: list(o.basis, isString),
        picked: o.picked === null ? null : o.picked === 1,
        task: o.task_id === null ? null : `t${o.task_id}`,
        decision: o.decision_id === null ? null : decisionRef(o.decision_id),
      },
    ]);
  const names = byId ?? new Map(nodes(db).map((n) => [n.id, n]));
  const aliases = aliasOf(db, [...new Set(rows.map((r) => r.node_id))]);
  return rows.map((r): Choice => ({
    ref: choiceRef(r.id),
    node: ref(r.node_id),
    node_name: names.get(r.node_id)?.name ?? ref(r.node_id),
    node_alias: aliases.get(r.node_id) ?? "",
    title: r.title,
    status: r.status,
    status_text: STATUS_TEXT[r.status] ?? r.status,
    recommend: list(r.recommend, isNumber),
    why: r.why,
    created_by: r.created_by,
    task: r.task_id === null ? null : `t${r.task_id}`,
    note: r.note,
    decided_by: r.decided_by,
    decided_at: r.decided_at,
    created_at: r.created_at,
    options: options.get(r.id) ?? [],
  }));
}

function requireRow(db: DatabaseSync, id: number): Row {
  const row = one<Row>(db, "SELECT * FROM choices WHERE id=?", id);
  if (!row)
    throw new Problem(
      404,
      `选项单 ${choiceRef(id)} 不存在`,
      "not_found",
      undefined,
      "atrium choice ls",
    );
  return row;
}

export function getChoice(db: DatabaseSync, reference: unknown): Choice {
  return views(db, [requireRow(db, parseChoiceRef(reference))])[0]!;
}

/** 节点及其下层（不含已归档的下层），至多 200 个。 */
function subtreeIds(list: readonly NodeRow[], rootId: number): number[] {
  const children = new Map<number, NodeRow[]>();
  for (const n of list)
    if (n.parent_id !== null)
      children.set(n.parent_id, [...(children.get(n.parent_id) ?? []), n]);
  const out = [rootId];
  for (let i = 0; i < out.length && out.length < 200; i++)
    for (const c of children.get(out[i]!) ?? [])
      if (c.archived_at === null && out.length < 200) out.push(c.id);
  return out;
}

export type NewChoice = {
  node: string;
  task?: string;
  /** 选项单内容：title、options、recommend、why。 */
  choice: unknown;
};

/** 建一份选项单；node 须是未归档的部分，task（产出它的研究任务）须存在。 */
export function addChoice(
  db: DatabaseSync,
  body: unknown,
  by: string,
  now = Date.now(),
): Choice {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Problem(400, "请求体应为对象", "usage");
  const input = body as Record<string, unknown>;
  for (const key of Object.keys(input))
    if (!["node", "task", "choice"].includes(key))
      throw new Problem(400, `${key}: 是未知字段`, "usage");
  if (typeof input.node !== "string" || !input.node.trim())
    throw new Problem(400, "节点: 必填，如 o3 或 atrium", "usage");
  const choice = validateChoice(input.choice);
  const task =
    input.task === undefined || input.task === null || input.task === ""
      ? null
      : parseTaskRef(input.task, "--task");
  ensureChoiceTables(db);
  return atomically(db, () => {
    const node = nodeByAddress(db, input.node as string);
    if (node.archived_at !== null || node.kind === "concern")
      throw new Problem(
        409,
        `${ref(node.id)} ${node.archived_at !== null ? "已归档" : "是关注点"}，不能挂选项单`,
        "conflict",
        undefined,
        "atrium org tree",
      );
    if (task !== null && !one(db, "SELECT 1 AS ok FROM tasks WHERE id=?", task))
      throw new Problem(
        404,
        `--task: 任务 t${task} 不存在`,
        "not_found",
        undefined,
        "atrium task ls",
      );
    const id = Number(
      db
        .prepare(
          "INSERT INTO choices(node_id,title,recommend,why,status,created_by,task_id,created_at) VALUES(?,?,?,?,'open',?,?,?)",
        )
        .run(
          node.id,
          choice.title,
          JSON.stringify(choice.recommend),
          choice.why,
          by,
          task,
          now,
        ).lastInsertRowid,
    );
    const insert = db.prepare(
      "INSERT INTO choice_options(choice_id,seq,title,gain,why_now,cost,skip,basis) VALUES(?,?,?,?,?,?,?,?)",
    );
    for (const [index, o] of choice.options.entries())
      insert.run(
        id,
        index + 1,
        o.title,
        o.gain,
        o.why_now,
        o.cost,
        o.skip,
        JSON.stringify(o.basis),
      );
    return getChoice(db, choiceRef(id));
  });
}

export function parseLimit(value: unknown): number {
  if (value === undefined || value === "") return PAGE_DEFAULT;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > PAGE_MAX)
    throw new Problem(400, `--limit: 应为 1 到 ${PAGE_MAX} 的整数`, "usage");
  return n;
}

/**
 * 列选项单：开放中的在前，同一档新的在前。node 给了就是这一块及下层；open 只列开放中的。
 * 分页用上一页最后一份的短号（before），按（是否开放, 编号）接着往下取。
 */
export function listChoices(
  db: DatabaseSync,
  options: {
    node?: string;
    open?: boolean;
    before?: unknown;
    limit?: number;
  } = {},
) {
  ensureChoiceTables(db);
  const limit = options.limit ?? PAGE_DEFAULT;
  const list = nodes(db);
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (options.node) {
    const ids = subtreeIds(list, nodeByAddress(db, options.node).id);
    where.push(`node_id IN (${ids.map(() => "?").join(",")})`);
    args.push(...ids);
  }
  if (options.open) where.push("status='open'");
  const filter = where.length ? where.join(" AND ") : "1";
  const pageWhere = [filter];
  const pageArgs = [...args];
  if (
    options.before !== undefined &&
    options.before !== null &&
    options.before !== ""
  ) {
    const cursor = requireRow(db, parseChoiceRef(options.before, "--before"));
    const open = cursor.status === "open" ? 1 : 0;
    pageWhere.push("((status='open')<? OR ((status='open')=? AND id<?))");
    pageArgs.push(open, open, cursor.id);
  }
  const rows = all<Row>(
    db,
    `SELECT * FROM choices WHERE ${pageWhere.join(" AND ")} ORDER BY (status='open') DESC,id DESC LIMIT ?`,
    ...pageArgs,
    limit + 1,
  );
  const page = rows.slice(0, limit);
  const open = one<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM choices WHERE ${filter} AND status='open'`,
    ...args,
  )!.n;
  return {
    choices: views(db, page, new Map(list.map((n) => [n.id, n]))),
    open,
    next_before:
      rows.length > limit ? choiceRef(page[page.length - 1]!.id) : null,
  };
}

/** 几块（本块与下层）的选项单：开放中的在前，同一档新的在前，至多 limit 份。全景用。 */
export function choicesForNodes(
  db: DatabaseSync,
  ids: readonly number[],
  byId: Map<number, NodeRow>,
  limit = 30,
): Choice[] {
  if (!ids.length || !hasChoices(db)) return [];
  return views(
    db,
    all<Row>(
      db,
      `SELECT * FROM choices WHERE node_id IN (${ids.map(() => "?").join(",")}) ORDER BY (status='open') DESC,id DESC LIMIT ?`,
      ...ids,
      limit,
    ),
    byId,
  );
}

const ready = new WeakSet<DatabaseSync>();
/** 表在不在（任务运行时单测不建选项单的表）；建过就记住，不再查。 */
function hasChoices(db: DatabaseSync) {
  if (ready.has(db)) return true;
  const ok = !!one(
    db,
    "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='choices'",
  );
  if (ok) ready.add(db);
  return ok;
}

/** 等用户拍板的选项单：总数与最早的几份（状态栏、top、全景根页入口）。 */
export function pendingChoices(
  db: DatabaseSync,
  max = 3,
): { open: number; list: PendingChoice[] } {
  if (!hasChoices(db)) return { open: 0, list: [] };
  const open = one<{ n: number }>(
    db,
    "SELECT count(*) AS n FROM choices WHERE status='open'",
  )!.n;
  if (!open) return { open: 0, list: [] };
  const rows = all<{
    id: number;
    title: string;
    node_id: number;
    options: number;
    name: string | null;
  }>(
    db,
    `SELECT c.id,c.title,c.node_id,n.name,
       (SELECT count(*) FROM choice_options o WHERE o.choice_id=c.id) AS options
     FROM choices c LEFT JOIN org_nodes n ON n.id=c.node_id
     WHERE c.status='open' ORDER BY c.id LIMIT ?`,
    max,
  );
  return {
    open,
    list: rows.map((r) => ({
      ref: choiceRef(r.id),
      title: r.title,
      options: r.options,
      node: ref(r.node_id),
      node_name: r.name ?? ref(r.node_id),
    })),
  };
}

export type Decided = {
  choice: Choice;
  tasks: { ref: string; option: number; title: string }[];
  decisions: { ref: string; option: number; owner: string }[];
};

/**
 * 拍板（pick 选中几个 / pass 这轮都不要）：一个事务里给选中的在节点下建任务（带选项全文作详述，
 * 事件照常投给该节点最近的 leader 拆解），没选的连同说明记成决定记录（主人是该节点最近的 leader，
 * 没有就是秘书），再把选项单改成已定。
 */
export function decideChoice(
  db: DatabaseSync,
  reference: unknown,
  action: "pick" | "pass",
  body: unknown,
  now = Date.now(),
): Decided {
  const id = parseChoiceRef(reference);
  const input = (body ?? {}) as Record<string, unknown>;
  if (typeof input !== "object" || Array.isArray(input))
    throw new Problem(400, "请求体应为对象", "usage");
  const allowed = action === "pick" ? ["picks", "note"] : ["note"];
  for (const key of Object.keys(input))
    if (!allowed.includes(key))
      throw new Problem(400, `${key}: 是未知字段`, "usage");
  const note = noteOf(input.note);
  ensureChoiceTables(db);
  return atomically(db, () => {
    const row = requireRow(db, id);
    const list = nodes(db);
    const node = list.find((n) => n.id === row.node_id);
    const choice = views(db, [row], new Map(list.map((n) => [n.id, n])))[0]!;
    const verdict = decideVerdict({
      ref: choice.ref,
      status: row.status,
      archived: !node || node.archived_at !== null,
    });
    if (verdict)
      throw new Problem(
        409,
        verdict,
        "conflict",
        undefined,
        `atrium choice show ${choice.ref}`,
      );
    const picks =
      action === "pick"
        ? parsePicks(
            Array.isArray(input.picks) ? input.picks : [input.picks],
            choice.options.length,
          )
        : [];
    const facts: ChoiceFacts = {
      ref: choice.ref,
      title: choice.title,
      node: { ref: choice.node, name: choice.node_name },
      recommend: choice.recommend,
      why: choice.why,
    };
    const owner = partRoute(db, row.node_id).subscriber;
    const tasks: Decided["tasks"] = [];
    const decisions: Decided["decisions"] = [];
    const mark = db.prepare(
      "UPDATE choice_options SET picked=?,task_id=?,decision_id=? WHERE choice_id=? AND seq=?",
    );
    for (const option of choice.options) {
      const o: OptionFacts = option;
      if (picks.includes(option.seq)) {
        const task = createTask(
          db,
          {
            title: option.title,
            part: choice.node,
            brief: pickedBrief(facts, o, note),
          },
          now,
        );
        mark.run(1, task.id, null, id, option.seq);
        tasks.push({ ref: task.ref, option: option.seq, title: option.title });
      } else {
        const text = skippedDecision(facts, o, note, action);
        const decision = addDecision(
          db,
          owner,
          { ...text, by: "u1", node: choice.node },
          now,
        );
        mark.run(0, null, parseInt(decision.ref.slice(1), 10), id, option.seq);
        decisions.push({ ref: decision.ref, option: option.seq, owner });
      }
    }
    db.prepare(
      "UPDATE choices SET status=?,note=?,decided_by='u1',decided_at=? WHERE id=? AND status='open'",
    ).run(statusAfter(action), note, now, id);
    return { choice: getChoice(db, choice.ref), tasks, decisions };
  });
}
