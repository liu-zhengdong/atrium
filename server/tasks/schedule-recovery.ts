import type { DatabaseSync } from "node:sqlite";
import { atomically, taskRef } from "./ledger-model.ts";

type TaskEdge = {
  rowid: number;
  task_id: number;
  after_id: number;
  valid_task: number | null;
  valid_after: number | null;
};
type PrEdge = {
  rowid: number;
  task_id: number;
  repo: string;
  number: number;
  merged: number;
  valid_task: number | null;
};
const repoName = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** 老库或手工损坏的单条条件挪到隔离表，不让一条坏记录阻断整份账本。 */
export function repairScheduleRecords(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_schedule_quarantine (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, payload TEXT NOT NULL,
    reason TEXT NOT NULL, quarantined_at INTEGER NOT NULL);`);
  const keep = db.prepare(
    "INSERT INTO task_schedule_quarantine(kind,payload,reason,quarantined_at) VALUES (?,?,?,?)",
  );
  let after = 0;
  for (;;) {
    const rows = db
      .prepare(
        `SELECT d.rowid,d.task_id,d.after_id,t.id AS valid_task,a.id AS valid_after
      FROM task_dependencies d LEFT JOIN tasks t ON t.id=d.task_id
      LEFT JOIN tasks a ON a.id=d.after_id WHERE d.rowid>? ORDER BY d.rowid LIMIT 200`,
      )
      .all(after) as TaskEdge[];
    for (const edge of rows) {
      after = edge.rowid;
      const reason =
        edge.valid_task === null || edge.valid_after === null
          ? "引用的任务不存在"
          : edge.task_id === edge.after_id
            ? "任务依赖自身"
            : null;
      if (!reason) continue;
      atomically(db, () => {
        keep.run(
          "task",
          JSON.stringify({ task_id: edge.task_id, after_id: edge.after_id }),
          reason,
          Date.now(),
        );
        db.prepare(
          "DELETE FROM task_dependencies WHERE task_id=? AND after_id=?",
        ).run(edge.task_id, edge.after_id);
      });
      console.error(
        `任务排期：已隔离 ${taskRef(edge.task_id)} 的坏依赖：${reason}`,
      );
    }
    if (rows.length < 200) break;
  }
  let cursor = 0;
  for (;;) {
    const rows = db
      .prepare(
        `SELECT p.rowid,p.task_id,p.repo,p.number,p.merged,t.id AS valid_task
      FROM task_pr_dependencies p LEFT JOIN tasks t ON t.id=p.task_id
      WHERE p.rowid>? ORDER BY p.rowid LIMIT 200`,
      )
      .all(cursor) as PrEdge[];
    for (const edge of rows) {
      cursor = edge.rowid;
      const reason =
        edge.valid_task === null
          ? "任务不存在"
          : !repoName.test(edge.repo) ||
              !Number.isSafeInteger(edge.number) ||
              edge.number < 1 ||
              ![0, 1].includes(edge.merged)
            ? "PR 条件格式损坏"
            : null;
      if (!reason) continue;
      atomically(db, () => {
        keep.run(
          "pr",
          JSON.stringify({
            task_id: edge.task_id,
            repo: edge.repo,
            number: edge.number,
            merged: edge.merged,
          }),
          reason,
          Date.now(),
        );
        db.prepare("DELETE FROM task_pr_dependencies WHERE rowid=?").run(
          edge.rowid,
        );
      });
      console.error(
        `任务排期：已隔离 ${taskRef(edge.task_id)} 的坏 PR 条件：${reason}`,
      );
    }
    if (rows.length < 200) break;
  }
}
