import { sameSecret } from "../shared/secret.ts";
import { createApp } from "./app.ts";
import { legacyDir, legacyWorkersDir } from "./imports/dirs.ts";
import { portTakenMessage, probePort } from "./port-owner.ts";
import {
  alive,
  claimService,
  currentVersion,
  dataDirectory,
  servicePort,
  serviceUrl,
} from "./service-state.ts";
import {
  discardLegacyIdleRestart,
  readRestartState,
  writeRestartState,
} from "./supervisor.ts";

const data = dataDirectory();
// t71：端口已被别的程序或另一份数据的 Atrium 占着，就在登记和建表之前退出，
// 只留一句人话，不打印堆栈。本数据目录的服务占着时交给下面的单实例登记报错。
const portTaken = async (port: number) => {
  const owner = await probePort(port);
  if (owner.kind === "free") return null;
  return portTakenMessage(port, owner, data);
};
{
  const taken = await portTaken(servicePort());
  if (taken) {
    console.error(`Atrium 未启动：${taken}`);
    process.exit(1);
  }
}
const lease = claimService(data, servicePort());
// npm 升级会替换包目录；长期运行的服务不能留在会被删除的 cwd。
process.chdir(data);
// 旧版 `restart --when-idle` 留下的待重启记录不再挡派活：丢弃并记日志。
discardLegacyIdleRestart(data);
let app: Awaited<ReturnType<typeof createApp>>["app"] | undefined;
let stopping = false;
let shutdownStarted = false;
// #231：排空完成后上一个 supervisor 可能失联；记下已排空，让接替的
// supervisor 再次 prepare-restart 时拿到 200，接着把升级做完。
let drained = false;
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
  // preClose 会先唤醒 SSE/长轮询；剩余连接或清理句柄仍不能无限拖住升级。
  const disconnect = setTimeout(() => {
    console.warn("HTTP 关闭超过 5 秒，断开剩余连接");
    app?.server.closeAllConnections();
  }, 5000);
  const deadline = setTimeout(() => {
    console.error("服务关闭超过 8 秒，退出旧进程供新服务接管执行者");
    process.exit(1);
  }, 8000);
  try {
    await app?.close();
    clearTimeout(disconnect);
    clearTimeout(deadline);
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
  ({ app } = await createApp({
    data,
    controlToken: lease.record.token,
    serviceUrl: `http://127.0.0.1:${servicePort()}`,
    // 旧版执行者档案与根章程只在首次启动导入一次（#355）；隔离服务不读主目录（t128）。
    tasks: { workersDir: legacyWorkersDir() },
    legacyDir: legacyDir(),
  }));
  const authorize = (value: string | undefined) => {
    const actual = /^Bearer (.+)$/i.exec(value ?? "")?.[1] ?? "";
    return sameSecret(actual, lease.record.token);
  };
  app.addHook("onRequest", async (request, reply) => {
    const route = request.routeOptions.url;
    if (!route?.startsWith("/api/service") || route === "/api/service/info")
      return;
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
  // 免认证的服务身份（t71）：别的数据目录的命令行撞端口时，据此说出这里的数据在哪。
  app.get("/api/service/info", () => ({
    service: "atrium",
    data,
    version: currentVersion(),
  }));
  // 发起排空的 supervisor：请求体带 PID；旧版 supervisor 不带时参考 restart-state。
  const drainOwner = (value: unknown): number | null => {
    if (Number.isInteger(value) && (value as number) > 0)
      return value as number;
    const state = readRestartState(data);
    return state?.status === "stopping" && state.supervisorPid > 0
      ? state.supervisorPid
      : null;
  };
  const recoverFromDrain = (supervisorPid: number | null) => {
    clearDrainWatch();
    stopping = false;
    drained = false;
    const reason = `排空完成后 ${drainRecoverMs / 1000} 秒内没有收到停止请求，发起重启的 supervisor${supervisorPid ? `（PID ${supervisorPid}）` : ""}已不在`;
    console.warn(
      `[${new Date().toISOString()}] 平滑重启未完成：${reason}；旧服务恢复运行`,
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
        recoverFromDrain(supervisorPid);
      },
      Math.min(1000, drainRecoverMs),
    );
    drainWatch.unref();
  };
  // 执行者在独立进程组里，不随服务退出；新服务按 pid 接管，重启窗口内退出的由
  // 接管后的收尾补上（server/tasks/recovery.ts），所以随时可以重启，不等空闲。
  app.post("/api/service/prepare-restart", async (request, reply) => {
    const body =
      (request.body as
        { timeout?: number; supervisorPid?: number } | undefined) ?? {};
    if (stopping) {
      if (drained && !stopRequested) {
        // 接替的 supervisor 接手：之后以它为准重新计时。
        armDrainWatch(drainOwner(body.supervisorPid));
        return { ready: true, agentsToWake: [] };
      }
      return reply.code(409).send({ error: "服务正在关闭" });
    }
    const timeout = Number(body.timeout ?? 300000);
    if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 7200000)
      return reply
        .code(400)
        .send({ error: "timeout 必须为 1000–7200000 毫秒" });
    stopping = true;
    drained = true;
    armDrainWatch(drainOwner(body.supervisorPid));
    return { ready: true, agentsToWake: [] };
  });
  app.get("/api/service/health", async (_request, reply) => {
    const health = {
      ok: !stopping,
      version: currentVersion(),
      instance: lease.record.instance,
      pid: process.pid,
      stopping,
    };
    if (!health.ok) return reply.code(503).send(health);
    return health;
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
  // 查端口与监听之间被别人抢先占了端口：同样只报一句人话。
  if ((error as NodeJS.ErrnoException).code === "EADDRINUSE")
    console.error(
      `Atrium 未启动：${(await portTaken(lease.record.port)) ?? `端口 ${lease.record.port} 已被占用`}`,
    );
  else console.error(error);
  // #205：启动失败的服务从未就绪，没有可排空的状态。`app.close()` 要等启动
  // 中的 ACP 握手与账号刷新，既会拖过命令行 12 秒的启动等待（把「端口占用」
  // 报成「启动超时」），也会撞上 Fastify 的插件超时抛出未捕获错误、跳过租约
  // 释放。这里反过来收尾：先还租约，终止启动期子进程，再退出，让失败原因、
  // 租约和子进程在命令行的等待窗口内一起消失。
  lease.release();
  process.exitCode = 1;
  // 通常随子进程退出自然结束；句柄残留时兜底强制退出，不等命令行超时。
  setTimeout(() => process.exit(1), 2000).unref();
}
