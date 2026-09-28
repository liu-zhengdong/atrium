/**
 * 主机掉线超时改派（t184）的判定：掉线多久算回不来、这台上在跑的执行者该不该改派、写给人看的一句话。
 * 纯函数，不碰数据库、网络与进程；执行在 tasks/executors.ts（巡检里改派）与 tasks/runner.ts（挑哪台）。
 * 合入队列的检查另有更短的「离线就换一台」（remote.ts `check` 的 abandon），不走这里。
 */

/** 缺省掉线多久改派（分钟）。 */
export const HOST_LOST_MINUTES = 10;
/** 该改派却没有主机能接时，隔多久再挑一次。 */
export const MOVE_RETRY_MS = 60_000;

/**
 * 掉线多久改派：读服务环境 ATRIUM_HOST_LOST_MINUTES（正数，至多一天；off 不改派，ms 为 0）；
 * 写错的照缺省并给出原因。
 */
export function hostLostMs(env: NodeJS.ProcessEnv): {
  ms: number;
  problem: string | null;
} {
  const raw = env.ATRIUM_HOST_LOST_MINUTES;
  const fallback = HOST_LOST_MINUTES * 60_000;
  if (raw === undefined || raw.trim() === "")
    return { ms: fallback, problem: null };
  if (raw.trim().toLowerCase() === "off") return { ms: 0, problem: null };
  const value = Number(raw.trim());
  if (Number.isFinite(value) && value > 0 && value <= 24 * 60)
    return { ms: Math.round(value * 60_000), problem: null };
  return {
    ms: fallback,
    problem: `ATRIUM_HOST_LOST_MINUTES=${raw} 看不懂，按缺省 ${HOST_LOST_MINUTES} 分钟`,
  };
}

/**
 * 已经掉线多久（毫秒）：从最后一次心跳与服务开始盯着这两者较晚的算起。
 * 服务停过一阵再启动时，停机前的心跳不算——代理还没来得及重连，不能一启动就把活全改派走。
 */
export function offlineSpan(input: {
  lastSeenAt: number | null;
  watchingSince: number;
  now: number;
}): number {
  const from = Math.max(input.lastSeenAt ?? 0, input.watchingSince);
  return Math.max(0, input.now - from);
}

export type MoveDue =
  | { kind: "stay" }
  /** 掉线还没到时限：还要等 leftMs。 */
  | { kind: "wait"; leftMs: number }
  | { kind: "move" };

/**
 * 某台主机上在跑的执行者要不要改派：offlineMs 为 null 表示在线；lostMs 为 0 表示关掉了改派。
 * stopping：已在停（用户叫停、卡死重试等），交给原来的收尾，不改派。
 * retryAt：上次挑不到主机，这之前不再挑。
 */
export function moveDue(input: {
  offlineMs: number | null;
  lostMs: number;
  stopping: boolean;
  now: number;
  retryAt?: number;
}): MoveDue {
  if (input.offlineMs === null || input.lostMs <= 0 || input.stopping)
    return { kind: "stay" };
  if (input.offlineMs < input.lostMs)
    return { kind: "wait", leftMs: input.lostMs - input.offlineMs };
  if (input.retryAt !== undefined && input.now < input.retryAt)
    return { kind: "wait", leftMs: input.retryAt - input.now };
  return { kind: "move" };
}

/** 时限的人话：整分钟写「N 分钟」，否则写秒（测试里的短时限）。 */
export function spanText(ms: number) {
  return ms % 60_000 === 0
    ? `${ms / 60_000} 分钟`
    : `${Math.max(1, Math.round(ms / 1000))} 秒`;
}

/** 改派成功：写进事件、持球人（top、状态栏、task show）。 */
export function movedText(from: string, to: string, lostMs: number) {
  return `${from} 掉线超过 ${spanText(lostMs)}，已改派到 ${to}`;
}

/** 该改派但暂时没有主机能接。 */
export function moveWaitText(from: string, lostMs: number, why: string) {
  return `${from} 掉线超过 ${spanText(lostMs)}，暂时改派不了：${why}；有主机能接时自动改派`;
}

/** 改派时拉起失败（转受阻）。 */
export function moveFailedText(
  from: string,
  to: string,
  lostMs: number,
  why: string,
) {
  return `${from} 掉线超过 ${spanText(lostMs)}，改派到 ${to} 拉起失败：${why}`;
}

/** 捎给改派后的执行者：上一轮在掉线那台上，没推送的改动拿不到；推送过的分支接着用。 */
export function movedNote(from: string, branch: string | null) {
  const pushed = branch
    ? `先 git fetch origin，远端若已有分支 ${branch}（或已开了 PR），在它上面接着做，不要另开 PR；`
    : "";
  return `这件任务原来在 ${from} 上跑，那台掉线太久，已改派到这里重做。${from} 上没推送的改动拿不到；${pushed}没有就从头做。`;
}
