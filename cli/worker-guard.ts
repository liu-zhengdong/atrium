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
