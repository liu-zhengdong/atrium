import type { DatabaseSync } from "node:sqlite";
import { all } from "../org/model.ts";
import { LEADER_RE, leaderBriefs } from "../leaders/model.ts";

/**
 * 全景里「谁」的人话：已登记的 leader 用名字（Atrium 负责人），u1 是「你」，secretary 是「秘书」；
 * 其余照原样。短号仍随 ref 给出，网页弱化显示。
 */

export type Person = { ref: string; name: string };
export type TaskNote = { text: string; at: number; by: Person };
export type TaskPeople = { by: Person | null; note: TaskNote | null };

export function peopleNames(db: DatabaseSync): Map<string, string> {
  const names = new Map<string, string>([
    ["u1", "你"],
    ["secretary", "秘书"],
  ]);
  for (const [ref, brief] of leaderBriefs(db)) names.set(ref, brief.name);
  return names;
}

export const personOf = (
  ref: string,
  names: ReadonlyMap<string, string>,
): Person => ({ ref, name: names.get(ref) ?? ref });

const parse = (text: string | null): Record<string, unknown> => {
  try {
    const value: unknown = text === null ? null : JSON.parse(text);
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

/**
 * 每个任务是谁派的（建任务的 leader，记在 created 事件的 by）与最新一条备注（作者换成名字）。
 * 只认 leader 派的：用户与运行时建的任务是常态，不单独标。
 */
export function taskPeople(
  db: DatabaseSync,
  ids: readonly number[],
  names: ReadonlyMap<string, string> = peopleNames(db),
): Map<number, TaskPeople> {
  const map = new Map<number, TaskPeople>();
  if (!ids.length) return map;
  const marks = ids.map(() => "?").join(",");
  for (const id of ids) map.set(id, { by: null, note: null });
  for (const row of all<{ task_id: number; detail: string | null }>(
    db,
    `SELECT task_id,detail FROM task_events WHERE kind='created' AND task_id IN (${marks}) LIMIT ${ids.length}`,
    ...ids,
  )) {
    const by = parse(row.detail).by;
    if (typeof by === "string" && LEADER_RE.test(by))
      map.get(row.task_id)!.by = personOf(by, names);
  }
  for (const row of all<{ task_id: number; at: number; detail: string | null }>(
    db,
    `SELECT e.task_id,e.at,e.detail FROM task_events e
      JOIN (SELECT task_id,MAX(id) AS id FROM task_events WHERE kind='note' AND task_id IN (${marks}) GROUP BY task_id) m
        ON m.id=e.id LIMIT ${ids.length}`,
    ...ids,
  )) {
    const detail = parse(row.detail);
    if (typeof detail.text === "string" && typeof detail.by === "string")
      map.get(row.task_id)!.note = {
        text: detail.text,
        at: row.at,
        by: personOf(detail.by, names),
      };
  }
  return map;
}
