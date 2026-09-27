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
  importOrg,
  revertDoc,
  type AddInput,
  type ImportInput,
} from "./write.ts";
import type { Doc } from "./model.ts";
import { parseDocument } from "./validate.ts";
import { linkRoles } from "./task-link.ts";
import { readPace } from "../tasks/prepare.ts";
import { addPoint, editPoint, removePoint } from "./points.ts";

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
  if (value !== "charter" && value !== "card")
    throw new Problem(400, "doc 只能是 charter 或 card");
  return value;
};
export function registerOrgRoutes(app: FastifyInstance, db: DatabaseSync) {
  ensureOrgTables(db);
  const actor = (query: unknown) => resolveActor(db, q(query).as);
  // leader 只收短号（u1 或 aN），格式由 write.ts 校验；none／无 表示清空。
  const checkedLeader = (input: Record<string, unknown>) =>
    input.leader === "none" || input.leader === "无"
      ? { ...input, leader: null }
      : typeof input.leader === "string"
        ? { ...input, leader: input.leader.trim() }
        : input;
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
    reply
      .code(201)
      .send(
        addNode(
          db,
          checkedLeader(body(request.body)) as AddInput,
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
        budget?: unknown;
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
          budget: parsed.budget,
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
  // 旧 role 字符串回填 node_id：默认预览，apply 只有你能执行。
  app.post("/api/org/link-roles", { bodyLimit: 1024 }, (request) => {
    const apply = body(request.body).apply === true;
    if (apply && actor(request.query) !== "u1")
      throw new Problem(403, "org link-roles --apply 只有你能执行");
    return linkRoles(db, apply);
  });
  // 最多 200 份各 16 KB 的岗位正文，另留请求字段与根章程空间。
  app.post("/api/org/import", { bodyLimit: 4 * 1024 * 1024 }, (request) =>
    importOrg(db, body(request.body) as ImportInput, actor(request.query)),
  );
}
