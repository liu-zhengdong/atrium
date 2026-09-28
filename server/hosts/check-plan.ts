import { hostRef, repoAllowed, type Connection } from "./state.ts";

/**
 * 本地检查派到哪台主机（#358 第 2 步）的判定：纯函数，穷举测试。
 * 合入队列 rebase 后的检查走这里：本机也是候选，按负载挑；
 * 远程要在线、没暂停、能拿到这个仓库、检查没超并发、代理没报太忙，且与仓库检查基准同平台（t201）。
 * IO 在 check-runtime.ts。
 */

export type CheckCandidate = {
  id: number;
  kind: "local" | "remote";
  connection: Connection;
  paused: boolean;
  /** 这台的平台（process.platform：darwin、linux、win32）；代理还没上报为 null。 */
  platform: string | null;
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
  /** 仓库的检查基准平台（checkBaseline）：把关检查只在这个平台上跑。 */
  platform: string;
};

/** 仓库能写进 .agents/check-platform 的检查基准平台。 */
export const CHECK_PLATFORMS = ["darwin", "linux", "win32"] as const;

/**
 * 仓库的检查基准平台：仓库 `.agents/check-platform` 写了认得的平台就用它，否则取本机 h1 的平台。
 * 把关检查（合入队列 rebase 后的检查）只派到基准平台的主机：别的平台专有的偶发失败
 * 不该把任务交回执行者；那些平台的全量结果由远端 CI 记录作参考（t201）。
 */
export function checkBaseline(configured: string | null, local: string) {
  const value = configured?.trim() ?? "";
  return (CHECK_PLATFORMS as readonly string[]).includes(value) ? value : local;
}

/** 这台因平台不跑把关检查的原因；同平台为 null。 */
export function platformRefusal(
  id: number,
  platform: string | null,
  baseline: string,
): string | null {
  if (platform === baseline) return null;
  return platform
    ? `${hostRef(id)} 是 ${platform}，与检查基准 ${baseline} 平台不同，接活、不跑把关检查`
    : `${hostRef(id)} 还没上报平台，不跑把关检查`;
}

/** host show 的「把关检查」一行：这台跑不跑交付后与合入前的检查。 */
export function checkRoleText(
  kind: "local" | "remote",
  platform: string | null,
  baseline: string,
) {
  if (platform === baseline)
    return kind === "local"
      ? `跑（检查基准平台 ${baseline}）`
      : `接活，也跑把关检查（与检查基准同为 ${baseline}）`;
  if (!platform) return "接活、不跑把关检查（还没上报平台）";
  return kind === "local"
    ? `检查基准是 ${baseline}，有同平台的主机时检查派过去，没有时仍在本机跑`
    : `接活、不跑把关检查（平台不同：${platform}，检查基准 ${baseline}）`;
}

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
  const platform = platformRefusal(
    candidate.id,
    candidate.platform,
    need.platform,
  );
  if (platform) return platform;
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
 * 远程都接不了时回本机（本机检查队列排队）。本机暂停接活、或本机不是检查基准平台（仓库另配了基准）
 * 只是不优先，检查总得有地方跑。
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
    local.platform === need.platform &&
    (need.urgent || (!local.busy && local.running < local.max));
  if (localFree && score(local) <= score(best) + LOCAL_MARGIN)
    return { host: localId, kind: "local" };
  return { host: best.id, kind: "remote" };
}

/** 代理上同一个克隆的第 slot 个检查工作树（依赖装在里面，下次沿用）。 */
export function checkTreeName(clone: string, slot: number) {
  return `${clone}-check-${slot}`;
}
