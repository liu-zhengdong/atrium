import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { resolveActor } from "../actor.ts";
import { Problem } from "../problem.ts";
import { ensureOrgTables } from "./schema.ts";
import { history, show, tree } from "./read.ts";
import {
  addNode,
  editDoc,
  editNode,
  editStages,
  importOrg,
  revertDoc,
  type AddInput,
  type ImportInput,
} from "./write.ts";
import type { Doc } from "./model.ts";
import { parseDocument } from "./validate.ts";
import { readPace } from "../tasks/prepare.ts";
import { addPoint, editPoint, removePoint } from "./points.ts";
import { isRegistered } from "../leaders/model.ts";
import { actsForUser } from "../../shared/user.ts";

type Query = {
  as?: string;
  raw?: string;
  before?: string;
  after?: string;
  rev?: string;
  target?: string;
  limit?: string;
};
const q = (value: unknown) => (value ?? {}) as Query;
const p = (value: unknown) => (value ?? {}) as { id: string };
const body = (value: unknown) => (value ?? {}) as Record<string, unknown>;
const doc = (value: unknown): Doc => {
  if (value !== "charter") throw new Problem(400, "doc 只能是 charter");
  return value;
};
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
  app.get("/api/org/tree", async () => tree(db, await readPace()));
  app.get("/api/org/nodes/:id", async (request) =>
    show(
      db,
      p(request.params).id,
      q(request.query).raw === undefined
        ? undefined
        : doc(q(request.query).raw),
      await readPace(),
    ),
  );
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
              "关注点节点已下线；请用 atrium specialist add 创建专员",
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
  app.put(
    "/api/org/nodes/:id/docs/:doc",
    { bodyLimit: 64 * 1024 },
    (request) => {
      const input = body(request.body),
        target = doc((request.params as { doc: string }).doc);
      const parsed: {
        fields?: unknown;
        body?: unknown;
        boundaries?: unknown;
      } =
        typeof input.source === "string"
          ? parseDocument(input.source, target)
          : input;
      return editDoc(
        db,
        p(request.params).id,
        target,
        {
          fields: parsed.fields,
          body: parsed.body,
          boundaries: parsed.boundaries,
          rev: input.rev as string | undefined,
          reason: input.reason,
        },
        actor(request.query),
      );
    },
  );
  app.post("/api/org/nodes/:id/revert", { bodyLimit: 8 * 1024 }, (request) => {
    const input = body(request.body);
    return revertDoc(
      db,
      p(request.params).id,
      doc(input.doc),
      String(input.to ?? ""),
      String(input.reason ?? ""),
      actor(request.query),
    );
  });
  // 阶段记录：只改章程的 stages，其余不动（leader 可改本节点及子节点的阶段）。
  app.put("/api/org/nodes/:id/stages", { bodyLimit: 64 * 1024 }, (request) => {
    const input = body(request.body);
    for (const key of Object.keys(input))
      if (key !== "stages" && key !== "reason")
        throw new Problem(400, `${key}: 是未知字段`);
    return editStages(
      db,
      p(request.params).id,
      input.stages,
      input.reason,
      actor(request.query),
    );
  });
  // 要点（#322）：不留修订记录，权限同章程（leader 链；根只有 u1）。
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
  // 最多 200 份各 16 KB 的岗位正文，另留请求字段与根章程空间。
  app.post("/api/org/import", { bodyLimit: 4 * 1024 * 1024 }, (request) =>
    importOrg(db, body(request.body) as ImportInput, actor(request.query)),
  );
}
