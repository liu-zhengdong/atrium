import { WORKER_FLAG } from "../cli/worker-guard.ts";

/**
 * 测试起子进程用的环境（#262 小修）：一律摘掉执行者标记。
 * 夹具本来就用隔离的数据目录与端口；留着 ATRIUM_WORKER=1 会让命令行防护
 * 把测试自己的 atrium 子进程当成「操作用户的 Atrium 服务」拒掉。
 * 只用于测试的子进程：服务给执行者设的 ATRIUM_WORKER 由 server/tasks/worker-env.ts 负责。
 */
export function childEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  delete env[WORKER_FLAG];
  return env;
}
