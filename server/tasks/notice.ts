import type { DatabaseSync } from "node:sqlite";
import type { EventInbox } from "./events.ts";
import { atomically, getTask, noteTask, type Task } from "./ledger.ts";
import { one, taskRef } from "./ledger-model.ts";
import { finishedLeaves, syncTotals } from "./rollup-ledger.ts";
import {
  leafDelivery,
  progressOf,
  totalOnlineMessage,
  type Rollup,
} from "./rollup.ts";
import { verificationSection } from "./online.ts";
import { eventLevel } from "./event-level.ts";
import { nodes } from "../org/model.ts";
import { partRoute, taskRoute } from "../leaders/subscriber.ts";
import { deliveryRoutes, SECRETARY } from "../leaders/route.ts";
import { involvedOf } from "./also.ts";
import { ref } from "../org/model.ts";
import { hasOrg } from "../org/task-node.ts";
import { URGENT_WATCHERS, urgentAlert, urgentStage } from "./urgent.ts";
import { downstreamOf } from "./schedule-ledger.ts";
import { downstreamHint } from "../leaders/hang.ts";

/**
 * 紧急任务的阶段推送（t215）：开始、止损、抢占、交付、检查、合入、上线（附验证）、失败、受阻、卡死重试、换人
 * 各投一条 urgent_stage 给秘书与用户。只有上线、卡住、止损失败要处理（叫醒秘书、推到手机，t219），
 * 其余是知会（进 events digest 与状态栏）；同一任务未确认的按级别各合并成最新一条
 * （去重键 tN:urgent 与 tN:urgent_info，知会不会盖掉还没处理的要处理）。
 * 不是紧急任务或不是要推送的阶段不投；返回投了没有。
 */
export function publishUrgentStage(
  inbox: EventInbox,
  db: DatabaseSync,
  id: number,
  kind: string,
  detail: Record<string, unknown> = {},
  task?: Task,
): boolean {
  const stage = urgentStage(kind);
  if (!stage) return false;
  const row = task ?? getTask(db, id);
  if (row.urgent !== 1) return false;
  const reason =
    typeof detail.reason === "string" && detail.reason
      ? `：${detail.reason}`
      : "";
  const alert = urgentAlert(kind, detail);
  for (const subscriber of URGENT_WATCHERS)
    inbox.publish({
      subscriber,
      taskId: id,
      source: "urgent",
      kind: "urgent_stage",
      key: `${row.ref}:${alert ? "urgent" : "urgent_info"}`,
      detail: {
        title: row.title,
        status: row.status,
        worker: row.worker,
        pr_url: row.pr_url,
        ...detail,
        // 分级按 event 判（eventLevel），放在展开之后免得被原事件的同名字段盖掉。
        stage,
        event: kind,
        // 一句话放在 message：事件列表与秘书唤醒都先读它。
        message: `紧急 ${row.ref}「${row.title}」${stage}${reason}`.slice(
          0,
          300,
        ),
        next: `atrium task show ${row.ref}`,
      },
    });
  return true;
}

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
): number[] {
  // 审阅任务（含紧急任务合入后并行的审阅，t215）的结论由原任务上记再投。
  if (
    db
      .prepare(
        "SELECT 1 FROM tasks WHERE review_task=? UNION ALL SELECT 1 FROM task_after_reviews WHERE review_task=? LIMIT 1",
      )
      .get(id, id)
  )
    return [];
  // 总任务（t190）：先让上面每层总任务的状态跟上，再按「秘书只收总任务级的」分投。
  const totals = atomically(db, () => syncTotals(db, id));
  const task = getTask(db, id);
  const route = taskRoute(db, task);
  const key =
    kind === "online" || kind === "online_failed"
      ? kind
      : // 上线验证没通过、无法验证（t182）：同一任务只留最新一条，不和完成、失败合并。
        kind.startsWith("verify_")
        ? "verify"
        : eventLevel(kind, detail) === "info"
          ? kind
          : kind.startsWith("ci")
            ? "ci"
            : "outcome";
  // 上游失败（t253）：告诉负责人下游有哪些在等它、可以怎么办，别让下游一直挂着。
  const downstream =
    kind === "failed" || kind === "online_failed"
      ? downstreamOf(db, id)
      : { refs: [], more: 0 };
  const downstreamDetail = downstream.refs.length
    ? {
        downstream: downstream.refs,
        downstream_hint: downstreamHint({
          upstream: [task.ref],
          downstream: downstream.refs,
          more: downstream.more,
        }),
      }
    : {};
  let targets = deliveryRoutes(kind, route);
  if (totals.root) {
    const split = leafDelivery(
      kind,
      targets.map((target) => target.subscriber),
      route.subscriber,
      SECRETARY,
    );
    targets = targets.filter((target) => split.to.includes(target.subscriber));
    if (split.stuck)
      publishStuck(inbox, db, totals.root, task, kind, detail, actor);
  }
  for (const target of targets)
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
        ...downstreamDetail,
        routed: { to: target.subscriber, why: target.why },
      },
    });
  if (totals.root) publishTotalOnline(inbox, db, totals.root);
  // 紧急任务（t215）：各阶段另外推给秘书与用户。
  if (task.urgent === 1) publishUrgentStage(inbox, db, id, kind, detail, task);
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
  return totals.ancestors;
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

