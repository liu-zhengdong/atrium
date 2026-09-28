import type { DatabaseSync } from "node:sqlite";
import { ref } from "../org/model.ts";
import type { EventInbox } from "../tasks/events.ts";
import { hintScope } from "../materials/hints.ts";
import { hintDue } from "../materials/model.ts";
import { markSecretsHinted, staleSecrets } from "./store.ts";

/**
 * 凭据的清理线索（t194）：各部门的周期任务到点建出一轮时，顺带把这一块 90 天没用过的凭据
 * 列成一条 secret_stale 投给这一块最近的 leader；leader 用 secret archive（可恢复）或 secret keep --note 原因（之后不再提）定，
 * 没定的隔 30 天再提。只给线索、不自动归档或删除；只列名称，不带值。
 */

const LISTED = 20;

export function publishSecretHints(
  db: DatabaseSync,
  inbox: EventInbox,
  nodeId: number,
  now = Date.now(),
) {
  const { route, ids } = hintScope(db, nodeId);
  const due = staleSecrets(db, ids, now).filter((s) =>
    hintDue(s.row.hinted_at, now),
  );
  if (!due.length) return { stale: 0 };
  inbox.publish({
    subscriber: route.subscriber,
    source: "secrets",
    kind: "secret_stale",
    key: `secrets:${ref(nodeId)}`,
    detail: {
      node: ref(nodeId),
      title: `${ref(nodeId)} 疑似没用的凭据 ${due.length} 个`,
      secrets: due.slice(0, LISTED).map(({ view }) => ({
        name: view.name,
        node: view.node,
        reason: view.stale,
      })),
      more: Math.max(0, due.length - LISTED),
      routed: { to: route.subscriber, why: route.why },
    },
  });
  markSecretsHinted(
    db,
    due.map((s) => s.row.id),
    now,
  );
  return { stale: due.length };
}
