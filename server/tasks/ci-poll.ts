import type { DatabaseSync } from "node:sqlite";
import { readCi } from "./facts.ts";
import { ciUnavailableReason } from "./ci-classify.ts";
import { exec as defaultExec, type Exec } from "./git.ts";
import { advanceTask, patchRunFields, taskRef, type Task } from "./ledger.ts";
import { concernsOf } from "./concerns.ts";

/**
 * CI 轮询（#262 外部事件源第一版）：只查账本里 ci=pending、有 PR 且未完成或取消的任务，每轮有上限。
 * 出结果就写回 ci 并记事件；任务因「只差 CI」受阻时，CI 通过即补判验收通过（blocked → done）。
 */

export const CI_POLL_MS = 60_000;
export const CI_BATCH = 10;

type Row = { id: number; pr_url: string; status: string };

/** 最近一次关卡判定是否「只差 CI」。 */
export function awaitingCi(db: DatabaseSync, id: number) {
  const row = db
    .prepare(
      "SELECT detail FROM task_events WHERE task_id=? AND kind='gates' ORDER BY id DESC LIMIT 1",
    )
    .get(id) as { detail: string | null } | undefined;
  try {
    return !!(row?.detail && JSON.parse(row.detail).awaiting_ci);
  } catch {
    return false;
  }
}

export type CiOutcome = {
  task: Task;
  ci: string | null;
  detail?: string;
  accepted: boolean;
};

export async function pollCiOnce(
  db: DatabaseSync,
  batch = CI_BATCH,
  run: Exec = defaultExec,
): Promise<CiOutcome[]> {
  const rows = db
    .prepare(
      "SELECT id,pr_url,status FROM tasks WHERE ci='pending' AND pr_url IS NOT NULL AND status NOT IN ('done','cancelled') ORDER BY updated_at,id LIMIT ?",
    )
    .all(batch) as Row[];
  const outcomes: CiOutcome[] = [];
  for (const row of rows) {
    const { ci, detail: ciDetail } = await readCi(row.pr_url, run);
    if (ci === "pending") continue;
    const detail =
      ci === "unavailable" ? ciUnavailableReason(ciDetail) : ciDetail;
    let task = patchRunFields(db, row.id, { ci }, "ci", {
      ci,
      pr_url: row.pr_url,
      ...(detail ? { detail } : {}),
    });
    let accepted = false;
    if (
      ci === "success" &&
      row.status === "blocked" &&
      awaitingCi(db, row.id) &&
      // 请了专员的，本轮都通过才补判；否则由专员关卡在全部出结论时补判。
      concernsOf(db, row.id).every((c) => c.verdict === "pass")
    ) {
      task = advanceTask(
        db,
        taskRef(row.id),
        { kind: "accept" },
        {},
        {
          reason: "CI 通过，验收补判通过",
        },
      );
      accepted = true;
    }
    outcomes.push({ task, ci, detail, accepted });
  }
  return outcomes;
}
