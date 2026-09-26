import { homedir } from "node:os";
import { resolve } from "node:path";

/** 服务侧可用的 Pi 模板选择；ATRIUM_* 优先，随后才是调用者可见的模板变量。 */
export function templateChoice(env: NodeJS.ProcessEnv) {
  if (env.ATRIUM_PI_TEMPLATE !== undefined)
    return {
      path: resolve(env.ATRIUM_PI_TEMPLATE),
      source: "ATRIUM_PI_TEMPLATE",
    };
  if (env.PI_CODING_AGENT_DIR !== undefined)
    return {
      path: resolve(env.PI_CODING_AGENT_DIR),
      source: "PI_CODING_AGENT_DIR",
    };
  return { path: resolve(homedir(), ".pi/agent"), source: "默认" };
}
