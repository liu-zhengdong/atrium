import type { DatabaseSync } from "node:sqlite";
import { nodes, one, ref, type NodeRow } from "../org/model.ts";
import { hasOrg } from "../org/task-node.ts";
import { registeredLeaders } from "./model.ts";
import {
  escalationRoute,
  routeTaskEvent,
  SECRETARY,
  type ChainNode,
  type Route,
} from "./route.ts";

/** 读库拼出路由判定的输入：节点链与已登记的 leader。判定本身在 route.ts。 */

const PARENT_DEPTH = 50;

function chainFrom(list: readonly NodeRow[], id: number | null): ChainNode[] {
  const chain: ChainNode[] = [];
  const seen = new Set<number>();
  let current = id === null ? undefined : list.find((n) => n.id === id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push({
      ref: ref(current.id),
      name: current.name,
      leader: current.archived_at === null ? current.leader : null,
    });
    const parent: number | null = current.parent_id;
    current = parent === null ? undefined : list.find((n) => n.id === parent);
  }
  return chain;
}

type TaskFacts = {
  id: number;
  parent_id: number | null;
  owner: string | null;
  part_id: number | null;
  node_id: number | null;
};

/** 任务所属部分：归属部分，其次记账节点，都没写就沿父任务往上找。 */
export function taskPartId(db: DatabaseSync, task: TaskFacts): number | null {
  let current: TaskFacts | undefined = task;
  for (let depth = 0; current && depth < PARENT_DEPTH; depth++) {
    const part = current.part_id ?? current.node_id;
    if (part !== null) return part;
    if (current.parent_id === null) return null;
    current = one<TaskFacts>(
      db,
      "SELECT id,parent_id,owner,part_id,node_id FROM tasks WHERE id=?",
      current.parent_id,
    );
  }
  return null;
}

/** 任务事件投给谁。没有组织树时一律按负责人（缺省秘书）投。 */
export function taskRoute(db: DatabaseSync, task: TaskFacts): Route {
  if (!hasOrg(db))
    return {
      subscriber: task.owner ?? SECRETARY,
      why:
        task.owner === null
          ? "还没有组织树，投秘书"
          : `任务指定了负责人 ${task.owner}`,
      via: null,
    };
  return routeTaskEvent({
    owner: task.owner,
    chain: chainFrom(nodes(db), taskPartId(db, task)),
    registered: registeredLeaders(db),
  });
}

/** leader 上交或唤醒失败转交时投给谁。 */
export function upstreamRoute(db: DatabaseSync, leader: string): Route {
  if (!hasOrg(db))
    return escalationRoute({ leader, chains: [], registered: new Set() });
  const list = nodes(db);
  const chains = list
    .filter((n) => n.leader === leader && n.archived_at === null)
    .map((n) => chainFrom(list, n.parent_id));
  return escalationRoute({ leader, chains, registered: registeredLeaders(db) });
}
