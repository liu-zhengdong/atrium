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

/**
 * 执行者能对用户服务用的只读命令：取资料（t192，u1 定的「派活只附清单，执行者按需 material get」）。
 * 只读、不拉起服务；读取记在 ATRIUM_TASK 那件任务上。
 */
export const workerReadable = (
  name: string | undefined,
  rest: readonly string[],
) => name === "material" && rest[0] === "get";

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
 * 上线验证执行者的防护（t181）：运行时拉起验证执行者时带 ATRIUM_VERIFIER=1（与 server/tasks/verify.ts 同名）。
 * 它要连本机真实服务照着验证步骤跑，所以不带 ATRIUM_WORKER；但不能拉起、停止、重启、升级服务，
 * 不能轮换令牌、开秘书会话或起代理。机制兜底，不靠提示词。
 */
export const VERIFIER_FLAG = "ATRIUM_VERIFIER";

const VERIFIER_REFUSED = new Set([
  "",
  "--no-open",
  "start",
  "stop",
  "restart",
  "update",
  "auth",
  "chat",
  "agent",
]);

export const VERIFIER_REFUSAL =
  "上线验证执行者不能启动、停止、重启、升级服务，也不能轮换令牌、开秘书会话或起代理；这一步记「无法验证：需要操作服务」。要在隔离环境验证，设临时 ATRIUM_DATA 与另一个 ATRIUM_PORT 再跑";

/** 运行时给验证执行者的真实服务数据目录（t239，与 server/tasks/executors.ts 同名）。 */
export const VERIFIER_DATA = "ATRIUM_VERIFIER_DATA";

export const isVerifier = (env: NodeJS.ProcessEnv = process.env) =>
  env[VERIFIER_FLAG] === "1";

/**
 * 验证执行者在用自己起的隔离实例（t239）：数据目录换成了临时目录、端口也另给了，不是运行时给的真实服务。
 * 这时照常用（可以起停隔离服务、在里面跑止损类命令），防护只管真实服务；认不出真实服务在哪时不算隔离。
 */
export function verifierIsolated(env: NodeJS.ProcessEnv = process.env) {
  if (!isVerifier(env)) return false;
  const real = env[VERIFIER_DATA]?.trim();
  const data = env.ATRIUM_DATA?.trim();
  const port = env.ATRIUM_PORT?.trim();
  return (
    !!real &&
    !!data &&
    !!port &&
    port !== USER_PORT &&
    dataDirectory({ ATRIUM_DATA: data }) !==
      dataDirectory({ ATRIUM_DATA: real })
  );
}

/** 给真实服务的请求带上验证身份（值是验证任务 tN），服务端据此拒绝止损类操作（server/tasks/verify-scope.ts）。 */
export const VERIFIER_HEADER = "x-atrium-verifier";

export function verifierHeaders(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (!isVerifier(env) || verifierIsolated(env)) return {};
  return { [VERIFIER_HEADER]: env.ATRIUM_TASK?.trim() || "1" };
}

export function verifierCommandGuard(
  name: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!isVerifier(env) || verifierIsolated(env)) return;
  if (VERIFIER_REFUSED.has(name ?? ""))
    throw new Problem(403, VERIFIER_REFUSAL, "verifier_scope");
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
  "start",
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

/**
 * 写命令缺省以谁的名义（`--as`）：秘书会话带 ATRIUM_AS=secretary，修订与事件就记秘书，不冒用户 u1 的名；
 * 没设时不带（服务端按 u1 记）。leader 进程由令牌定名义，这里不管。
 */
export const defaultActor = (env: NodeJS.ProcessEnv = process.env) =>
  env.ATRIUM_LEADER_TOKEN?.trim()
    ? undefined
    : env.ATRIUM_AS?.trim() || undefined;

/** 缺省订阅者：leader 进程里是自己的 aN，其余是 secretary。 */
export const defaultSubscriber = (env: NodeJS.ProcessEnv = process.env) =>
  env.ATRIUM_LEADER_TOKEN?.trim() && env.ATRIUM_LEADER?.trim()
    ? env.ATRIUM_LEADER.trim()
    : "secretary";
