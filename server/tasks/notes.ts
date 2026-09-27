import type { DatabaseSync } from "node:sqlite";
import {
  addEvent,
  all,
  atomically,
  one,
  parseTaskRef,
  requireRow,
  usage,
  type TaskEventRow,
} from "./ledger-model.ts";
import { attributedAuthor } from "./ledger-validate.ts";
import type { TaskStatus } from "./state.ts";

export type NoteView = {
  note: string | null;
  note_by: string | null;
  /** 作者是登记过的 leader 时给名字（Atrium 负责人），其余为 null。 */
  note_by_name?: string | null;
  note_at: number | null;
  processing: boolean;
};

/** 同毫秒事件按自增 id 定序；只有受阻事件之后的有效备注才表示有人处理。 */
export const isProcessing = (
  status: TaskStatus,
  noteId: number | null,
  blockedId: number | null,
) =>
  status === "blocked" &&
  noteId !== null &&
  blockedId !== null &&
  noteId > blockedId;

/** 事件详情里的备注正文与作者；坏的历史事件当没有备注，不让读任务出错。 */
function parseNote(detail: string | null) {
  if (!detail) return null;
  try {
    const parsed: unknown = JSON.parse(detail);
    if (parsed && typeof parsed === "object") {
      const note = parsed as Record<string, unknown>;
      if (typeof note.text === "string" && typeof note.by === "string")
        return { text: note.text, by: note.by };
    }
  } catch {
    /* A damaged historical event must not break task reads. */
  }
  return null;
}

/** 按 id 集合分批一条 SQL，不在循环里逐个查库（k23）。 */
const BATCH = 400;
function batched<T>(
  ids: number[],
  query: (ids: number[], marks: string) => T[],
): T[] {
  const rows: T[] = [];
  for (let offset = 0; offset < ids.length; offset += BATCH) {
    const chunk = ids.slice(offset, offset + BATCH);
    rows.push(...query(chunk, chunk.map(() => "?").join(",")));
  }
  return rows;
}

function leaderNames(db: DatabaseSync, authors: Iterable<string>) {
  const ids = new Set<number>();
  for (const by of authors) {
    const match = /^a([1-9][0-9]{0,8})$/.exec(by);
    if (match) ids.add(Number(match[1]));
  }
  const names = new Map<string, string>();
  if (
    !ids.size ||
    !one(
      db,
      "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='org_leaders'",
    )
  )
    return names;
  for (const { id, name } of batched([...ids], (chunk, marks) =>
    all<{ id: number; name: string }>(
      db,
      `SELECT id, name FROM org_leaders WHERE id IN (${marks})`,
      ...chunk,
    ),
  ))
    names.set(`a${id}`, name);
  return names;
}

/** 一批任务的最新备注：语句数只随批数增长，不随任务数逐条增长。 */
export function noteViews(
  db: DatabaseSync,
  tasks: { id: number; status: TaskStatus }[],
): Map<number, NoteView> {
  const latest = new Map<
    number,
    { id: number; at: number; text: string; by: string }
  >();
  for (const event of batched(
    tasks.map((task) => task.id),
    (chunk, marks) =>
      all<Pick<TaskEventRow, "id" | "task_id" | "at" | "detail">>(
        db,
        `SELECT id, task_id, at, detail FROM task_events WHERE id IN (
           SELECT MAX(id) FROM task_events
           WHERE task_id IN (${marks}) AND kind='note' GROUP BY task_id)`,
        ...chunk,
      ),
  )) {
    const note = parseNote(event.detail);
    if (note)
      latest.set(event.task_id, { id: event.id, at: event.at, ...note });
  }
  const blocked = new Map<number, number>();
  for (const { task_id, id } of batched(
    tasks
      .filter((task) => task.status === "blocked" && latest.has(task.id))
      .map((task) => task.id),
    (chunk, marks) =>
      all<{ task_id: number; id: number }>(
        db,
        `SELECT task_id, MAX(id) AS id FROM task_events
         WHERE task_id IN (${marks}) AND kind IN ('block','manual_set') GROUP BY task_id`,
        ...chunk,
      ),
  ))
    blocked.set(task_id, id);
  const names = leaderNames(
    db,
    [...latest.values()].map((note) => note.by),
  );
  const views = new Map<number, NoteView>();
  for (const task of tasks) {
    const note = latest.get(task.id);
    views.set(task.id, {
      note: note?.text ?? null,
      note_by: note?.by ?? null,
      note_by_name: note ? (names.get(note.by) ?? null) : null,
      note_at: note?.at ?? null,
      processing: isProcessing(
        task.status,
        note?.id ?? null,
        blocked.get(task.id) ?? null,
      ),
    });
  }
  return views;
}

export function noteView(
  db: DatabaseSync,
  id: number,
  status: TaskStatus,
): NoteView {
  return noteViews(db, [{ id, status }]).get(id)!;
}

export function addTaskNote(
  db: DatabaseSync,
  reference: unknown,
  body: unknown,
  now = Date.now(),
  actor?: string,
) {
  const id = parseTaskRef(reference);
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw usage("请求体应为 JSON 对象");
  const input = body as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => !["text", "by", "verdict"].includes(key))
  )
    throw usage("只接受 text、by、verdict 字段");
  if (
    input.verdict !== undefined &&
    !["ok", "fixed", "rejected"].includes(String(input.verdict))
  )
    throw usage("verdict: 只能是 ok、fixed、rejected");
  if (typeof input.text !== "string" || !input.text.trim())
    throw usage("text: 备注不能为空");
  const text = input.text.trim();
  if ([...text].length > 300) throw usage("text: 备注不能超过 300 字");
  const by = attributedAuthor(input.by, actor);
  return atomically(db, () => {
    const task = requireRow(db, id);
    addEvent(db, id, now, "note", {
      text,
      by,
      ...(input.verdict ? { verdict: input.verdict } : {}),
    });
    db.prepare("UPDATE tasks SET updated_at=? WHERE id=?").run(now, id);
    return { ...noteView(db, id, task.status) };
  });
}
