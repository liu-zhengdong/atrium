import Fastify from "fastify";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { sameSecret } from "../shared/secret.ts";
import { Problem } from "./problem.ts";
import { UserAuth } from "./user-auth.ts";
import { authPolicy } from "./auth-policy.ts";
import { registerTaskRoutes, runnerEnvOptions } from "./tasks/routes.ts";
import { registerOrgRoutes } from "./org/routes.ts";
import { registerGoalRoutes } from "./goals/routes.ts";
import type { GoalCheckOptions } from "./goals/check-runtime.ts";
import { registerSkillRoutes } from "./skills/routes.ts";
import { registerQuotaRoute } from "./tasks/quota.ts";
import type { RunnerOptions } from "./tasks/runner.ts";

/** 打开数据库。旧运行时留下的表（身份、聊天、账号等）不读不写，也不因它们存在而报错。 */
export function openDatabase(data: string) {
  const db = new DatabaseSync(join(data, "atrium.sqlite"));
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;",
  );
  return db;
}

/**
 * 组织运行时的 HTTP 入口（#291）：只注册用户认证、任务账本与派活、组织树、目标树、额度和事件路由；
 * 服务控制（/api/service/*）由 main.ts 注册。
 */
export async function createApp(options: {
  data: string;
  controlToken?: string;
  /** 领域测试显式关闭用户认证；生产从不设置。 */
  auth?: boolean;
  /** 安全测试逐条审计已注册的路由。 */
  onRoute?: (method: string, url: string) => void;
  /** 任务运行时（#262）的注入项：测试用来缩短看门狗间隔、替换 git/gh 调用。 */
  tasks?: Partial<RunnerOptions>;
  /** 目标判定（#313）的注入项：测试用来缩短命令超时、替换 git 调用。 */
  goals?: Partial<Omit<GoalCheckOptions, "data">>;
  /** OpenQuota 可执行文件路径，测试注入假二进制。 */
  quotaBin?: string;
}) {
  mkdirSync(options.data, { recursive: true, mode: 0o700 });
  const db = openDatabase(options.data);
  const auth = new UserAuth(db, options.data);
  const app = Fastify({
    logger: { level: "warn" },
    bodyLimit: 4 * 1024 * 1024,
  });
  app.addHook("onRoute", (route) => {
    for (const method of [route.method].flat())
      options.onRoute?.(method, route.url);
  });
  app.addHook("onClose", async () => db.close());
  app.setErrorHandler((error, request, reply) => {
    const status =
      error instanceof z.ZodError
        ? 400
        : error instanceof Problem
          ? error.statusCode
          : ((error as { statusCode?: number }).statusCode ?? 500);
    void reply.code(status).send({
      code:
        error instanceof Problem
          ? error.code
          : status === 400
            ? "usage"
            : status === 403 || status === 409
              ? "conflict"
              : status === 404
                ? "not_found"
                : "internal",
      ...(error instanceof Problem && error.candidates?.length
        ? { candidates: error.candidates }
        : {}),
      ...(error instanceof Problem && error.nextCommand
        ? { nextCommand: error.nextCommand }
        : {}),
      error:
        error instanceof z.ZodError
          ? error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("；")
          : status >= 500
            ? "服务处理失败，请检查本地日志"
            : error instanceof Error
              ? error.message
              : String(error),
    });
    if (status >= 500) {
      if (/^\/api\/auth(\/|$)/.test(request.url))
        app.log.error("认证处理失败（详情已隐藏）");
      else app.log.error(error);
    }
  });
  app.addHook("onRequest", async (request, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer");
    let hostname: string;
    try {
      hostname = new URL(`http://${request.headers.host}`).hostname;
    } catch {
      throw new Problem(403, "不接受此 Host");
    }
    if (
      !["localhost", "atrium.localhost", "127.0.0.1", "[::1]"].includes(
        hostname,
      )
    )
      throw new Problem(403, "管理入口仅面向本机");
    const origin = request.headers.origin;
    if (origin) {
      let host: string;
      try {
        host = new URL(origin).host;
      } catch {
        throw new Problem(403, "Origin 格式无效");
      }
      if (host !== request.headers.host)
        throw new Problem(403, "不接受跨站请求");
    }
  });
  const requireRotation = (authorization: string | undefined) => {
    const control = options.controlToken;
    if (
      !auth.validUser(authorization) &&
      !(
        control &&
        sameSecret(authorization?.replace(/^Bearer /i, "") ?? "", control)
      )
    )
      throw new Problem(
        401,
        "用户或实例控制凭据无效",
        "auth_required",
        undefined,
        "atrium auth rotate",
      );
  };
  // onRequest 拿得到匹配的路由，且在读请求体之前运行。
  app.addHook("onRequest", async (request) => {
    if (options.auth === false) return;
    const route = request.routeOptions.url ?? "";
    if (route === "/api/auth/rotate") {
      requireRotation(request.headers.authorization);
      return;
    }
    // /api/service/* 由 main.ts 用实例控制凭据校验；没有 Web 外壳，未匹配的路径也要求用户凭据再报 404。
    if (authPolicy(request.method, route) !== "user") return;
    if (auth.validUser(request.headers.authorization)) return;
    throw new Problem(
      401,
      request.headers.authorization
        ? "用户认证失效；请运行 atrium auth rotate（确认 ATRIUM_DATA 指向当前数据目录）"
        : "服务已升级，请重新运行命令；若仍失败，请运行 atrium auth rotate（确认 ATRIUM_DATA 指向当前数据目录）",
      "auth_required",
      undefined,
      "atrium auth rotate",
    );
  });
  app.post("/api/auth/rotate", { bodyLimit: 16 * 1024 }, () => {
    auth.rotate();
    return { rotated: true };
  });
  // 任务账本（#262）：表与路由在 server/tasks/；执行者进程由服务持有，日志在 <ATRIUM_DATA>/tasks/<id>/。
  const taskRunner = registerTaskRoutes(app, db, {
    data: resolve(options.data),
    ...runnerEnvOptions(),
    ...options.tasks,
  });
  registerOrgRoutes(app, db);
  registerGoalRoutes(app, db, {
    data: resolve(options.data),
    ...options.goals,
  });
  registerSkillRoutes(app, db);
  registerQuotaRoute(app, { bin: options.quotaBin, db });
  return { app, db, taskRunner };
}
