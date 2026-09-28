import type { DatabaseSync } from "node:sqlite";
import { groupOf } from "./clones.ts";

/**
 * 分身认领的事实（t275）：一批任务各属于哪一组（判定在 clones.ts 的 groupOf）。
 * 一批最多几十件，按层批量查，不逐条查库；帮手子任务往上换成父任务，至多 HELPER_DEPTH 层。
 */

const HELPER_DEPTH = 5;

type Row = { id: number; parent_id: number | null; helper: number };

const marks = (n: number) => Array.from({ length: n }, () => "?").join(",");

function rows(db: DatabaseSync, ids: readonly number[]): Map<number, Row> {
  if (!ids.length) return new Map();
  return new Map(
    (
      db
        .prepare(
          `SELECT id,parent_id,helper FROM tasks WHERE id IN (${marks(ids.length)})`,
        )
        .all(...ids) as Row[]
    ).map((r) => [r.id, r]),
  );
}

/** 任务编号 → 组（如 "t197"）；库里没有的编号不出现在结果里。 */
export function taskGroups(
  db: DatabaseSync,
  ids: readonly number[],
): Map<number, string> {
  const wanted = [...new Set(ids)].slice(0, 500);
  const found = rows(db, wanted);
  // 帮手子任务跟父任务走：逐层把帮手换成父任务。
  const resolved = new Map<number, Row>();
  let pending = [...found.values()];
  const origin = new Map<number, number[]>();
  for (const row of pending) origin.set(row.id, [row.id]);
  for (let depth = 0; pending.length && depth <= HELPER_DEPTH; depth++) {
    const next: Row[] = [];
    const parents = rows(
      db,
      pending.flatMap((r) =>
        r.helper && r.parent_id !== null ? [r.parent_id] : [],
      ),
    );
    for (const row of pending) {
      const from = origin.get(row.id) ?? [];
      const parent =
        row.helper && row.parent_id !== null
          ? parents.get(row.parent_id)
          : undefined;
      if (parent && depth < HELPER_DEPTH) {
        origin.set(parent.id, [...(origin.get(parent.id) ?? []), ...from]);
        next.push(parent);
      } else for (const id of from) resolved.set(id, row);
    }
    pending = [...new Map(next.map((r) => [r.id, r])).values()];
  }
  const heads = [...new Set([...resolved.values()].map((r) => r.id))];
  const totals = new Set(
    heads.length
      ? (
          db
            .prepare(
              `SELECT DISTINCT parent_id FROM tasks WHERE helper=0 AND parent_id IN (${marks(heads.length)})`,
            )
            .all(...heads) as { parent_id: number }[]
        ).map((r) => r.parent_id)
      : [],
  );
  const result = new Map<number, string>();
  for (const [id, row] of resolved)
    result.set(
      id,
      groupOf({
        id: row.id,
        parent_id: row.parent_id,
        total: totals.has(row.id),
      }),
    );
  return result;
}
