import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import {
  createTask,
  ensureTaskTables,
  getTask,
  listTasks,
  taskTree,
  updateTask,
} from "./ledger.ts";

type Query = Record<string, string | undefined>;
const params = (value: unknown) => (value ?? {}) as { id?: string };
const query = (value: unknown) => (value ?? {}) as Query;

/**
 * 任务账本的 HTTP 入口（#262）。走默认的用户认证（auth-policy 未列出即要求用户凭据）；
 * 字段校验全部在 ledger.ts 的领域函数里，这里只转交。
 */
export function registerTaskRoutes(app: FastifyInstance, db: DatabaseSync) {
  ensureTaskTables(db);
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
}
