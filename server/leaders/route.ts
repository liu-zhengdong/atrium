import { LEADER_RE } from "./model.ts";

/**
 * 事件投给谁（纯函数，穷举测试）。任务没写负责人时，从任务所属部分向上找最近的、已登记的 leader；
 * 找不到投秘书。上交与唤醒失败的转交从 leader 负责的节点的上一层开始找，找不到同样投秘书。
 */

export const SECRETARY = "secretary";

export type ChainNode = { ref: string; name: string; leader: string | null };

export type Route = {
  subscriber: string;
  /** 一句人话：为什么投给他，写进事件记录。 */
  why: string;
  /** 经哪个节点找到的 leader；投秘书或按负责人投时为 null。 */
  via: string | null;
};

const label = (n: ChainNode) => `${n.ref}「${n.name}」`;

/** 沿链找第一个已登记的 aN；跳过的未登记 aN 记下来写进原因。 */
function nearest(
  chain: readonly ChainNode[],
  registered: ReadonlySet<string>,
  skip?: string,
) {
  const unregistered: string[] = [];
  for (const node of chain) {
    const who = node.leader;
    if (!who || !LEADER_RE.test(who) || who === skip) continue;
    if (registered.has(who)) return { node, who, unregistered };
    unregistered.push(`${who}（${node.ref}）`);
  }
  return { node: null, who: null, unregistered };
}

const skipped = (list: string[]) =>
  list.length ? `；${list.join("、")} 没有登记为 leader，跳过` : "";

export function routeTaskEvent(input: {
  /** 任务的负责人；null 表示没写，按归属部分找 leader。 */
  owner: string | null;
  /** 从任务所属部分向上到根。 */
  chain: readonly ChainNode[];
  registered: ReadonlySet<string>;
}): Route {
  if (input.owner !== null)
    return {
      subscriber: input.owner,
      why: `任务指定了负责人 ${input.owner}`,
      via: null,
    };
  const part = input.chain[0];
  if (!part)
    return {
      subscriber: SECRETARY,
      why: "任务没有归属部分，投秘书",
      via: null,
    };
  const found = nearest(input.chain, input.registered);
  if (!found.node)
    return {
      subscriber: SECRETARY,
      why: `任务归属 ${label(part)}，它和上级都没有 leader，投秘书${skipped(found.unregistered)}`,
      via: null,
    };
  return {
    subscriber: found.who,
    why:
      found.node === part
        ? `任务归属 ${label(part)}，由它的 leader ${found.who} 处理${skipped(found.unregistered)}`
        : `任务归属 ${label(part)}，最近的 leader 是 ${label(found.node)}的 ${found.who}${skipped(found.unregistered)}`,
    via: found.node.ref,
  };
}

/**
 * leader 往上交：从它负责的节点的上一层开始找另一位已登记的 leader，找不到投秘书。
 * chains 每项是一个负责节点的「上一层 → 根」；负责多个节点时取第一个找得到的。
 */
export function escalationRoute(input: {
  leader: string;
  chains: readonly (readonly ChainNode[])[];
  registered: ReadonlySet<string>;
}): Route {
  for (const chain of input.chains) {
    const found = nearest(chain, input.registered, input.leader);
    if (found.node)
      return {
        subscriber: found.who,
        why: `${input.leader} 上交，上一层的 leader 是 ${label(found.node)}的 ${found.who}`,
        via: found.node.ref,
      };
  }
  return {
    subscriber: SECRETARY,
    why: `${input.leader} 上交，上层没有别的 leader，投秘书`,
    via: null,
  };
}
