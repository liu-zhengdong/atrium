import type { DatabaseSync } from "node:sqlite";
import {
  addEvent,
  atomically,
  one,
  parseTaskRef,
  requireRow,
  usage,
  type TaskEventRow,
} from "./ledger-model.ts";
import { ownerOf } from "./ledger-validate.ts";
import type { TaskStatus } from "./state.ts";

export type NoteView = {
  note: string | null;
  note_by: string | null;
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

export function noteView(
  db: DatabaseSync,
  id: number,
  status: TaskStatus,
): NoteView {
  const note = one<TaskEventRow>(
    db,
    "SELECT * FROM task_events WHERE task_id=? AND kind='note' ORDER BY id DESC LIMIT 1",
    id,
  );
  let text: string | null = null;
  let by: string | null = null;
  if (note?.detail) {
    try {
      const parsed: unknown = JSON.parse(note.detail);
      if (parsed && typeof parsed === "object") {
        const detail = parsed as Record<string, unknown>;
        if (typeof detail.text === "string" && typeof detail.by === "string") {
          text = detail.text;
          by = detail.by;
        }
      }
    } catch {
      /* A damaged historical event must not break task reads. */
    }
  }
  const blocked =
    status === "blocked" && text !== null
      ? one<{ id: number }>(
          db,
          "SELECT id FROM task_events WHERE task_id=? AND kind IN ('block','manual_set') ORDER BY id DESC LIMIT 1",
          id,
        )
      : undefined;
  return {
    note: text,
    note_by: by,
    note_at: text === null ? null : note!.at,
    processing: isProcessing(
      status,
      text === null ? null : note!.id,
      blocked?.id ?? null,
    ),
  };
}

export function addTaskNote(
  db: DatabaseSync,
  reference: unknown,
  body: unknown,
  now = Date.now(),
) {
  const id = parseTaskRef(reference);
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw usage("请求体应为 JSON 对象");
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "text" && key !== "by"))
    throw usage("只接受 text、by 字段");
  if (typeof input.text !== "string" || !input.text.trim())
    throw usage("text: 备注不能为空");
  const text = input.text.trim();
  if ([...text].length > 300) throw usage("text: 备注不能超过 300 字");
  const by = input.by === undefined ? "u1" : ownerOf(input.by, "by");
  return atomically(db, () => {
    const task = requireRow(db, id);
    addEvent(db, id, now, "note", { text, by });
    db.prepare("UPDATE tasks SET updated_at=? WHERE id=?").run(now, id);
    return { ...noteView(db, id, task.status) };
  });
}
