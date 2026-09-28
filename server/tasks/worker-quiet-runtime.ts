import type { DatabaseSync } from "node:sqlite";
import type { Active } from "./active.ts";
import { noteTask } from "./ledger.ts";
import {
  workerQuiet,
  workerQuietReason,
  workerQuietText,
} from "./worker-quiet.ts";

/**
 * 看门狗每轮对一个执行者做没进展提醒（t260）：判定在 worker-quiet.ts。
 * 到提醒线记 worker_quiet 并知会负责的 leader（知会级事件，不叫醒）；
 * 提醒过又有进展了记一笔 resumed，状态栏不再显示。progressed 是这一轮看到了进展信号。
 */
export function watchQuiet(input: {
  db: DatabaseSync;
  active: Active;
  progressed: boolean;
  warnMs: number | undefined;
  now: number;
  publish: (id: number, kind: string, detail: Record<string, unknown>) => void;
}) {
  const { active } = input;
  if (input.progressed && active.quietWarned) {
    active.quietWarned = false;
    noteTask(input.db, active.id, "worker_quiet", { resumed: true });
    return;
  }
  if (!input.warnMs) return;
  const due = workerQuiet({
    state: active.state,
    limits: active.limits,
    warnMs: input.warnMs,
    warned: !!active.quietWarned,
    stopping: !!active.stop || !!active.finalizing,
    now: input.now,
  });
  if (due.kind === "ok") return;
  active.quietWarned = true;
  const reason = workerQuietReason(due.quietMs, due.stallMs);
  const text = workerQuietText(active.worker.id, due.quietMs);
  noteTask(input.db, active.id, "worker_quiet", {
    reason,
    text,
    quiet_ms: due.quietMs,
  });
  input.publish(active.id, "worker_quiet", { reason, text });
}
