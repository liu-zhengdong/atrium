import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import {
  all,
  nodeByAddress,
  nodes,
  one,
  ref,
  transaction,
  type Kind,
  type NodeRow,
} from "../org/model.ts";
import { addNode, charterFields, editOverviewFields } from "../org/write.ts";
import {
  addLeader,
  ensureLeaderTables,
  LEADER_RE,
  NAME_MAX,
} from "../leaders/model.ts";
import { memoText, writeMemo } from "../memos/store.ts";
import { everyText, parseEvery } from "../schedules/plan.ts";
import { scheduleRef, type ScheduleRow } from "../schedules/model.ts";
import { leaderMemo, productFields, type ProductNames } from "./brief.ts";

/**
 * 产品部（#404 第 3 步）：设在任意节点下的一块普通部分，管父节点的演进。`products` 一个产品部一行，
 * 记它挂在哪（parent_id）、leader 与周期研究（schedule_id）。旧运行时没有同名表。
 * 研究任务的认法：它是这条周期任务某一轮建出的任务（schedule_runs.task_id）。
 */
export function ensureProductTables(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS products (
    node_id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL,
    leader TEXT NOT NULL, schedule_id INTEGER,
    created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS products_parent ON products(parent_id);
    CREATE INDEX IF NOT EXISTS products_schedule ON products(schedule_id);`);
  ready.add(db);
}

const ready = new WeakSet<DatabaseSync>();
/** 表在不在（任务运行时单测不建产品部的表）；建过就记住。 */
function hasProducts(db: DatabaseSync) {
  if (ready.has(db)) return true;
  const ok = !!one(
    db,
    "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='products'",
  );
  if (ok) ready.add(db);
  return ok;
}

export type ProductRow = {
  node_id: number;
  parent_id: number;
  leader: string;
  schedule_id: number | null;
  created_at: number;
};

/** 这个节点是不是产品部；不是为 undefined。 */
export function productOfNode(
  db: DatabaseSync,
  nodeId: number,
): ProductRow | undefined {
  if (!hasProducts(db)) return undefined;
  return one<ProductRow>(db, "SELECT * FROM products WHERE node_id=?", nodeId);
}

/** 这件任务是不是某个产品部周期研究的一轮；是就给出产品部。 */
export function productRound(
  db: DatabaseSync,
  taskId: number,
): ProductRow | undefined {
  if (!hasProducts(db)) return undefined;
  return one<ProductRow>(
    db,
    `SELECT p.* FROM schedule_runs r JOIN products p ON p.schedule_id=r.schedule_id
      WHERE r.task_id=? LIMIT 1`,
    taskId,
  );
}

const usage = (message: string, next?: string) =>
  new Problem(400, message, "usage", undefined, next);

const CHILD: Record<Kind, Kind | null> = {
  org: "project",
  project: "module",
  module: "module",
  concern: null,
};

export const DEFAULT_EVERY = "7d";
export const DEFAULT_NAME = "产品部";

/** 同一父节点下没用过的路径名：product、product-2…（纯函数）。 */
export function productSlug(taken: ReadonlySet<string>): string {
  if (!taken.has("product")) return "product";
  for (let i = 2; ; i++) if (!taken.has(`product-${i}`)) return `product-${i}`;
}

/** 往上最近的已登记 leader 的执行者组合；产品部 leader 没给 --worker 时沿用。 */
function inheritedWorker(
  db: DatabaseSync,
  list: readonly NodeRow[],
  from: NodeRow,
): string | null {
  const byId = new Map(list.map((n) => [n.id, n]));
  const seen = new Set<number>();
  let current: NodeRow | undefined = from;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const match = current.leader ? LEADER_RE.exec(current.leader) : null;
    if (match) {
      const row = one<{ worker: string }>(
        db,
        "SELECT worker FROM org_leaders WHERE id=?",
        Number(match[1]),
      );
      if (row) return row.worker;
    }
    current =
      current.parent_id === null ? undefined : byId.get(current.parent_id);
  }
  return null;
}

type AddInput = {
  node: string;
  name: string;
  every: string;
  at: string | null;
  worker: string | null;
};

function addInput(raw: unknown): AddInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw usage("请求体应为 JSON 对象");
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body))
    if (!["node", "name", "every", "at", "worker"].includes(key))
      throw usage(`${key}: 是未知字段`);
  if (typeof body.node !== "string" || !body.node.trim())
    throw usage("节点: 必填，产品部设在哪个节点下，如 o2 或 atrium");
  const optional = (key: string, flag: string) => {
    const value = body[key];
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string" || !value.trim())
      throw usage(`${flag}: 应为文本`);
    return value.trim();
  };
  const name = optional("name", "--name") ?? DEFAULT_NAME;
  if (Array.from(name).length > 100) throw usage("--name: 至多 100 字");
  return {
    node: body.node.trim(),
    name,
    every: optional("every", "--every") ?? DEFAULT_EVERY,
    at: optional("at", "--at"),
    worker: optional("worker", "--worker"),
  };
}

export type ProductView = {
  node: string;
  name: string;
  parent: string;
  parent_name: string;
  leader: string;
  schedule: string | null;
  every: string | null;
  next_at: number | null;
  schedule_state: "active" | "removed" | null;
  last_task: string | null;
  created_at: number;
};

function viewsOf(db: DatabaseSync, rows: readonly ProductRow[]) {
  if (!rows.length) return [];
  const byId = new Map(nodes(db).map((n) => [n.id, n]));
  const ids = rows.flatMap((r) =>
    r.schedule_id === null ? [] : [r.schedule_id],
  );
  const schedules = new Map(
    ids.length
      ? all<ScheduleRow>(
          db,
          `SELECT * FROM schedules WHERE id IN (${ids.map(() => "?").join(",")})`,
          ...ids,
        ).map((s) => [s.id, s])
      : [],
  );
  return rows.map((r): ProductView => {
    const s = r.schedule_id === null ? undefined : schedules.get(r.schedule_id);
    const state = !s
      ? null
      : s.removed_at !== null
        ? ("removed" as const)
        : ("active" as const);
    return {
      node: ref(r.node_id),
      name: byId.get(r.node_id)?.name ?? ref(r.node_id),
      parent: ref(r.parent_id),
      parent_name: byId.get(r.parent_id)?.name ?? ref(r.parent_id),
      leader: r.leader,
      schedule: s ? scheduleRef(s.id) : null,
      every: s ? everyText(s.every_ms) : null,
      next_at: state === "active" ? s!.next_at : null,
      schedule_state: state,
      last_task: s?.last_task_id ? `t${s.last_task_id}` : null,
      created_at: r.created_at,
    };
  });
}

export const LIST_MAX = 200;

/** 产品部列表（未归档的），按节点号；--node 只看这一块下的。 */
export function listProducts(db: DatabaseSync, node?: string) {
  ensureProductTables(db);
  const parent = node ? nodeByAddress(db, node).id : null;
  const rows = all<ProductRow>(
    db,
    `SELECT p.* FROM products p JOIN org_nodes n ON n.id=p.node_id
      WHERE n.archived_at IS NULL ${parent === null ? "" : "AND p.parent_id=?"}
      ORDER BY p.node_id LIMIT ?`,
    ...(parent === null ? [] : [parent]),
    LIST_MAX,
  );
  return { products: viewsOf(db, rows) };
}

/**
 * 成立产品部（一个事务）：在节点下建一块普通部分并写好人话字段、登记它的 leader、
 * 挂一条 research 周期任务（addSchedule 由调用方注入，用服务的时钟与时区）。
 * 同一节点下只设一个产品部；leader 的执行者组合沿用往上最近的已登记 leader，没有就要 --worker。
 */
export function addProduct(
  db: DatabaseSync,
  raw: unknown,
  addSchedule: (body: Record<string, unknown>) => number,
  now = Date.now(),
): ProductView {
  const input = addInput(raw);
  const every = parseEvery(input.every);
  ensureLeaderTables(db);
  ensureProductTables(db);
  return transaction(db, () => {
    const list = nodes(db);
    const parent = nodeByAddress(db, input.node);
    if (parent.archived_at !== null)
      throw new Problem(409, `${ref(parent.id)} 已归档`, "conflict");
    const kind = CHILD[parent.kind];
    if (!kind)
      throw usage(
        `${ref(parent.id)} ${parent.name} 是专员（关注点），下面不能设产品部`,
        "atrium org tree",
      );
    const existing = one<{ node_id: number }>(
      db,
      `SELECT p.node_id FROM products p JOIN org_nodes n ON n.id=p.node_id
        WHERE p.parent_id=? AND n.archived_at IS NULL LIMIT 1`,
      parent.id,
    );
    if (existing)
      throw new Problem(
        409,
        `${parent.name}（${ref(parent.id)}）下已有产品部 ${ref(existing.node_id)}`,
        "conflict",
        undefined,
        `atrium product ls --node ${ref(parent.id)}`,
      );
    const worker = input.worker ?? inheritedWorker(db, list, parent);
    if (!worker)
      throw usage(
        `--worker: 必填——${parent.name} 和上级都没有登记的 leader 可以沿用，写产品部 leader 与研究任务用哪个执行者，如 claude+opus:high`,
      );
    const alias = (() => {
      const fields = charterFields(db, parent.id);
      return typeof fields.alias === "string" ? fields.alias.trim() : "";
    })();
    const leader = addLeader(
      db,
      {
        name: Array.from(`${parent.name} ${input.name}`)
          .slice(0, NAME_MAX)
          .join(""),
        worker,
      },
      now,
    ).ref;
    const taken = new Set(
      list.filter((n) => n.parent_id === parent.id).map((n) => n.slug),
    );
    const created = addNode(
      db,
      {
        parent: ref(parent.id),
        slug: productSlug(taken),
        kind,
        name: input.name,
        leader,
        reason: `成立产品部，管 ${parent.name} 的演进（atrium product add）`,
      },
      "u1",
    ) as { id: number };
    const names: Omit<ProductNames, "schedule"> = {
      parent: { ref: ref(parent.id), name: parent.name, alias },
      product: { ref: ref(created.id), name: input.name },
      leader,
      every_ms: every,
    };
    editOverviewFields(db, ref(created.id), productFields(names), "u1");
    db.prepare(
      "INSERT INTO products(node_id,parent_id,leader,schedule_id,created_at) VALUES (?,?,?,NULL,?)",
    ).run(created.id, parent.id, leader, now);
    // 登记周期任务时会试建一轮：此时产品部已在，研究详述的材料也一起试取一遍。
    const schedule = addSchedule({
      node: ref(created.id),
      title: `${parent.name} 下一步调研`,
      kind: "research",
      every: input.every,
      ...(input.at ? { at: input.at } : {}),
      ...(input.worker ? { worker: input.worker } : {}),
    });
    db.prepare("UPDATE products SET schedule_id=? WHERE node_id=?").run(
      schedule,
      created.id,
    );
    writeMemo(
      db,
      leader,
      memoText(leaderMemo({ ...names, schedule: scheduleRef(schedule) })),
      now,
    );
    return viewsOf(db, [
      one<ProductRow>(
        db,
        "SELECT * FROM products WHERE node_id=?",
        created.id,
      )!,
    ])[0]!;
  });
}
