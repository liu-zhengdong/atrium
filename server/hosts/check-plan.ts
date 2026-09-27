import { hostRef, repoAllowed, type Connection } from "./state.ts";

/**
 * 本地检查派到哪台主机（#358 第 2 步）的判定：纯函数，穷举测试。
 * 交付后的 local_check 与合入队列 rebase 后的重跑检查都走这里：本机也是候选，按负载挑；
 * 远程要在线、没暂停、能拿到这个仓库、检查没超并发、代理没报太忙。IO 在 check-runtime.ts。
 */

export type CheckCandidate = {
  id: number;
  kind: "local" | "remote";
  connection: Connection;
  paused: boolean;
  /** 自动派活时这台能接的仓库（owner/name，`*` 表示全部）。 */
  repos: readonly string[];
  cpus: number;
  /** 一分钟平均负载。 */
  load: number;
  /** 这台上正在跑的检查（服务派过去的，本机是共享检查队列里的）。 */
  running: number;
  /** 这台同时最多跑几个检查。 */
  max: number;
  /** 这台自己说太忙（本机闸门、代理上报）；不忙为 null。 */
  busy: string | null;
};

export type CheckNeed = {
  /** 任务仓库的 owner/name；解析不出为 "?"。 */
  repo: string;
  urgent: boolean;
};

/** 本机比远程每核负载多出这么多以内仍在本机跑：省掉传提交、装依赖的开销。 */
export const LOCAL_MARGIN = 0.5;

/** 远程这台现在能不能接这次检查；能接为 null，否则是原因。 */
export function checkRefusal(
  candidate: CheckCandidate,
  need: CheckNeed,
): string | null {
  const ref = hostRef(candidate.id);
  if (candidate.kind !== "remote") return null;
  if (candidate.connection !== "online") return `${ref} 不在线`;
  if (candidate.paused) return `${ref} 已暂停接活`;
  if (!repoAllowed(candidate.repos, need.repo))
    return `${ref} 没登记能接仓库 ${need.repo}`;
  if (candidate.busy) return candidate.busy;
  if (candidate.running >= candidate.max)
    return `${ref} 同时最多跑 ${candidate.max} 个检查`;
  return null;
}

const score = (c: CheckCandidate) =>
  c.load / Math.max(1, c.cpus) + c.running / Math.max(1, c.max);

/**
 * 挑一台跑检查；tried 是这次已经试过、没跑成的远程主机。
 * 本机有空位且不比最空的远程忙太多（LOCAL_MARGIN）就在本机；否则去最空的远程；
 * 远程都接不了时回本机（本机检查队列排队）。本机暂停接活只是不优先，检查总得有地方跑。
 */
export function chooseCheckHost(
  candidates: readonly CheckCandidate[],
  need: CheckNeed,
  tried: ReadonlySet<number> = new Set(),
): { host: number; kind: "local" | "remote" } {
  const local = candidates.find((c) => c.kind === "local");
  const localId = local?.id ?? 1;
  const remotes = candidates
    .filter(
      (c) => c.kind === "remote" && !tried.has(c.id) && !checkRefusal(c, need),
    )
    .sort((a, b) => score(a) - score(b) || a.id - b.id);
  const best = remotes[0];
  if (!best) return { host: localId, kind: "local" };
  const localFree =
    !!local &&
    !local.paused &&
    (need.urgent || (!local.busy && local.running < local.max));
  if (localFree && score(local) <= score(best) + LOCAL_MARGIN)
    return { host: localId, kind: "local" };
  return { host: best.id, kind: "remote" };
}

/** 代理上同一个克隆的第 slot 个检查工作树（依赖装在里面，下次沿用）。 */
export function checkTreeName(clone: string, slot: number) {
  return `${clone}-check-${slot}`;
}
