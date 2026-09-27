import { currentVersion } from "../service-state.ts";
import { Agent, normalizeServer } from "./main.ts";
import { agentDataDir } from "./state.ts";

/** `atrium agent` 的入口：前台常驻到 Ctrl-C 或令牌失效；返回退出码。 */
export async function runAgent(input: { server: string; code?: string }) {
  const server = normalizeServer(input.server);
  const data = agentDataDir();
  const url = new URL(server);
  if (
    url.protocol === "http:" &&
    !["127.0.0.1", "localhost", "[::1]", "host.orb.internal"].includes(
      url.hostname,
    )
  )
    console.error(
      "提示：令牌走明文 HTTP；跨公网请用 HTTPS 或 SSH 转发（ssh -R）把服务端口带到这台机器的 127.0.0.1",
    );
  const agent = new Agent({
    server,
    data,
    env: process.env,
    code: input.code?.trim() || undefined,
    version: currentVersion(),
  });
  const stop = () => agent.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.log(`Atrium 代理 · 服务 ${server} · 数据 ${data}`);
  try {
    await agent.start();
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  if (agent.failure) {
    console.error(
      `代理已停止：${agent.failure}。在服务那台机器上重新 atrium host add 拿接入码，再 atrium agent --server ${server} --token 接入码`,
    );
    return 1;
  }
  console.log("代理已停止；在跑的执行者照跑，再运行 atrium agent 接着看");
  return 0;
}
