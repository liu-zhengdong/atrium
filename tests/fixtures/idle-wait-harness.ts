// 给 wait --idle 的崩溃重连测试当可控服务：能声明忙碌，并让 atrium 命令行认作本机服务。
import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createApp } from "../../server/legacy-app.ts";
import { claimService } from "../../server/service-state.ts";
import { sameSecret } from "../../shared/secret.ts";

const data = process.env.ATRIUM_DATA;
const port = Number(process.env.HARNESS_PORT);
const mode = process.env.HARNESS_MODE;
const status = process.env.HARNESS_STATUS;
const name = "空闲验收";

function emit(value: unknown) {
  appendFileSync(status!, `${JSON.stringify(value)}\n`);
}

process.env.ATRIUM_PI_ACP_ENTRY = fileURLToPath(
  new URL("./fake-acp-exit.mjs", import.meta.url),
);

try {
  if (!data || !status || !Number.isInteger(port) || port <= 0)
    throw new Error("harness 缺少 ATRIUM_DATA、HARNESS_PORT 或 HARNESS_STATUS");
  if (
    mode !== "busy" &&
    mode !== "idle" &&
    mode !== "resume-idle" &&
    mode !== "resume-busy"
  )
    throw new Error(`harness 不认识模式 ${mode}`);
  mkdirSync(join(data, "pi"), { recursive: true });
  mkdirSync(join(data, "desktops"), { recursive: true });
  const { app, store, runtimes, pendingWaits } = await createApp({
    data,
    desktops: join(data, "desktops"),
    piHome: join(data, "pi"),
  });
  const timer = (
    runtimes as unknown as { interval?: ReturnType<typeof setInterval> } | null
  )?.interval;
  if (timer) clearInterval(timer);
  if (!runtimes) throw new Error("测试服务没有运行时");
  const lease = claimService(data, port);
  app.get("/api/service", (request, reply) => {
    const actual =
      /^Bearer (.+)$/i.exec(request.headers.authorization ?? "")?.[1] ?? "";
    if (!sameSecret(actual, lease.record.token))
      return reply.code(401).send({ error: "服务控制凭据无效" });
    return {
      instance: lease.record.instance,
      pid: process.pid,
      stopping: false,
      userAuth: "user-v1",
    };
  });
  app.addHook("onRequest", async (request) => {
    if (request.url.includes("/wait"))
      emit({ event: "request", url: request.url });
  });
  const agent =
    mode === "busy" || mode === "idle"
      ? store.createAgent(name, data).agent
      : store.agents().find((item) => item.name === name);
  if (!agent) throw new Error(`没有名为${name}的身份`);
  if (process.env.HARNESS_OLD_END === "1") {
    store.run(
      `INSERT INTO trace_actions(agent_id,runtime_id,generation,session_id,seq,at,kind,name,title,state,input,output,truncated)
       VALUES(?,?,?,?,1,?,'run_end','','本轮运行结束','complete','','',0)`,
      agent.id,
      "old-runtime",
      "old-generation",
      "old-session",
      Date.now() - 60_000,
    );
  }
  const busy = mode === "busy" || mode === "resume-busy";
  type RuntimeConnection =
    (typeof runtimes)["connections"] extends Map<string, infer T> ? T : never;
  const entry: RuntimeConnection = {
    connection: null as unknown as RuntimeConnection["connection"],
    info: {
      runtimeId: agent.id,
      generation: agent.id,
      sessionId: agent.id,
      pid: process.pid,
      ownerPid: null,
      sessionFile: null,
      cwd: data,
      mode: "rpc",
      busy,
      model: "test",
    },
  };
  runtimes.connections.set(agent.id, entry);
  await app.listen({ host: "127.0.0.1", port });
  const watch = setInterval(() => {
    if (pendingWaits() < 1) return;
    emit({ event: "waiting" });
    clearInterval(watch);
  }, 20);
  emit({
    ready: true,
    pid: process.pid,
    id: agent.id,
    ref: agent.ref,
    name: agent.name,
    port,
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (status) appendFileSync(status, `${JSON.stringify({ error: message })}\n`);
  else console.error(message);
  process.exit(1);
}
