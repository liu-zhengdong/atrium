import type { DatabaseSync } from "node:sqlite";
import {
  addEvent,
  all,
  atomically,
  one,
  requireRow,
  usage,
  type TaskEventRow,
} from "./ledger-model.ts";
import { attributedAuthor } from "./ledger-validate.ts";
import { TELL_MAX_CHARS, type TellEntry, type TellRoute } from "./tell.ts";

/**
 * 捎话的账（#307）：每条记一条 task_events（kind=tell），detail 里是作者、原文、送达方式与送达状态；
 * 送达后原地更新这条事件的 detail，`task show` 看到的就是当前状态。
 */

/** pending：还没送；written：已写进标准输入，等回显确认；delivered：已送达。 */
export type TellState = "pending" | "written" | "delivered";
/** 实际送达的途径：即时写入、续上会话、停掉重派、下次拉起时的提示词。 */
export type TellVia = "stdin" | "resume" | "restart" | "prompt";

export type Tell = TellEntry & {
  id: number;
  uuid: string;
  /** 登记时判定的送达方式。 */
  route: Exclude<TellRoute["kind"], "reject">;
  state: TellState;
  delivered_via?: TellVia;
  delivered_at?: number;
};

/** 同一任务一次最多带多少条（提示词与续上消息都有界）。 */
export const TELLS_MAX = 50;

type Detail = Omit<Tell, "id" | "at">;

function parse(row: TaskEventRow): Tell | undefined {
  try {
    const d = JSON.parse(row.detail ?? "") as Partial<Detail>;
    if (typeof d.text !== "string" || typeof d.by !== "string")
      return undefined;
    return {
      id: row.id,
      at: row.at,
      text: d.text,
      by: d.by,
      uuid: typeof d.uuid === "string" ? d.uuid : "",
      route: d.route ?? "next_run",
      state: d.state ?? "pending",
      ...(d.delivered_via ? { delivered_via: d.delivered_via } : {}),
      ...(d.delivered_at ? { delivered_at: d.delivered_at } : {}),
    };
  } catch {
    // 写坏的历史事件不该挡住读任务。
    return undefined;
  }
}

/** 校验请求体：text 必填、不超过上限；HTTP 作者以认证身份为准。 */
export function tellInput(body: unknown, actor?: string) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw usage("请求体应为 JSON 对象");
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "text" && key !== "by"))
    throw usage("只接受 text、by 字段");
  if (typeof input.text !== "string" || !input.text.trim())
    throw usage("text: 捎话不能为空");
  const text = input.text.trim();
  if ([...text].length > TELL_MAX_CHARS)
    throw usage(`text: 捎话不能超过 ${TELL_MAX_CHARS} 字`);
  const by = attributedAuthor(input.by, actor);
  return { text, by };
}

export function addTell(
  db: DatabaseSync,
  id: number,
  tell: { text: string; by: string; uuid: string; route: Tell["route"] },
  now = Date.now(),
): Tell {
  return atomically(db, () => {
    requireRow(db, id);
    const detail: Detail = { ...tell, state: "pending" };
    addEvent(db, id, now, "tell", detail);
    db.prepare("UPDATE tasks SET updated_at=? WHERE id=?").run(now, id);
    const row = one<TaskEventRow>(
      db,
      "SELECT * FROM task_events WHERE task_id=? AND kind='tell' ORDER BY id DESC LIMIT 1",
      id,
    )!;
    return parse(row)!;
  });
}

/** 任务最近的捎话（按时间先后，至多 TELLS_MAX 条）。 */
export function listTells(db: DatabaseSync, id: number): Tell[] {
  return all<TaskEventRow>(
    db,
    "SELECT * FROM (SELECT * FROM task_events WHERE task_id=? AND kind='tell' ORDER BY id DESC LIMIT ?) ORDER BY id",
    id,
    TELLS_MAX,
  )
    .map(parse)
    .filter((tell): tell is Tell => !!tell);
}

export const unsent = (tells: readonly Tell[]) =>
  tells.filter((tell) => tell.state !== "delivered");

function update(db: DatabaseSync, tell: Tell, patch: Partial<Detail>) {
  const { id: _id, at: _at, ...rest } = tell;
  db.prepare("UPDATE task_events SET detail=? WHERE id=? AND kind='tell'").run(
    JSON.stringify({ ...rest, ...patch }),
    tell.id,
  );
}

export function markWritten(db: DatabaseSync, tell: Tell) {
  update(db, tell, { state: "written" });
}

/** 标为已送达；已送达的不改。返回这次改了几条。 */
export function markDelivered(
  db: DatabaseSync,
  taskId: number,
  ids: readonly number[],
  via: TellVia,
  now = Date.now(),
) {
  if (!ids.length) return 0;
  return atomically(db, () => {
    let changed = 0;
    for (const tell of listTells(db, taskId))
      if (ids.includes(tell.id) && tell.state !== "delivered") {
        update(db, tell, {
          state: "delivered",
          delivered_via: via,
          delivered_at: now,
        });
        changed++;
      }
    return changed;
  });
}

/** 标准输入回显了这条消息（按 uuid 认）。 */
export function markEchoed(db: DatabaseSync, taskId: number, uuid: string) {
  const tell = listTells(db, taskId).find((item) => item.uuid === uuid);
  return tell ? markDelivered(db, taskId, [tell.id], "stdin") : 0;
}

/** 看板用：每个任务的捎话条数与未送达条数。 */
export function tellCounts(db: DatabaseSync, ids: readonly number[]) {
  const counts = new Map<number, { total: number; pending: number }>();
  if (!ids.length) return counts;
  for (const row of all<TaskEventRow>(
    db,
    `SELECT * FROM task_events WHERE kind='tell' AND task_id IN (${ids.map(() => "?").join(",")}) ORDER BY id`,
    ...ids,
  )) {
    const tell = parse(row);
    if (!tell) continue;
    const entry = counts.get(row.task_id) ?? { total: 0, pending: 0 };
    entry.total++;
    if (tell.state !== "delivered") entry.pending++;
    counts.set(row.task_id, entry);
  }
  return counts;
}
