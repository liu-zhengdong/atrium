import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  commandLineInvocation,
  processAlive,
  runFile,
} from "../platform/index.ts";
import { Problem } from "../problem.ts";
import { currentVersion } from "../service-state.ts";
import { Agent, normalizeServer } from "./main.ts";
import { SERVICE_ENV_FILE } from "./service-plan.ts";
import { AgentState, type AgentPid } from "./state.ts";

/** 这个 pid 还是不是一个 atrium 代理（防 pid 复用）；查不到命令行时只看进程在不在。 */
export async function agentAlive(record: AgentPid | null) {
  if (!record || record.pid === process.pid || !processAlive(record.pid))
    return false;
  const call = commandLineInvocation(process.platform, record.pid);
  const found = await runFile(call.command, call.args, { timeout: 10_000 });
  if (found.error) return true;
  return /\bagent\b/.test(found.stdout);
}

/** 以服务身份起来时带上装服务那会儿的环境（PATH、出网代理、并发上限）；文件坏了照常起，只用系统给的环境。 */
function loadServiceEnv(data: string) {
  const file = join(data, SERVICE_ENV_FILE);
  if (!existsSync(file)) return;
  try {
    const saved = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >;
    for (const [key, value] of Object.entries(saved))
      if (typeof value === "string") process.env[key] = value;
  } catch {
    console.error(
      `${file} 写坏了，照系统给的环境启动；重跑 atrium agent install 可重写`,
    );
  }
}

/**
 * `atrium agent` 的入口：前台常驻到 Ctrl-C 或令牌失效；返回退出码。
 * `service` 为系统服务拉起（t183）：令牌失效以 0 退出（重起也没用），前台代理还在跑时以 1 退出、隔一会儿由系统重起接手。
 */
export async function runAgent(input: {
  server?: string;
  code?: string;
  data: string;
  service?: boolean;
}) {
  const { data } = input;
  if (input.service) loadServiceEnv(data);
  const state = new AgentState(data);
  const configured = input.server ?? state.config()?.server;
  if (!configured)
    throw new Problem(
      400,
      "--server 必填：首次接入时使用 host add 回执里的地址；接入后可省略",
      "usage",
    );
  const server = normalizeServer(configured);
  const other = state.pid();
  if (await agentAlive(other)) {
    const what = other!.service ? "系统服务" : "前台";
    if (input.service) {
      console.error(
        `这台已有代理在跑（${what}，PID ${other!.pid}）；等它停下后接手`,
      );
      return 1;
    }
    throw new Problem(
      409,
      `这台已有代理在跑（${what}，PID ${other!.pid}）；同一数据目录只跑一个`,
      "conflict",
      undefined,
      other!.service ? "atrium agent install --status" : undefined,
    );
  }
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
  console.log(
    `Atrium 代理${input.service ? "（系统服务）" : ""} · 服务 ${server} · 数据 ${data}`,
  );
  state.savePid({
    pid: process.pid,
    service: input.service === true,
    startedAt: Date.now(),
  });
  try {
    await agent.start();
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    state.clearPid(process.pid);
  }
  if (agent.failure) {
    console.error(
      `代理已停止：${agent.failure}。在服务那台机器上重新 atrium host add 拿接入码，再 atrium agent ${input.service ? "install " : ""}--server ${server} --token 接入码`,
    );
    return input.service ? 0 : 1;
  }
  console.log(
    input.service
      ? "代理已停止（系统服务）；在跑的执行者照跑"
      : "代理已停止；在跑的执行者照跑，再运行 atrium agent 接着看",
  );
  return 0;
}
