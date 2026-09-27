import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import {
  startPatrol,
  reportFinding,
  decideFinding,
  findingsForNode,
} from "./patrol.ts";
import { nodeByAddress } from "../org/model.ts";
import { Problem } from "../problem.ts";
import type { TaskRunner } from "./runner.ts";

export function registerPatrolRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  runner: TaskRunner,
) {
  app.post(
    "/api/patrol/nodes/:id/run",
    { bodyLimit: 1024 },
    async (request, reply) => {
      const address = (request.params as { id: string }).id;
      const body = (request.body ?? {}) as Record<string, unknown>;
      if (
        Object.keys(body).some((key) => key !== "worker") ||
        (body.worker !== undefined && typeof body.worker !== "string")
      )
        throw new Problem(400, "worker: 应为执行者组合", "usage");
      const started = startPatrol(db, address);
      const launched = await runner.run(started.task.ref, {
        worker: body.worker,
      });
      return reply.code(201).send({ ...started, ...launched });
    },
  );
  app.post(
    "/api/patrol/tasks/:id/findings",
    { bodyLimit: 8 * 1024 },
    (request, reply) =>
      reply
        .code(201)
        .send(
          reportFinding(
            db,
            (request.params as { id: string }).id,
            request.body,
          ),
        ),
  );
  app.get("/api/patrol/nodes/:id/findings", (request) =>
    findingsForNode(
      db,
      nodeByAddress(db, (request.params as { id: string }).id).id,
    ),
  );
  app.post(
    "/api/patrol/findings/:id/decide",
    { bodyLimit: 4 * 1024 },
    (request) =>
      decideFinding(db, (request.params as { id: string }).id, request.body),
  );
}
