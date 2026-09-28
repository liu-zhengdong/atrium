import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import {
  listSchedules,
  parseScheduleRef,
  pauseSchedule,
  removeSchedule,
  showSchedule,
} from "./model.ts";
import type { SchedulePump } from "./runtime.ts";

type Query = { node?: string; all?: string; after?: string; limit?: string };

const id = (params: unknown) => (params as { id: string }).id;

/** 周期任务（#404 第 1 步）：用户与负责该节点或其上级的 leader 可写（leader 范围由 leaders/guard.ts 判）。 */
export function registerScheduleRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  pump: SchedulePump,
) {
  app.post("/api/schedules", { bodyLimit: 256 * 1024 }, (request, reply) =>
    reply.code(201).send(showSchedule(db, `s${pump.add(request.body)}`)),
  );
  app.get("/api/schedules", (request) => {
    const q = (request.query ?? {}) as Query;
    const limit = q.limit === undefined ? undefined : Number(q.limit);
    if (limit !== undefined && !(Number.isInteger(limit) && limit > 0))
      throw new Problem(400, "limit: 应为正整数", "usage");
    return listSchedules(db, {
      node: q.node || undefined,
      all: q.all === "1" || q.all === "true",
      after: q.after ? parseScheduleRef(q.after) : 0,
      limit,
    });
  });
  app.get("/api/schedules/:id", (request) =>
    showSchedule(db, id(request.params)),
  );
  app.post("/api/schedules/:id/pause", { bodyLimit: 1024 }, (request) =>
    showSchedule(db, `s${pauseSchedule(db, id(request.params))}`),
  );
  app.post("/api/schedules/:id/resume", { bodyLimit: 1024 }, (request) =>
    showSchedule(db, `s${pump.resume(id(request.params))}`),
  );
  app.post(
    "/api/schedules/:id/run",
    { bodyLimit: 1024 },
    async (request, reply) =>
      reply.code(201).send(await pump.runNow(id(request.params))),
  );
  app.delete("/api/schedules/:id", (request) =>
    showSchedule(db, `s${removeSchedule(db, id(request.params))}`),
  );
}
