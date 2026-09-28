import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { resolveActor } from "../actor.ts";
import { leaderOf } from "../leaders/guard.ts";
import type { TaskRunner } from "../tasks/runner.ts";
import { startPlan } from "./runtime.ts";
import {
  adoptPlan,
  ensurePlanTables,
  planInput,
  rejectPlan,
  showPlan,
} from "./store.ts";

/**
 * 规划任务（atrium task plan-for / adopt-plan / reject-plan，t275）。leader 令牌只能动负责范围里的
 * 总任务与规划（scope.ts 的 plan 规则），采纳建的子任务记「谁派的」是这位 leader。
 */
export function registerPlanRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  runner: TaskRunner,
) {
  ensurePlanTables(db);
  const id = (request: FastifyRequest) => (request.params as { id: string }).id;
  const actor = (request: FastifyRequest) =>
    leaderOf(request) ??
    resolveActor(db, (request.query as { as?: string } | undefined)?.as);
  app.post(
    "/api/tasks/:id/plan",
    { bodyLimit: 4 * 1024 },
    async (request, reply) => {
      const input = planInput(request.body);
      return reply.code(201).send(
        await startPlan(db, runner, id(request), {
          worker: input.worker,
          by: leaderOf(request),
        }),
      );
    },
  );
  app.get("/api/plans/:id", (request) => showPlan(db, id(request)));
  app.post("/api/plans/:id/adopt", { bodyLimit: 128 * 1024 }, (request) =>
    adoptPlan(db, id(request), request.body, actor(request), leaderOf(request)),
  );
  app.post("/api/plans/:id/reject", { bodyLimit: 8 * 1024 }, (request) =>
    rejectPlan(db, id(request), request.body, actor(request)),
  );
}
