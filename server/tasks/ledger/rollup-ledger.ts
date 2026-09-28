import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../../problem.ts";
import { addEvent, all, one, taskRef, type TaskRow } from "./ledger-model.ts";
import { FINISHED, type TaskStatus } from "./state.ts";
import { dequeue } from "../dispatch/queue.ts";
import {
  progressOf,
  rollupsOf,
  storedStatusFor,
  type Rollup,
  type SubtreeRow,
} from "./rollup.ts";
import { marks } from "../../sqlite.ts";

/**
 * 总任务（t190）的取数与落账；判定在 rollup.ts。
 * 「子任务」只数 helper=0 的：审阅是运行时替父任务建的帮手，不让父任务变成总任务。
 */

/** 一次汇总最多读多少个子孙（k23：有界）；超出的标 truncated，进度写「+」。 */
export const ROLLUP_MAX = 5000;
const BATCH = 400;

/** 这个任务下面有没有（非帮手）子任务。 */
export const isTotal = (db: DatabaseSync, id: number) =>
  !!one(db, "SELECT 1 FROM tasks WHERE parent_id=? AND helper=0 LIMIT 1", id);

/** 派总任务时的人话提示：task run、task run --dry-run、自动派发都用这一句。 */
export const totalRefusal = (ref: string) =>
  new Problem(
    409,
    `${ref} 是总任务，派它下面的子任务（总任务不派给执行者，状态与进度按子孙汇总）`,
    "conflict",
    undefined,
    `atrium task tree ${ref}`,
  );

/** ids 里哪些是总任务：按父任务批量查一次，不逐个查。 */
export function totalsAmong(db: DatabaseSync, ids: readonly number[]) {
  const found = new Set<number>();
  for (let offset = 0; offset < ids.length; offset += BATCH) {
    const batch = ids.slice(offset, offset + BATCH);
    for (const row of all<{ parent_id: number }>(
      db,
      `SELECT DISTINCT parent_id FROM tasks WHERE helper=0 AND parent_id IN (${marks(batch)})`,
      ...batch,
    ))
      found.add(row.parent_id);
  }
  return found;
}

const COLUMNS = "id, parent_id, status, delivery_stage, online_wait";

/** 从 seeds 往下取全部（非帮手）子孙，一条递归查询、至多 ROLLUP_MAX 行。 */
function subtree(db: DatabaseSync, seeds: readonly number[]) {
  if (!seeds.length) return { rows: [] as SubtreeRow[], truncated: false };
  const rows = all<SubtreeRow>(
    db,
    `WITH RECURSIVE sub(${COLUMNS}) AS (
       SELECT ${COLUMNS} FROM tasks WHERE helper=0 AND parent_id IN (${marks(seeds)})
       UNION
       SELECT t.id, t.parent_id, t.status, t.delivery_stage, t.online_wait
       FROM tasks t JOIN sub ON t.parent_id=sub.id WHERE t.helper=0
       LIMIT ?)
     SELECT sub.*, EXISTS(SELECT 1 FROM tasks c WHERE c.parent_id=sub.id AND c.helper=0) AS has_children
     FROM sub`,
    ...seeds,
    ROLLUP_MAX + 1,
  );
  const truncated = rows.length > ROLLUP_MAX;
  if (truncated) rows.length = ROLLUP_MAX;
  return { rows, truncated };
}

/**
 * ids 里总任务的汇总（中间层一并算出）。先挑出总任务，再只从最上面的那些往下取一次。
 * ids 至多几百个（一页列表、一棵树），查询条数是常数。
 */
