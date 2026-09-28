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

/** 另外知会秘书的：上线失败（服务自升级出了问题）与总任务整体上线（秘书只收总任务级的）。 */
const SECRETARY_TOO: ReadonlySet<string> = new Set([
  "online_failed",
  "total_online",
]);

/**
 * 上线失败、总任务整体上线还要交秘书；已有秘书路由时只投一次。
 * 单个任务上线不另投秘书：端到端验证在合入前做过，上线后只读冒烟没过才记上线失败。
 */
export function deliveryRoutes(kind: string, route: Route): Route[] {
  if (!SECRETARY_TOO.has(kind)) return [route];
  return route.subscriber === SECRETARY
    ? [route]
    : [
        route,
        {
          subscriber: SECRETARY,
          why:
            kind === "online_failed"
              ? "上线失败直接通知秘书"
              : "总任务整体上线直接通知秘书",
          via: null,
        },
      ];
}

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

/** 下层上交给这位 leader 的事件，转交判定只看这些字段。 */
export type ForwardCandidate = {
  id: number;
  subscriber: string;
  kind: string;
  task: string | null;
  actor: string | null;
  key: string;
  acked_at: number | null;
  detail: unknown;
};

export type Forwarded = { by: string; note: string };

/** 已确认的下层上交在这段时间内仍认作「正在转交」：leader 常先确认再上交。 */
export const FORWARD_WINDOW_MS = 6 * 60 * 60_000;

const record = (detail: unknown) =>
  detail && typeof detail === "object" && !Array.isArray(detail)
    ? (detail as Record<string, unknown>)
    : {};

/** 事件里记下的转交意见（逐层追加）；格式不对的项略过。 */
export function forwardedOf(detail: unknown): Forwarded[] {
  const list = record(detail).forwarded;
  return Array.isArray(list)
    ? list.filter(
        (f): f is Forwarded =>
          typeof f?.by === "string" && typeof f?.note === "string",
      )
    : [];
}

/**
 * leader 上交时是不是在转交下层投给它的上交（纯函数，穷举测试）。
 * 给了 event 就只认那一条，且须是投给它本人的上交；没给时按同任务、同上交类型认最近的一条
 * （未确认的，或确认不久的），认不出就是它自己的新上交。
 */
export function forwardOf(input: {
  leader: string;
  kind: string;
  task: string | null;
  event: number | null;
  now: number;
  candidates: readonly ForwardCandidate[];
}): { forward: ForwardCandidate | null; error?: string } {
  const theirs = (c: ForwardCandidate) =>
    c.subscriber === input.leader &&
    c.kind === "escalated" &&
    c.actor !== input.leader;
  if (input.event !== null) {
    const picked = input.candidates.find((c) => c.id === input.event);
    if (!picked || !theirs(picked))
      return {
        forward: null,
        error: `--event: #${input.event} 不是下层投给 ${input.leader} 的上交，不能转交`,
      };
    if (
      input.task !== null &&
      picked.task !== null &&
      picked.task !== input.task
    )
      return {
        forward: null,
        error: `--task: #${input.event} 是 ${picked.task} 的上交，和 ${input.task} 对不上`,
      };
    return { forward: picked };
  }
  if (input.task === null) return { forward: null };
  let best: ForwardCandidate | null = null;
  for (const c of input.candidates)
    if (
      theirs(c) &&
      c.task === input.task &&
      record(c.detail).kind === input.kind &&
      (c.acked_at === null || input.now - c.acked_at <= FORWARD_WINDOW_MS) &&
      (!best || c.id > best.id)
    )
      best = c;
  return { forward: best };
}

export type EscalationDetail = {
  title: string;
  /** 最初上交的 leader；转交时是下层，不是转交人。 */
  from: string;
  kind: string;
  kind_label: string;
  task: string | null;
  pr_url: string | null;
  /** 最初上交的说明（原文）。 */
  reason: string;
  /** 转交时逐层追加的意见。 */
  forwarded?: Forwarded[];
  /** 转交的是哪条事件。 */
  forward_of?: number;
  routed: { to: string; why: string };
};

/**
 * 上交事件的内容（纯函数）。转交时保留下层原文（from、reason），把这一层的意见追加进 forwarded，
 * 上面只收一条、能看到每一层说了什么。
 */
export function escalationDetail(input: {
  leader: string;
  kind: string;
  label: string;
  note: string;
  task: { ref: string; title: string; pr_url: string | null } | null;
  forward: ForwardCandidate | null;
  route: Route;
}): EscalationDetail {
  const topic = `${input.label}${input.task ? ` · ${input.task.title}` : ""}`;
  const routed = { to: input.route.subscriber, why: input.route.why };
  const common = {
    kind: input.kind,
    kind_label: input.label,
    task: input.task?.ref ?? null,
    pr_url: input.task?.pr_url ?? null,
  };
  if (!input.forward)
    return {
      title: `${input.leader} 上交：${topic}`.slice(0, 200),
      from: input.leader,
      ...common,
      reason: input.note,
      routed,
    };
  const original = record(input.forward.detail);
  const from =
    typeof original.from === "string"
      ? original.from
      : (input.forward.actor ?? input.leader);
  const forwarded = [
    ...forwardedOf(original),
    { by: input.leader, note: input.note },
  ];
  return {
    title:
      `${from} 上交：${topic}（经 ${forwarded.map((f) => f.by).join("、")} 转交）`.slice(
        0,
        200,
      ),
    from,
    ...common,
    reason: typeof original.reason === "string" ? original.reason : "",
    forwarded,
    forward_of: input.forward.id,
    routed,
  };
}
