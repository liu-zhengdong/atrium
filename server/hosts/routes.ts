import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { Problem } from "../problem.ts";
import type { TaskRunner } from "../tasks/runner.ts";
import { TOOLS } from "../tasks/adapters/types.ts";
import { authPolicy } from "../auth-policy.ts";
import { resolveActor } from "../actor.ts";
import { LIMITS, SLUG_RE } from "../skills/model.ts";
import {
  joinCodeOf,
  joinCodeValid,
  joinHost,
  verifyHostToken,
} from "./model.ts";
import { hostRef } from "./state.ts";

/**
 * 执行机器的 HTTP 入口（#358 第 1 步）。
 * /api/hosts：用户管理主机（走默认的用户认证）。
 * /api/agent/*：代理专用（auth-policy 标为 agent）：接入用一次性接入码，其余只认主机令牌，
 * 只能领派给自己的指令、上报自己这台上的日志与退出，碰不到组织、任务账本和别的主机。
 */

const cli = z.object({
  installed: z.boolean(),
  logged_in: z.boolean().nullable(),
});
const info = z.object({
  hostname: z.string().max(200),
  os: z.string().max(40),
  arch: z.string().max(40),
  cpus: z.number().int().min(1).max(4096),
  mem_mb: z.number().int().min(0).max(1e9),
  node: z.string().max(40),
  version: z.string().max(40),
  data_dir: z.string().min(1).max(1000),
  clis: z.partialRecord(z.enum(TOOLS), cli),
  max_workers: z.number().int().min(1).max(4096).nullable(),
  skills: z.boolean().optional(),
});
const load = z.object({
  load: z.number().min(0).max(1e6),
  running: z.number().int().min(0).max(100000),
  busy: z.string().max(500).nullable(),
});
const id = z.number().int().min(1).max(1e12);
/** 代理传回的技能副本（t232）：内容在生成提议时再按技能规则校验。 */
const skillReport = z
  .object({
    edits: z
      .array(
        z.union([
          z
            .object({
              id,
              slug: z.string().regex(SLUG_RE).max(64),
              rev: id,
              files: z.record(
                z.string().max(400),
                z.string().max(LIMITS.bytes),
              ),
            })
            .strict(),
          z
            .object({
              id,
              slug: z.string().regex(SLUG_RE).max(64),
              rev: id,
              problem: z.string().max(500),
            })
            .strict(),
        ]),
      )
      .max(LIMITS.perTask * 4),
    notes: z.string().max(LIMITS.proposalReason).optional(),
  })
  .strict();
const run = z.object({
  task: id,
  run: id,
  state: z.enum(["running", "exited"]),
});

const text = (max: number) => z.string().max(max);
const quotaWindow = z.object({
  id: text(80),
  label: text(80),
  usedPercent: z.number().min(-1e6).max(1e6),
  resetsAt: z.number().nullable(),
  periodSeconds: z.number().min(0).max(1e9),
});
/** 代理上报的额度读数：只有数字、套餐名与账号指纹（不含令牌），各字段有界。 */
const reading = z.object({
  provider: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
  outcome: z.union([
    z.object({
      ok: z.literal(true),
      result: z.object({
        ok: z.literal(true),
        plan: text(80).nullable(),
        windows: z.array(quotaWindow).max(20),
        refreshedAt: z.number(),
        account: z
          .string()
          .regex(/^[a-f0-9]{8,64}$/)
          .nullable()
          .optional(),
      }),
      note: text(300).nullable(),
    }),
    z.object({ ok: z.literal(false), reason: text(300) }),
  ]),
});

const params = (request: FastifyRequest) =>
  (request.params ?? {}) as { id?: string };

/** 客户端断开时中止长轮询。 */
function disconnect(request: FastifyRequest) {
  const controller = new AbortController();
  request.raw.once("close", () => controller.abort());
  return controller.signal;
}