export function rollups(
  db: DatabaseSync,
  ids: readonly number[],
): Map<number, Rollup> {
  const totals = totalsAmong(db, ids);
  if (!totals.size) return new Map();
  const seeds: number[] = [];
  const list = [...totals];
  for (let offset = 0; offset < list.length; offset += BATCH) {
    const batch = list.slice(offset, offset + BATCH);
    // 父任务也在 totals 里的，会从上面那个一起取到，不必再当起点。
    const nested = new Set(
      all<{ id: number }>(
        db,
        `SELECT id FROM tasks WHERE id IN (${marks(batch)}) AND parent_id IN (${marks(batch)})`,
        ...batch,
        ...batch,
      ).map((row) => row.id),
    );
    for (const id of batch) if (!nested.has(id)) seeds.push(id);
  }
  const { rows, truncated } = subtree(db, seeds);
  const computed = rollupsOf(rows, truncated);
  const result = new Map<number, Rollup>();
  for (const id of totals) {
    const rollup = computed.get(id);
    if (rollup) result.set(id, rollup);
  }
  return result;
}

export const rollupFor = (db: DatabaseSync, id: number) =>
  rollups(db, [id]).get(id) ?? null;

/** 自下而上的祖先链（父、祖父……根），至多 64 层；帮手子任务没有总任务可言，返回空。 */
export function ancestorsOf(db: DatabaseSync, id: number): number[] {
  const chain = all<{ id: number; helper: number }>(
    db,
    `WITH RECURSIVE up(id, parent_id, helper, depth) AS (
       SELECT id, parent_id, helper, 0 FROM tasks WHERE id=?
       UNION ALL
       SELECT t.id, t.parent_id, t.helper, up.depth+1 FROM tasks t JOIN up ON t.id=up.parent_id
       WHERE up.depth < 64)
     SELECT id, helper FROM up ORDER BY depth`,
    id,
  );
  if (!chain.length || chain[0]!.helper) return [];
  return chain.slice(1).map((row) => row.id);
}

export type RollupChange = {
  id: number;
  from: TaskStatus;
  to: TaskStatus;
  rollup: Rollup;
};

/**
 * 某个任务变了之后，把它上面每一层总任务在账本里存的状态跟上汇总（自下而上，同一事务里做）。
 * 返回改了哪些，以及根上的总任务（没有祖先时为 null）和它的汇总，供通知用。
 * 已派进排队的总任务撤出排队：它不再派给执行者。
 */
export function syncTotals(db: DatabaseSync, id: number, now = Date.now()) {
  const ancestors = ancestorsOf(db, id);
  if (!ancestors.length)
    return { changes: [] as RollupChange[], root: null, ancestors };
  const root = ancestors.at(-1)!;
  const { rows, truncated } = subtree(db, [root]);
  const computed = rollupsOf(rows, truncated);
  const current = new Map(
    all<Pick<TaskRow, "id" | "status">>(
      db,
      `SELECT id, status FROM tasks WHERE id IN (${marks(ancestors)})`,
      ...ancestors,
    ).map((row) => [row.id, row.status]),
  );
  const changes: RollupChange[] = [];
  for (const ancestor of ancestors) {
    const rollup = computed.get(ancestor);
    const status = current.get(ancestor);
    if (!rollup || !status) continue;
    if (dequeue(db, ancestor))
      addEvent(db, ancestor, now, "dequeued", {
        reason: `${taskRef(ancestor)} 有了子任务，成了总任务，不再派给执行者`,
      });
    const target = storedStatusFor(status, rollup);
    if (!target) continue;
    db.prepare(
      `UPDATE tasks SET status=?,ended_at=?,updated_at=? WHERE id=?`,
    ).run(target, FINISHED.has(target) ? now : null, now, ancestor);
    addEvent(db, ancestor, now, "rollup", {
      from: status,
      to: target,
      progress: progressOf(rollup),
    });
    changes.push({ id: ancestor, from: status, to: target, rollup });
  }
  return {
    changes,
    root: { id: root, rollup: computed.get(root) ?? null },
    ancestors,
  };
}

/** 总任务未结束的子孙（取消连带用），自上而下，至多 ROLLUP_MAX 个。 */
export function openDescendants(db: DatabaseSync, id: number) {
  const { rows } = subtree(db, [id]);
  return rows
    .filter((row) => row.status !== "done" && row.status !== "cancelled")
    .map((row) => ({ id: row.id, status: row.status }))
    .sort((a, b) => a.id - b.id);
}
