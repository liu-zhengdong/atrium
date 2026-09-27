import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { resolveActor } from "../actor.ts";
import { ensureGoalTables } from "./schema.ts";
import { goalShow, goalTree } from "./read.ts";
import { addGoal, editGoal, settleGoal } from "./write.ts";
import { adoptTask } from "./adopt.ts";

type Query = { as?: string; root?: string };
const q = (value: unknown) => (value ?? {}) as Query;
const p = (value: unknown) => (value ?? {}) as { id: string };

/**
 * 目标树的 HTTP 入口（#313）。走默认用户认证；以谁的名义操作看 ?as=（u1 或组织节点 leader aN），
 * 权限判定在 rules.ts，字段校验在 write.ts。
 */
export function registerGoalRoutes(app: FastifyInstance, db: DatabaseSync) {
  ensureGoalTables(db);
  const actor = (query: unknown) => resolveActor(db, q(query).as);
  app.get("/api/goals/tree", (request) => goalTree(db, q(request.query).root));
  app.get("/api/goals/:id", (request) => goalShow(db, p(request.params).id));
  app.post("/api/goals", { bodyLimit: 64 * 1024 }, (request, reply) =>
    reply.code(201).send(addGoal(db, request.body, actor(request.query))),
  );
  app.patch("/api/goals/:id", { bodyLimit: 64 * 1024 }, (request) =>
    editGoal(db, p(request.params).id, request.body, actor(request.query)),
  );
  app.post("/api/goals/:id/done", { bodyLimit: 8 * 1024 }, (request) =>
    settleGoal(
      db,
      p(request.params).id,
      { kind: "done" },
      request.body,
      actor(request.query),
    ),
  );
  app.post("/api/goals/:id/drop", { bodyLimit: 8 * 1024 }, (request) =>
    settleGoal(
      db,
      p(request.params).id,
      { kind: "drop" },
      request.body,
      actor(request.query),
    ),
  );
  // 父任务迁为里程碑：默认预览，apply 才写。
  app.post("/api/goals/adopt", { bodyLimit: 4 * 1024 }, (request) =>
    adoptTask(db, request.body, actor(request.query)),
  );
}