export function registerHostRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  runner: TaskRunner,
) {
  app.get("/api/hosts", (request) =>
    runner.hosts(((request.query ?? {}) as { all?: string }).all === "1"),
  );
  app.get("/api/hosts/:id", (request) => runner.hostDetail(params(request).id));
  app.post("/api/hosts", { bodyLimit: 16 * 1024 }, (request) =>
    runner.addHost(request.body),
  );
  app.patch("/api/hosts/:id", { bodyLimit: 16 * 1024 }, (request) =>
    runner.editHost(params(request).id, request.body),
  );
  app.delete("/api/hosts/:id", (request) =>
    runner.removeHost(params(request).id),
  );
  // host clean：停掉在那台跑的执行者，再结束已结束任务留下的执行者进程树。
  // 停下的任务在停止事件里记发起者（t239）：?as= 给的 u1、secretary 或 aN，缺省 u1。
  app.post("/api/hosts/:id/clean", { bodyLimit: 1024 }, (request) =>
    runner.cleanHost(
      params(request).id,
      resolveActor(db, (request.query as { as?: string } | undefined)?.as),
    ),
  );

  // ---- 代理 ----
  // 认证在路由匹配后、读请求体之前：接入认一次性接入码，其余认主机令牌，都放在 Authorization 头里。
  const agents = new WeakMap<FastifyRequest, number>();
  const refused = () =>
    new Problem(
      401,
      "主机令牌或接入码无效：这台主机已被移除、令牌不对，或接入码用过、过期；在服务那台机器上重新 atrium host add 拿接入码",
      "auth_required",
    );
  app.addHook("onRequest", async (request) => {
    const route = request.routeOptions.url ?? "";
    if (authPolicy(request.method, route) !== "agent") return;
    if (route === "/api/agent/join") {
      const code = joinCodeOf(request.headers.authorization);
      if (!code || !joinCodeValid(db, code)) throw refused();
      return;
    }
    const host = verifyHostToken(db, request.headers.authorization);
    if (host === null) throw refused();
    agents.set(request, host);
  });
  const hostOf = (request: FastifyRequest) => {
    const host = agents.get(request);
    if (host === undefined) throw refused();
    return host;
  };
  const remote = runner.remote;
  app.post("/api/agent/join", { bodyLimit: 64 * 1024 }, (request) => {
    const body = z
      .object({ info })
      .strict()
      .parse(request.body ?? {});
    const joined = joinHost(
      db,
      joinCodeOf(request.headers.authorization) ?? "",
      body.info,
    );
    return { host: hostRef(joined.id), token: joined.token };
  });
  app.post("/api/agent/hello", { bodyLimit: 1024 * 1024 }, (request) => {
    const host = hostOf(request);
    const body = z
      .object({ info, runs: z.array(run).max(1000) })
      .strict()
      .parse(request.body ?? {});
    return remote.hello(host, body);
  });
  app.post("/api/agent/poll", { bodyLimit: 256 * 1024 }, (request) => {
    const host = hostOf(request);
    const body = z
      .object({ load, busy: z.array(z.string().max(64)).max(1000) })
      .strict()
      .parse(request.body ?? {});
    return remote.poll(host, body, disconnect(request));
  });
  app.post("/api/agent/reply", { bodyLimit: 16 * 1024 * 1024 }, (request) => {
    const host = hostOf(request);
    const body = z
      .object({ id: z.string().max(64), result: z.unknown() })
      .strict()
      .parse(request.body ?? {});
    return remote.reply(host, body.id, body.result);
  });
  app.post("/api/agent/log", (request) => {
    const host = hostOf(request);
    const body = z
      .object({
        task: id,
        run: id,
        offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        data: z.string().max(1024 * 1024),
      })
      .strict()
      .parse(request.body ?? {});
    return remote.log(host, body);
  });
  app.post("/api/agent/quota", { bodyLimit: 256 * 1024 }, (request) => {
    const host = hostOf(request);
    const body = z
      .object({ readings: z.array(reading).max(20) })
      .strict()
      .parse(request.body ?? {});
    return remote.quota(host, body);
  });
  // 退出上报可能带回改过的技能副本（t232，每个至多 256 KB、至多 LIMITS.perTask 个的若干轮）。
  app.post("/api/agent/exit", { bodyLimit: 8 * 1024 * 1024 }, (request) => {
    const host = hostOf(request);
    const body = z
      .object({
        task: id,
        run: id,
        exit: z
          .object({
            code: z.number().int().nullable(),
            signal: z.string().max(20).nullable(),
          })
          .nullable(),
        size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        last_message: z
          .string()
          .max(512 * 1024)
          .optional(),
        skills: skillReport.optional(),
      })
      .strict()
      .parse(request.body ?? {});
    return remote.exit(host, body);
  });
}
