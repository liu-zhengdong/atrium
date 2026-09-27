import type { DatabaseSync } from "node:sqlite";
import type { EventInbox } from "./events.ts";
import { DEFAULT_OWNER, getTask } from "./ledger.ts";
import { nodes } from "../org/model.ts";

/**
 * 把任务结果投递给负责人（#262）：完成、失败、受阻、卡死共用去重键 tN:outcome，CI 用 tN:ci。
 * 审阅任务（#325）不单独投递：结论与失败由审阅关卡记在原任务上再投。
 */
export function publishTask(
  inbox: EventInbox,
  db: DatabaseSync,
  id: number,
  kind: string,
  detail: Record<string, unknown>,
  actor?: string,
) {
  if (db.prepare("SELECT 1 FROM tasks WHERE review_task=? LIMIT 1").get(id))
    return;
  const task = getTask(db, id);
  inbox.publish({
    subscriber: task.owner ?? DEFAULT_OWNER,
    taskId: id,
    source: detail.source === undefined ? "runner" : String(detail.source),
    kind,
    key: `${task.ref}:${kind.startsWith("ci") ? "ci" : "outcome"}`,
    actor,
    detail: {
      title: task.title,
      status: task.status,
      worker: task.worker,
      pr_url: task.pr_url,
      ci: task.ci,
      ...detail,
    },
  });
  if (
    kind === "blocked" &&
    detail.source === "budget" &&
    task.node_id !== null
  ) {
    const list = nodes(db);
    const node = list.find((n) => n.id === task.node_id);
    if (node?.leader && node.leader !== (task.owner ?? DEFAULT_OWNER))
      inbox.publish({
        subscriber: node.leader,
        taskId: id,
        source: "budget",
        kind,
        key: `${task.ref}:budget`,
        actor,
        detail: { title: task.title, ...detail },
      });
  }
}
