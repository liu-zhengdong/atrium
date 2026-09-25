import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  cleanIdentityEnvironment,
  identityEnvironmentContext,
  identityScopedVariables,
  templateChoice,
} from "./identity-env.ts";
import { createApp } from "./app.ts";
import {
  claimService,
  currentVersion,
  dataDirectory,
  packageRoot,
  servicePort,
  serviceUrl,
} from "./service-state.ts";
import { ensureWebDist } from "./web-dist.ts";

await ensureWebDist(packageRoot);
const data = dataDirectory();
const lease = claimService(data, servicePort());
let app: Awaited<ReturnType<typeof createApp>>["app"] | undefined;
let stopping = false;
let shutdownStarted = false;
const shutdown = async () => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  stopping = true;
  try {
    await app?.close();
    lease.release();
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
};
// Release only after application cleanup; crash records are reclaimed after PID exit.
process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});
try {
  // The CLI can check the Pi-home layout; the service also checks recorded paths
  // for identities whose directories have been moved outside that layout.
  const dbPath = join(data, "atrium.sqlite");
  let identityDirectories: string[] = [];
  if (process.env.PI_CODING_AGENT_DIR && existsSync(dbPath)) {
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='agents'").get())
          identityDirectories = db
            .prepare(
              "SELECT agent_directory FROM agents WHERE agent_directory IS NOT NULL",
            )
            .all()
            .map((row) => String(row.agent_directory));
      } finally {
        db.close();
      }
    } catch (error) {
      console.warn("读取身份目录失败，继续按 Pi 目录判断：", error);
    }
  }
  const cleaned = cleanIdentityEnvironment(
    process.env,
    identityEnvironmentContext(
      process.env,
      process.env.ATRIUM_PI_HOME,
      identityDirectories,
    ),
  );
  const fromCli = (process.env.ATRIUM_IGNORED_IDENTITY_ENV ?? "")
    .split(",")
    .filter((key) =>
      identityScopedVariables.some((allowed) => allowed === key),
    );
  delete process.env.ATRIUM_IGNORED_IDENTITY_ENV;
  for (const key of cleaned.ignored) delete process.env[key];
  const ignored = [...new Set([...fromCli, ...cleaned.ignored])];
  if (ignored.length) console.log(`已忽略身份环境变量：${ignored.join(", ")}`);
  const template = templateChoice(process.env);
  console.log(`Pi 模板：${template.path}（来源：${template.source}）`);
  let runtimes: Awaited<ReturnType<typeof createApp>>["runtimes"];
  let store: Awaited<ReturnType<typeof createApp>>["store"];
  ({ app, runtimes, store } = await createApp({
    data,
    webRoot: join(packageRoot, "dist"),
    controlToken: lease.record.token,
  }));
  const authorize = (value: string | undefined) => {
    const actual = Buffer.from(/^Bearer (.+)$/i.exec(value ?? "")?.[1] ?? "");
    const expected = Buffer.from(lease.record.token);
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  };
  app.addHook("onRequest", async (request, reply) => {
    if (!request.routeOptions.url?.startsWith("/api/service")) return;
    if (!authorize(request.headers.authorization))
      return reply.code(401).send({ error: "服务控制凭据无效" });
  });
  const status = () => ({
    instance: lease.record.instance,
    pid: process.pid,
    stopping,
    version: currentVersion(),
    userAuth: "user-v1",
  });
  app.get("/api/service", () => {
    return status();
  });
  app.post("/api/service/prepare-restart", async (request, reply) => {
    if (stopping) return reply.code(409).send({ error: "服务正在关闭" });
    const body = (request.body as { timeout?: number } | undefined) ?? {};
    const timeout = Number(body.timeout ?? 300000);
    if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 7200000)
      return reply
        .code(400)
        .send({ error: "timeout 必须为 1000–7200000 毫秒" });
    let agentsToWake: string[];
    try {
      agentsToWake = (await runtimes?.prepareShutdown(timeout)) ?? [];
    } catch (error) {
      return reply.code(409).send({ error: String(error) });
    }
    stopping = true;
    return { ready: true, agentsToWake };
  });
  app.get("/api/service/health", async (_request, reply) => {
    const runtimesHealth = runtimes
      ? runtimes.health()
      : { available: false, error: "运行时未初始化" };
    const health = {
      ok: !stopping && runtimesHealth.available,
      version: currentVersion(),
      instance: lease.record.instance,
      pid: process.pid,
      stopping,
      runtimes: runtimesHealth,
    };
    if (!health.ok) {
      return reply.code(503).send(health);
    }
    return health;
  });
  app.post("/api/service/probe", async (request, reply) => {
    const id = (request.body as { id?: string } | undefined)?.id;
    if (typeof id !== "string" || !store || !runtimes)
      return reply.code(400).send({ error: "缺少身份 ID" });
    try {
      store.agent(id);
      if (!runtimes.connections.has(id)) await runtimes.start(id);
      const deliveryId = store.queue(
        id,
        "direct",
        "[Atrium 健康检查] 回复一句即可，勿执行其他任务。",
      );
      void runtimes.pump(id, true);
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        const delivery = store.one<{ state: string; error: string | null }>(
          "SELECT state,error FROM deliveries WHERE id=?",
          deliveryId,
        );
        if (delivery?.state === "complete") return { completed: true, id };
        if (delivery?.error) throw new Error(delivery.error);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("身份回合验证超时");
    } catch (error) {
      return reply.code(503).send({ error: String(error) });
    }
  });
  app.post("/api/service/wake", async (request, reply) => {
    const id = (request.body as { id?: string } | undefined)?.id;
    if (typeof id !== "string" || !store || !runtimes)
      return reply.code(400).send({ error: "缺少身份 ID" });
    store.agent(id);
    if (!runtimes.connections.has(id)) await runtimes.start(id);
    store.queue(
      id,
      "direct",
      "[Atrium 重启完成] 请继续刚才的工作；先核对当前状态，避免重复执行已完成的操作。",
    );
    void runtimes.pump(id, true);
    return { woken: true };
  });
  app.post("/api/service/stop", (_request, reply) => {
    reply.raw.once("finish", () => {
      void shutdown();
    });
    return status();
  });
  await app.listen({ port: lease.record.port, host: "127.0.0.1" });
  console.log(`Atrium → ${serviceUrl(lease.record)}\n数据：${data}`);
} catch (error) {
  console.error(error);
  await app?.close();
  lease.release();
  process.exitCode = 1;
}
