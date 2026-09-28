import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKER_FLAG } from "../cli/worker-guard.ts";

/**
 * 测试起子进程用的环境（#262 小修）：一律摘掉执行者标记。
 * 夹具本来就用隔离的数据目录与端口；留着 ATRIUM_WORKER=1 会让命令行防护
 * 把测试自己的 atrium 子进程当成「操作用户的 Atrium 服务」拒掉。
 * 只用于测试的子进程：服务给执行者设的 ATRIUM_WORKER 由 server/tasks/worker-env.ts 负责。
 * 旧版档案目录指向不存在的临时路径，免得服务首次启动导入开发者主目录里的 ~/Atrium/workers（#355）。
 * 颜色固定关掉：状态栏按 NO_COLOR 决定上不上色（给 Claude Code 的管道输出也要带色），
 * 执行者环境带 NO_COLOR=1 而 GitHub Actions 不带，不固定的话同一条断言本机过、CI 挂（t111）。
 * 要测带色的用例显式覆盖 NO_COLOR。
 */
export function childEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ATRIUM_WORKERS_DIR: join(tmpdir(), "atrium-test-no-workers"),
    NO_COLOR: "1",
    ...overrides,
  };
  delete env[WORKER_FLAG];
  delete env.FORCE_COLOR;
  return env;
}
