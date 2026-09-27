import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import type { Store } from "../store.ts";
import { resolveActor } from "../users.ts";
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
export function registerOrgRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  store: Store,
) {
  ensureOrgTables(db);
  const actor = (query: unknown) => {
    const value = resolveActor(store, q(query).as);
    return value === "u1" ? value : store.agentRef(value);
  };
  const checkedLeader = (input: Record<string, unknown>) => {
    if (input.leader === "none" || input.leader === "无")
      return { ...input, leader: null };
    if (typeof input.leader === "string" && input.leader !== "u1") {
      const id = store.resolveAgentId(input.leader);
      return { ...input, leader: store.agentRef(id) };
    }
    return input;
  };
  app.get("/api/org/tree", () => tree(db));
  app.get("/api/org/nodes/:id", (request) =>
    show(
      db,
      p(request.params).id,
      q(request.query).raw === undefined
        ? undefined
        : doc(q(request.query).raw),
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
      const parsed =
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
  app.post("/api/org/import", { bodyLimit: 128 * 1024 }, (request) =>
    importOrg(db, body(request.body) as ImportInput, actor(request.query)),
  );
}
