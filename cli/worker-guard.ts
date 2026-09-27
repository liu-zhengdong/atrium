import { Problem } from "../server/problem.ts";
import { dataDirectory } from "../server/service-state.ts";

/**
 * 执行者环境的防护（#262）：Atrium 拉起的执行者带 ATRIUM_WORKER=1。
 * 带这个标记时，命令行不自动拉起服务、不用默认数据目录，也不连用户的 4310；
 * 执行者要用 Atrium 就得显式给自己的隔离实例（ATRIUM_DATA 与 ATRIUM_PORT）。机制兜底，不靠提示词。
 */

export const WORKER_FLAG = "ATRIUM_WORKER";
export const WORKER_REFUSAL =
  "执行者环境里不能操作用户的 Atrium 服务，如需隔离实例请显式设置 ATRIUM_DATA 与 ATRIUM_PORT";

const USER_PORT = "4310";

export function workerGuard(env: NodeJS.ProcessEnv = process.env) {
  if (env[WORKER_FLAG] !== "1") return;
  const data = env.ATRIUM_DATA?.trim();
  const port = env.ATRIUM_PORT?.trim();
  if (
    !data ||
    !port ||
    port === USER_PORT ||
    dataDirectory({ ATRIUM_DATA: data }) === dataDirectory({})
  )
    throw new Problem(403, WORKER_REFUSAL, "worker_environment");
}

/**
 * leader 进程的环境：Atrium 唤醒 leader 时带 ATRIUM_LEADER（aN）、ATRIUM_LEADER_TOKEN（本次唤醒的令牌）
 * 与 ATRIUM_LEADER_URL（服务地址）。命令行据此以 aN 身份直连服务，不读用户令牌、不拉起服务；
 * 服务控制类命令一律拒绝。权限由服务端按令牌判定，这里只是早一步给出人话。
 */
export type LeaderSession = { leader: string; url: string; bearer: string };

export function leaderSession(
  env: NodeJS.ProcessEnv = process.env,
): LeaderSession | null {
  const token = env.ATRIUM_LEADER_TOKEN?.trim();
  if (!token) return null;
  const leader = env.ATRIUM_LEADER?.trim() ?? "";
  const url = env.ATRIUM_LEADER_URL?.trim() ?? "";
  if (!/^a[1-9][0-9]*$/.test(leader) || !token.startsWith(`${leader}.`))
    throw new Problem(
      401,
      "leader 环境不完整：ATRIUM_LEADER 与 ATRIUM_LEADER_TOKEN 对不上",
      "auth_required",
    );
  if (!/^http:\/\/(127\.0\.0\.1|localhost):[0-9]{1,5}$/.test(url))
    throw new Problem(
      401,
      "leader 环境不完整：ATRIUM_LEADER_URL 应为本机服务地址",
      "auth_required",
    );
  return { leader, url, bearer: `Bearer ${token}` };
}

const LEADER_REFUSED = new Set([
  "",
  "--no-open",
  "stop",
  "restart",
  "update",
  "auth",
  "chat",
]);

export function leaderCommandGuard(
  name: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!env.ATRIUM_LEADER_TOKEN?.trim()) return;
  if (LEADER_REFUSED.has(name ?? ""))
    throw new Problem(
      403,
      "leader 进程不能启动、停止、重启、升级服务，也不能轮换令牌或开秘书会话；需要的话上交秘书：atrium leader escalate --kind beyond 说明",
      "leader_scope",
      undefined,
      "atrium leader escalate --kind beyond 说明",
    );
}

/** 缺省订阅者：leader 进程里是自己的 aN，其余是 secretary。 */
export const defaultSubscriber = (env: NodeJS.ProcessEnv = process.env) =>
  env.ATRIUM_LEADER_TOKEN?.trim() && env.ATRIUM_LEADER?.trim()
    ? env.ATRIUM_LEADER.trim()
    : "secretary";
