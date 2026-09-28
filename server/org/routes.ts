import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { resolveActor } from "../actor.ts";
import { Problem } from "../problem.ts";
import { ensureOrgTables } from "./schema.ts";
import { history, show, tree } from "./read.ts";
import { addNode, editNode, type AddInput } from "./write.ts";
import { addPoint, editPoint, removePoint } from "./points.ts";
import { readLimits, writeLimits } from "./limits.ts";
import { isRegistered } from "../leaders/model.ts";

type Query = {
  as?: string;
  before?: string;
  after?: string;
  rev?: string;
  limit?: string;
};
const q = (value: unknown) => (value ?? {}) as Query;
const p = (value: unknown) => (value ?? {}) as { id: string };
const body = (value: unknown) => (value ?? {}) as Record<string, unknown>;
export function registerOrgRoutes(app: FastifyInstance, db: DatabaseSync) {
  ensureOrgTables(db);
  const actor = (query: unknown) => resolveActor(db, q(query).as);
  // leader 只收短号（u1 或 aN），格式由 write.ts 校验；none／无 表示清空。
  // 指派 aN 须先登记（atrium leader add），免得事件投给一个不会被唤醒的身份。
  const checkedLeader = (input: Record<string, unknown>) => {
    const leader =
      typeof input.leader === "string" ? input.leader.trim() : input.leader;
    if (
      typeof leader === "string" &&
      /^a[1-9][0-9]*$/.test(leader) &&
      !isRegistered(db, leader)
    )
      throw new Problem(
        404,
        `--leader: ${leader} 没有登记为 leader`,
        "not_found",
        undefined,
        `atrium leader add 名称 --worker claude+opus --id ${leader}`,
      );
    return leader === "none" || leader === "无"
      ? { ...input, leader: null }
      : typeof leader === "string"
        ? { ...input, leader }
        : input;
  };
  app.get("/api/org/tree", () => tree(db));
  app.get("/api/org/nodes/:id", (request) => show(db, p(request.params).id));
  app.get("/api/org/nodes/:id/history", (request) => {
    const query = q(request.query);
    return history(db, p(request.params).id, {
      ...query,
      limit: query.limit === undefined ? undefined : Number(query.limit),
    });
  });
  app.post("/api/org/nodes", { bodyLimit: 64 * 1024 }, (request, reply) =>
    reply.code(201).send(
      addNode(
        db,
        (() => {
          const input = checkedLeader(body(request.body));
          if (input.kind === "concern")
            throw new Problem(
              400,
              "关注点节点已下线；规矩写成要点，放在它们共同的上级",
              "usage",
            );
          return input as AddInput;
        })(),
        actor(request.query),
      ),
    ),
  );
  app.patch("/api/org/nodes/:id", { bodyLimit: 64 * 1024 }, (request) =>
    editNode(
      db,
      p(request.params).id,
      checkedLeader(body(request.body)) as Parameters<typeof editNode>[2],
      actor(request.query),
    ),
  );
  // 要点：不留修订记录（leader 链；根只有 u1）。
  app.post(
    "/api/org/nodes/:id/points",
    { bodyLimit: 8 * 1024 },
    (request, reply) =>
      reply
        .code(201)
        .send(
          addPoint(
            db,
            p(request.params).id,
            request.body,
            actor(request.query),
          ),
        ),
  );
  app.patch("/api/org/points/:id", { bodyLimit: 8 * 1024 }, (request) =>
    editPoint(db, p(request.params).id, request.body, actor(request.query)),
  );
  app.delete("/api/org/points/:id", (request) =>
    removePoint(db, p(request.params).id, actor(request.query)),
  );
  // 根节点的两项配置：给你留的额度、花费上限（只有用户能改）。
  app.get("/api/org/limits", () => readLimits(db));
  app.put("/api/org/limits", { bodyLimit: 1024 }, (request) =>
    writeLimits(db, request.body, actor(request.query)),
  );
}
