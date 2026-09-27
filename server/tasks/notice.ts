import type { DatabaseSync } from "node:sqlite";
import type { EventInbox } from "./events.ts";
import { getTask } from "./ledger.ts";
import { eventLevel } from "./event-level.ts";
import { nodes } from "../org/model.ts";
import { partRoute, taskRoute } from "../leaders/subscriber.ts";
import { deliveryRoutes, SECRETARY } from "../leaders/route.ts";
import { involvedOf } from "./also.ts";
import { ref } from "../org/model.ts";
import { hasOrg } from "../org/task-node.ts";

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
  const key =
    kind === "online" || kind === "online_failed"
      ? kind
      : eventLevel(kind, detail) === "info"
        ? kind
        : kind.startsWith("ci")
          ? "ci"
          : "outcome";
  for (const target of deliveryRoutes(kind, route))
    inbox.publish({
      subscriber: target.subscriber,
      taskId: id,
      source: detail.source === undefined ? "runner" : String(detail.source),
      kind,
      key: `${task.ref}:${key}`,
      actor,
      detail: {
        title: task.title,
        status: task.status,
        worker: task.worker,
        pr_url: task.pr_url,
        ci: task.ci,
        ...detail,
        routed: { to: target.subscriber, why: target.why },
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

/**
 * 牵涉知会（#373）：任务新牵涉了某个部分（显式 --also 或管方面要点自动适用），投给那一部分最近的 leader 一条
 * `involved` 事件（info 级，不叫醒，下次唤醒时一并看到）。那一部分找不到 leader、或就是任务本来的投递对象时不投。
 * before 是改动前已牵涉的部分，已知会过的不重复。返回投了哪些部分。
 */
export function publishInvolved(
  inbox: EventInbox,
  db: DatabaseSync,
  id: number,
  before: readonly number[] = [],
  actor?: string,
): string[] {
  if (!hasOrg(db)) return [];
  const task = getTask(db, id);
  if (task.status === "done" || task.status === "cancelled") return [];
  const { also, auto } = involvedOf(db, task);
  const main = taskRoute(db, task).subscriber;
  const list = nodes(db);
  const sent: string[] = [];
  for (const nodeId of [...also, ...auto]) {
    if (before.includes(nodeId)) continue;
    const route = partRoute(db, nodeId);
    if (route.subscriber === SECRETARY || route.subscriber === main) continue;
    const name = list.find((n) => n.id === nodeId)?.name ?? ref(nodeId);
    inbox.publish({
      subscriber: route.subscriber,
      taskId: id,
      source: "ledger",
      kind: "involved",
      key: `${task.ref}:involved:${ref(nodeId)}`,
      actor,
      detail: {
        title: task.title,
        status: task.status,
        part: task.part_ref,
        involved: ref(nodeId),
        involved_name: name,
        auto: auto.includes(nodeId),
        hint: `${task.ref} 牵涉你负责的「${name}」${auto.includes(nodeId) ? "（它的要点适用于这个任务的归属部分）" : ""}：负责与汇报不在你这里；有话写备注 atrium task note ${task.ref} 文字，或捎话 atrium task tell ${task.ref} 文字；要否决发起会审 atrium review add`,
        routed: { to: route.subscriber, why: route.why },
      },
    });
    sent.push(ref(nodeId));
  }
  return sent;
}
