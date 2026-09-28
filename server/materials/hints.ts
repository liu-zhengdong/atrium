import type { DatabaseSync } from "node:sqlite";
import { nodes, ref } from "../org/model.ts";
import { partRoutes } from "../leaders/subscriber.ts";
import { SECRETARY } from "../leaders/route.ts";
import type { EventInbox } from "../tasks/events/events.ts";
import { hintDue, sizeText } from "./model.ts";
import { markHinted, purgeMaterials, staleMaterials } from "./store.ts";

/**
 * 清理线索（t192）：各部门的周期任务到点建出一轮时顺带看一眼这一块的资料，
 * 疑似没用的（被取代，或 90 天没读且关联都结束）列成一条 material_stale 投给这一块最近的 leader，
 * leader 决定归档还是留（留写原因，之后不再提）；没决定的隔 30 天再提。
 * 归档超过一年且大于 10 MB 的列成 material_purge 投给秘书，问过用户才真删，只问一次。
 * 只给线索、不自动归档或删除，不挡周期任务（出错只记日志）。
 */

/** 一条事件里最多列几份，其余看 material ls --stale。 */
const LISTED = 20;

/**
 * 线索投给谁、看哪些节点：这一块最近的 leader（没有就秘书），范围是这一块及其下层里事件同样投给他的节点
 * （下层另有 leader 的由它自己的周期任务管）。凭据的清理线索（secrets/hints.ts）用同一个范围。
 */
export function hintScope(db: DatabaseSync, nodeId: number) {
  const list = nodes(db);
  const below = new Set<number>([nodeId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const n of list)
      if (n.parent_id !== null && below.has(n.parent_id) && !below.has(n.id)) {
        below.add(n.id);
        grew = true;
      }
  }
  const routes = partRoutes(db, [...below]);
  const route = routes.get(nodeId)!;
  const ids = [...below].filter(
    (id) => routes.get(id)?.subscriber === route.subscriber,
  );
  return { route, ids };
}

export function publishMaterialHints(
  db: DatabaseSync,
  inbox: EventInbox,
  nodeId: number,
  now = Date.now(),
) {
  const { route, ids } = hintScope(db, nodeId);
  const due = staleMaterials(db, ids, now).filter((m) =>
    hintDue(m.hinted_at, now),
  );
  if (due.length) {
    inbox.publish({
      subscriber: route.subscriber,
      source: "materials",
      kind: "material_stale",
      key: `materials:${ref(nodeId)}`,
      detail: {
        node: ref(nodeId),
        title: `${ref(nodeId)} 疑似没用的资料 ${due.length} 份`,
        materials: due.slice(0, LISTED).map((m) => ({
          ref: m.ref,
          name: m.name,
          node: m.node,
          reason: m.stale.reason,
        })),
        more: Math.max(0, due.length - LISTED),
        routed: { to: route.subscriber, why: route.why },
      },
    });
    markHinted(
      db,
      due.map((m) => Number(m.ref.slice(1))),
      "hinted_at",
      now,
    );
  }
  const purge = purgeMaterials(db, now);
  if (purge.length) {
    inbox.publish({
      subscriber: SECRETARY,
      source: "materials",
      kind: "material_purge",
      key: "materials:purge",
      detail: {
        title: `归档超过一年且大于 10 MB 的资料 ${purge.length} 份，问用户要不要真删`,
        materials: purge.slice(0, LISTED).map((m) => ({
          ref: m.ref,
          name: m.name,
          node: m.node,
          reason: `归档于 ${new Date(m.archived_at!).toISOString().slice(0, 10)}，共 ${sizeText(m.total_bytes)}`,
        })),
        more: Math.max(0, purge.length - LISTED),
      },
    });
    markHinted(
      db,
      purge.map((m) => Number(m.ref.slice(1))),
      "purge_asked_at",
      now,
    );
  }
  return { stale: due.length, purge: purge.length };
}
