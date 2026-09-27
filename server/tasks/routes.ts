import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { ackIds, waitSeconds } from "./events.ts";
import {
  DEFAULT_OWNER,
  addTaskNote,
  createTask,
  ensureTaskTables,
  getTask,
  listTasks,
  ownerOf,
  taskTree,
  updateTask,
} from "./ledger.ts";
import { TaskRunner, type RunnerOptions } from "./runner.ts";
import { taskPlan } from "./schedule.ts";
import { parseTaskRef } from "./ledger.ts";

type Query = Record<string, string | undefined>;
const params = (value: unknown) => (value ?? {}) as { id?: string };
const query = (value: unknown) => (value ?? {}) as Query;
/** 调用方以谁的名义（?as=），缺省 secretary。 */
const actorOf = (q: Query) =>
  q.as === undefined || q.as === "" ? DEFAULT_OWNER : ownerOf(q.as, "as");

/** 客户端断开时中止长轮询。 */
function disconnect(request: FastifyRequest) {
  const controller = new AbortController();
  request.raw.once("close", () => controller.abort());
  return controller.signal;
}

/** 数值配置从环境读：ATRIUM_WORKERS_DIR、ATRIUM_EVENT_BATCH_SECONDS、ATRIUM_EVENT_LEASE_MINUTES。 */
export function runnerEnvOptions(env: NodeJS.ProcessEnv = process.env) {
  const options: Partial<RunnerOptions> = {};
  if (env.ATRIUM_WORKERS_DIR) options.workersDir = env.ATRIUM_WORKERS_DIR;
  const batch = Number(env.ATRIUM_EVENT_BATCH_SECONDS);
  if (Number.isFinite(batch) && batch > 0) options.batchMs = batch * 1000;
  const lease = Number(env.ATRIUM_EVENT_LEASE_MINUTES);
  if (Number.isFinite(lease) && lease > 0) options.leaseMs = lease * 60_000;
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
  runnerOptions: RunnerOptions,
) {
  ensureTaskTables(db);
  const runner = new TaskRunner(db, runnerOptions);
  runner.start();
  app.addHook("preClose", async () => runner.close());
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
  // 静态路径要排在 :id 前面，别让 top 被当成任务短号。
  app.get("/api/tasks/top", (request) =>
    runner.top({ as: query(request.query).as }),
  );
  app.get("/api/tasks/plan", (request) => {
    const q = query(request.query);
    return taskPlan(
      db,
      q.after ? parseTaskRef(q.after, "after") : 0,
      q.limit ? Number(q.limit) : 200,
    );
  });
  app.get("/api/tasks/:id", (request) =>
    getTask(db, params(request.params).id),
  );
  app.patch("/api/tasks/:id", { bodyLimit: 64 * 1024 }, (request) =>
    updateTask(db, params(request.params).id, request.body),
  );
  app.post("/api/tasks/:id/note", { bodyLimit: 4 * 1024 }, (request) =>
    addTaskNote(db, params(request.params).id, request.body),
  );
  app.post("/api/tasks/:id/run", { bodyLimit: 16 * 1024 }, (request) =>
    runner.run(params(request.params).id, request.body),
  );
  app.post("/api/tasks/:id/stop", (request) =>
    runner.stop(params(request.params).id, actorOf(query(request.query))),
  );
  app.get("/api/tasks/:id/log", (request) =>
    runner.log(params(request.params).id, query(request.query).after),
  );
  app.get("/api/tasks/:id/wait", (request) =>
    runner.wait(
      params(request.params).id,
      waitSeconds(query(request.query).timeout),
      disconnect(request),
    ),
  );
  app.get("/api/events/wait", (request) => {
    const q = query(request.query);
    return runner.inbox.wait(
      actorOf(q),
      waitSeconds(q.timeout),
      disconnect(request),
    );
  });
  app.post("/api/events/ack", { bodyLimit: 64 * 1024 }, (request) =>
    runner.inbox.ack(ackIds(request.body)),
  );
  return runner;
}
