import { sameSecret } from "../shared/secret.ts";
import { join } from "node:path";
import { templateChoice } from "./identity-env.ts";
import { createApp } from "./app.ts";
import { RunnerBridge } from "./runner-bridge.ts";
import { ownerOf, rebindStopped } from "./runner-ownership.ts";
import { z } from "zod";
import {
  alive,
  claimService,
  currentVersion,
  dataDirectory,
  packageRoot,
  servicePort,
  serviceUrl,
} from "./service-state.ts";
import { ensureWebDist } from "./web-dist.ts";
import { readRestartState, writeRestartState } from "./supervisor.ts";

await ensureWebDist(packageRoot);
const data = dataDirectory();
const lease = claimService(data, servicePort());
let app: Awaited<ReturnType<typeof createApp>>["app"] | undefined;
let stopping = false;
let shutdownStarted = false;
// #231：排空完成后上一个 supervisor 可能失联；保留唤醒名单，让接替的
// supervisor 再次 prepare-restart 时拿到 200 与名单，接着把升级做完。
let drainedAgentsToWake: string[] | null = null;
// #244：排空完成后等停的上限。超过上限且发起排空的 supervisor 已不在、也没收到
// stop，才恢复运行；supervisor 还活着就一直等它，避免它发 stop 前抢先恢复、与
// 它随后拉起的新服务同时写数据。测试用 ATRIUM_DRAIN_RECOVER_MS 缩短。
const drainRecoverMs = (() => {
  const value = Number(process.env.ATRIUM_DRAIN_RECOVER_MS ?? 60000);
  return Number.isInteger(value) && value >= 100 ? value : 60000;
})();
let stopRequested = false;
let drainWatch: ReturnType<typeof setInterval> | undefined;
const clearDrainWatch = () => {
  if (drainWatch) clearInterval(drainWatch);
  drainWatch = undefined;
};
const shutdown = async () => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  stopping = true;
  clearDrainWatch();
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
  const template = templateChoice(process.env);
  console.log(`Pi 模板：${template.path}（来源：${template.source}）`);
  let runtimes: Awaited<ReturnType<typeof createApp>>["runtimes"];
  let store: Awaited<ReturnType<typeof createApp>>["store"];
  let runnerAuth: Awaited<ReturnType<typeof createApp>>["runnerAuth"];
  ({ app, runtimes, store, runnerAuth } = await createApp({
    data,
    webRoot: join(packageRoot, "dist"),
    controlToken: lease.record.token,
  }));
  const bridge = new RunnerBridge(
    app.server,
    (token) => runnerAuth.authenticateRunner(`Bearer ${token}`),
    (principal) =>
      runnerAuth.validRunnerCredential(
        principal.runnerId,
        principal.credentialId,
      ),
    (agentId) => ownerOf(store, agentId),
    async (principal, method, payload) => {
      if (method === "runner.heartbeat") return { ok: true };
      if (method !== "runner.reconcile")
        throw new Error("unsupported runner method");
      const input = z
        .object({
          oldGeneration: z.string().nullable(),
          defaultStatus: z.enum(["exited", "alive", "unknown"]),
          statuses: z.record(
            z.string(),
            z.enum(["exited", "alive", "unknown"]),
          ),
        })
        .strict()
        .parse(payload);
      const generation = bridge.generation(principal.runnerId);
      if (!generation) throw new Error("运行器连接已断开");
      const result = rebindStopped(
        store,
        principal.runnerId,
        input.oldGeneration,
        generation,
        input.statuses,
        input.defaultStatus,
      );
      runtimes?.noteRunnerRecovery(result.rebound, result.locked);
      return result;
    },
    (agentId) => store.agent(agentId).ref,
  );
  runnerAuth.listenFencing((_runnerId, credentialIds) => {
    for (const credentialId of credentialIds)
      bridge.revokeCredential(credentialId);
  });
  runtimes?.setBridge(bridge);
  const authorize = (value: string | undefined) => {
    const actual = /^Bearer (.+)$/i.exec(value ?? "")?.[1] ?? "";
    return sameSecret(actual, lease.record.token);
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
  // 发起排空的 supervisor：请求体带 PID；旧版 supervisor 不带时参考 restart-state。
  const drainOwner = (value: unknown): number | null => {
    if (Number.isInteger(value) && (value as number) > 0)
      return value as number;
    const state = readRestartState(data);
    return state?.status === "stopping" && state.supervisorPid > 0
      ? state.supervisorPid
      : null;
  };
  const recoverFromDrain = async (supervisorPid: number | null) => {
    clearDrainWatch();
    const agents = drainedAgentsToWake ?? [];
    stopping = false;
    drainedAgentsToWake = null;
    const reason = `排空完成后 ${drainRecoverMs / 1000} 秒内没有收到停止请求，发起重启的 supervisor${supervisorPid ? `（PID ${supervisorPid}）` : ""}已不在`;
    const names = agents.map((id) => {
      try {
        const agent = store.agent(id);
        return `${agent.name}（${agent.ref}）`;
      } catch {
        return id;
      }
    });
    console.warn(
      `[${new Date().toISOString()}] 平滑重启未完成：${reason}；旧服务恢复接收新回合，唤醒 ${names.join("、") || "（无）"}`,
    );
    try {
      const state = readRestartState(data);
      if (
        state &&
        state.oldPid === process.pid &&
        !["success", "rolled_back", "failed"].includes(state.status) &&
        !(state.supervisorPid > 0 && alive(state.supervisorPid))
      )
        writeRestartState(data, {
          ...state,
          status: "failed",
          error: `${reason}；旧服务（PID ${process.pid}）已自动恢复运行。要完成升级请重新运行 atrium restart`,
          finishedAt: Date.now(),
        });
    } catch (error) {
      console.warn(`更新 restart-state 失败：${String(error)}`);
    }
    await runtimes?.resumeAfterDrain(agents);
  };
  const armDrainWatch = (supervisorPid: number | null) => {
    clearDrainWatch();
    const deadline = Date.now() + drainRecoverMs;
    let waitingLogged = false;
    drainWatch = setInterval(
      () => {
        if (shutdownStarted || stopRequested || !stopping) {
          clearDrainWatch();
          return;
        }
        if (Date.now() < deadline) return;
        if (supervisorPid && alive(supervisorPid)) {
          if (!waitingLogged)
            console.log(
              `平滑重启排空已完成 ${drainRecoverMs / 1000} 秒，supervisor（PID ${supervisorPid}）仍在，继续等待它停止旧服务`,
            );
          waitingLogged = true;
          return;
        }
        void recoverFromDrain(supervisorPid);
      },
      Math.min(1000, drainRecoverMs),
    );
    drainWatch.unref();
  };
  app.post("/api/service/prepare-restart", async (request, reply) => {
    const body =
      (request.body as
        { timeout?: number; supervisorPid?: number } | undefined) ?? {};
    if (stopping) {
      if (drainedAgentsToWake && !stopRequested) {
        // 接替的 supervisor 接手：之后以它为准重新计时。
        armDrainWatch(drainOwner(body.supervisorPid));
        return { ready: true, agentsToWake: drainedAgentsToWake };
      }
      return reply.code(409).send({ error: "服务正在关闭" });
    }
    const timeout = Number(body.timeout ?? 300000);
    if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 7200000)
      return reply
        .code(400)
        .send({ error: "timeout 必须为 1000–7200000 毫秒" });
    // #231：supervisor 在排空中途断开时中止排空、恢复运行，不再永久卡在
    // stopping；响应已发出后触发的 close 不影响结果。
    // 必须监听响应而非请求：Node 16+ 的 IncomingMessage 在请求体读完时就发
    // close，那样每次排空一开始就被中止，忙碌身份的 restart 立即 409。
    const drainAbort = new AbortController();
    reply.raw.once("close", () => {
      if (!reply.raw.writableEnded) drainAbort.abort();
    });
    let agentsToWake: string[];
    try {
      agentsToWake =
        (await runtimes?.prepareShutdown(timeout, drainAbort.signal)) ?? [];
    } catch (error) {
      console.warn(`平滑重启排空未完成，服务继续运行：${String(error)}`);
      return reply.code(409).send({ error: String(error) });
    }
    stopping = true;
    drainedAgentsToWake = agentsToWake;
    armDrainWatch(drainOwner(body.supervisorPid));
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
    // 收到 stop 后不再恢复：supervisor 接下来会拉起新服务。
    stopRequested = true;
    clearDrainWatch();
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
