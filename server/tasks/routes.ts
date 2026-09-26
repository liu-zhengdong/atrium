import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { ackIds, waitSeconds } from "./events.ts";
import {
  DEFAULT_OWNER,
  createTask,
  ensureTaskTables,
  getTask,
  listTasks,
  ownerOf,
  taskTree,
  updateTask,
} from "./ledger.ts";
import { TaskRunner, type RunnerOptions } from "./runner.ts";

type Query = Record<string, string | undefined>;
const params = (value: unknown) => (value ?? {}) as { id?: string };
const query = (value: unknown) => (value ?? {}) as Query;

/** 客户端断开时中止长轮询。 */
function disconnect(request: FastifyRequest) {
  const controller = new AbortController();
  request.raw.once("close", () => controller.abort());
  return controller.signal;
}

/** 数值配置从环境读：ATRIUM_WORKERS_DIR、ATRIUM_EVENT_BATCH_SECONDS。 */
export function runnerEnvOptions(env: NodeJS.ProcessEnv = process.env) {
  const options: Partial<RunnerOptions> = {};
  if (env.ATRIUM_WORKERS_DIR) options.workersDir = env.ATRIUM_WORKERS_DIR;
  const batch = Number(env.ATRIUM_EVENT_BATCH_SECONDS);
  if (Number.isFinite(batch) && batch > 0) options.batchMs = batch * 1000;
  const unknown = Number(env.ATRIUM_QUOTA_UNKNOWN_MINUTES);
  if (Number.isFinite(unknown) && unknown > 0)
    options.quotaUnknownMs = unknown * 60_000;
  return options;
}

/**
 * 任务账本、派活与事件投递的 HTTP 入口（#262）。走默认的用户认证（auth-policy 未列出即要求用户凭据）；
 * 字段校验在领域模块里，这里只转交。
 */
export function registerTaskRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  runnerOptions?: RunnerOptions,
) {
  ensureTaskTables(db);
  const runner = runnerOptions ? new TaskRunner(db, runnerOptions) : undefined;
  const requireRunner = () => {
    if (!runner) throw new Problem(503, "任务运行时未启用");
    return runner;
  };
  if (runner) {
    runner.start();
    app.addHook("preClose", async () => runner.close());
  }
  app.post("/api/tasks", { bodyLimit: 64 * 1024 }, async (request, reply) => {
    const task = createTask(db, request.body);
    return reply.code(201).send(task);
  });
  app.get("/api/tasks", (request) => {
    const { parent, status, after, limit } = query(request.query);
    return listTasks(db, { parent, status, after, limit });
  });
  app.get("/api/tasks/tree", (request) =>
    taskTree(db, query(request.query).root),
  );
  app.get("/api/tasks/:id", (request) =>
    getTask(db, params(request.params).id),
  );
  app.patch("/api/tasks/:id", { bodyLimit: 64 * 1024 }, (request) =>
    updateTask(db, params(request.params).id, request.body),
  );
  app.post("/api/tasks/:id/run", { bodyLimit: 16 * 1024 }, (request) =>
    requireRunner().run(params(request.params).id, request.body),
  );
  app.post("/api/tasks/:id/stop", (request) =>
    requireRunner().stop(params(request.params).id),
  );
  app.get("/api/tasks/:id/log", (request) =>
    requireRunner().log(params(request.params).id, query(request.query).after),
  );
  app.get("/api/tasks/:id/wait", (request) =>
    requireRunner().wait(
      params(request.params).id,
      waitSeconds(query(request.query).timeout),
      disconnect(request),
    ),
  );
  app.get("/api/events/wait", (request) => {
    const q = query(request.query);
    const who =
      q.as === undefined || q.as === "" ? DEFAULT_OWNER : ownerOf(q.as, "as");
    return requireRunner().inbox.wait(
      who,
      waitSeconds(q.timeout),
      disconnect(request),
    );
  });
  app.post("/api/events/ack", { bodyLimit: 64 * 1024 }, (request) =>
    requireRunner().inbox.ack(ackIds(request.body)),
  );
  return runner;
}
