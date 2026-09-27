import type { DatabaseSync } from "node:sqlite";
import type { EventInbox } from "./events.ts";
import { getTask } from "./ledger.ts";
import { eventLevel } from "./event-level.ts";
import { nodes } from "../org/model.ts";
import { taskRoute } from "../leaders/subscriber.ts";

/**
 * 把任务结果投递给负责人（#262）：完成、失败、受阻、卡死共用去重键 tN:outcome，CI 用 tN:ci。
 * 审阅任务（#325）不单独投递：结论与失败由审阅关卡记在原任务上再投。
 * 任务没写负责人时投给所属部分最近的 leader，找不到投秘书（leaders/route.ts）；投给谁、为什么写进事件 routed。
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
  const route = taskRoute(db, task);
  inbox.publish({
    subscriber: route.subscriber,
    taskId: id,
    source: detail.source === undefined ? "runner" : String(detail.source),
    kind,
    key: `${task.ref}:${eventLevel(kind, detail) === "action" ? (kind.startsWith("ci") ? "ci" : "outcome") : kind}`,
    actor,
    detail: {
      title: task.title,
      status: task.status,
      worker: task.worker,
      pr_url: task.pr_url,
      ci: task.ci,
      ...detail,
      routed: { to: route.subscriber, why: route.why },
    },
  });
  if (
    kind === "blocked" &&
    detail.source === "budget" &&
    task.node_id !== null
  ) {
    const list = nodes(db);
    const node = list.find((n) => n.id === task.node_id);
    if (node?.leader && node.leader !== route.subscriber)
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