/** 「tN 下的 tM 卡住要你」：总任务下的任务卡住、又没有 leader 管时，秘书收到的那一条（t190）。 */
function publishStuck(
  inbox: EventInbox,
  db: DatabaseSync,
  total: { id: number; rollup: Rollup | null },
  task: Task,
  kind: string,
  detail: Record<string, unknown>,
  actor?: string,
) {
  const root = getTask(db, total.id);
  // 整个总任务已经取消（连带取消时停掉在跑的子孙）：不再报卡住。
  if (root.status === "cancelled") return;
  const rollup = total.rollup;
  const reason = typeof detail.reason === "string" ? detail.reason : null;
  inbox.publish({
    subscriber: SECRETARY,
    taskId: task.id,
    source: detail.source === undefined ? "runner" : String(detail.source),
    kind: "total_stuck",
    key: `${root.ref}:stuck:${task.ref}`,
    actor,
    detail: {
      title: task.title,
      status: task.status,
      total: root.ref,
      total_title: root.title,
      ...(rollup ? { progress: progressOf(rollup) } : {}),
      leaf_kind: kind,
      ...detail,
      message: `${root.ref} 下的 ${task.ref} 卡住要你${reason ? `：${reason}` : ""}`,
      next: `atrium task show ${task.ref}`,
      routed: {
        to: SECRETARY,
        why: `${task.ref} 属于总任务 ${root.ref}，没有 leader 管；秘书只收总任务级的`,
      },
    },
  });
}

/** 叶子端到端验证摘要：每个叶子至多这么多字，总共至多 SUMMARY_MAX 字。 */
const LEAF_VERIFY_MAX = 600;
const SUMMARY_MAX = 6000;

/** 叶子的端到端验证：上线时记下的那一节，没有再从执行者汇报里取。 */
function leafVerification(
  db: DatabaseSync,
  leaf: { id: number; result: string | null },
) {
  const row = one<{ detail: string | null }>(
    db,
    "SELECT detail FROM task_events WHERE task_id=? AND kind='online' ORDER BY id DESC LIMIT 1",
    leaf.id,
  );
  let text: string | null = null;
  try {
    const value = row?.detail
      ? (JSON.parse(row.detail) as { verification_text?: unknown })
          .verification_text
      : undefined;
    if (typeof value === "string" && value.trim()) text = value;
  } catch {
    /* 写坏的历史事件按没记处理。 */
  }
  return text ?? verificationSection(leaf.result);
}

export function verificationSummary(db: DatabaseSync, rootId: number) {
  const parts: string[] = [];
  let size = 0;
  for (const leaf of finishedLeaves(db, rootId)) {
    const text = leafVerification(db, leaf);
    const body = text
      ? Array.from(text).slice(0, LEAF_VERIFY_MAX).join("")
      : "（没写端到端验证）";
    const part = `### ${taskRef(leaf.id)} ${leaf.title}\n${body}`;
    if (size + part.length > SUMMARY_MAX) {
      parts.push("……其余见各子任务：atrium task tree " + taskRef(rootId));
      break;
    }
    parts.push(part);
    size += part.length;
  }
  return parts.join("\n\n");
}

/**
 * 总任务全部子孙都已上线或完成时，秘书（和总任务的 leader）收一条「tN 整体已上线（x/x）」，
 * 带全部叶子的端到端验证摘要。同一进度只发一次：进度变了（后来又加了子任务并完成）再发。
 */
export function publishTotalOnline(
  inbox: EventInbox,
  db: DatabaseSync,
  total: { id: number; rollup: Rollup | null },
) {
  const { id: rootId, rollup } = total;
  if (!rollup || rollup.status !== "online" || rollup.truncated) return;
  const progress = progressOf(rollup);
  const last = one<{ detail: string | null }>(
    db,
    "SELECT detail FROM task_events WHERE task_id=? AND kind='total_online' ORDER BY id DESC LIMIT 1",
    rootId,
  );
  if (last?.detail?.includes(`"progress":"${progress}"`)) return;
  const root = getTask(db, rootId);
  // 用户取消了的总任务不报上线。
  if (root.status === "cancelled") return;
  noteTask(db, rootId, "total_online", { progress });
  const route = taskRoute(db, root);
  const message = totalOnlineMessage(root.ref, rollup);
  for (const target of deliveryRoutes("total_online", route))
    inbox.publish({
      subscriber: target.subscriber,
      taskId: rootId,
      source: "rollup",
      kind: "total_online",
      key: `${root.ref}:total_online`,
      detail: {
        title: root.title,
        status: root.status,
        progress,
        message,
        verification: verificationSummary(db, rootId),
        next: `atrium task tree ${root.ref}`,
        routed: { to: target.subscriber, why: target.why },
      },
    });
}

/** 人工改了状态（task set）后补一次总任务级通知：同步已在状态转移里做完，这里只看要不要报整体上线。 */
export function publishTotals(
  inbox: EventInbox,
  db: DatabaseSync,
  id: number,
): number[] {
  const totals = atomically(db, () => syncTotals(db, id));
  if (totals.root) publishTotalOnline(inbox, db, totals.root);
  return totals.ancestors;
}
