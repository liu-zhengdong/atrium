import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { nodeByAddress, nodes } from "../org/model.ts";
import { leaderOf } from "../leaders/guard.ts";
import { parseTaskRef } from "../tasks/ledger-model.ts";
import { MATERIAL_MAX_BYTES, noteOf, validateUpload } from "./model.ts";
import {
  addMaterial,
  ensureMaterialTables,
  listMaterials,
  openMaterial,
  purgeMaterials,
  readMaterialFile,
  removeMaterial,
  setMaterialState,
  showMaterial,
  staleMaterials,
} from "./store.ts";

/**
 * 资料接口（atrium material …）。加、归档、恢复、留下：用户令牌，或 leader 在自己负责的部门里
 * （leaders/scope.ts 登记、guard.ts 按节点判）；取资料谁都能取，读者记成 aN、任务 tN 或秘书；
 * 真删只认用户令牌（leader 规则表不登记，默认拒绝）。
 */

type Q = Record<string, string | undefined>;
const q = (request: FastifyRequest) => (request.query ?? {}) as Q;
const idOf = (request: FastifyRequest) => (request.params as { id: string }).id;
const who = (request: FastifyRequest) => leaderOf(request) ?? "secretary";

function small(body: unknown, keys: readonly string[]) {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body))
    throw new Problem(400, "请求体应为对象", "usage");
  for (const key of Object.keys(body))
    if (!keys.includes(key))
      throw new Problem(400, `${key}: 是未知字段`, "usage");
  return body as Record<string, unknown>;
}

/** 这一块及其全部下层的节点 id。 */
function subtree(db: DatabaseSync, address: string) {
  const list = nodes(db);
  const ids = new Set([nodeByAddress(db, address).id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const n of list)
      if (n.parent_id !== null && ids.has(n.parent_id) && !ids.has(n.id)) {
        ids.add(n.id);
        grew = true;
      }
  }
  return [...ids];
}

export function registerMaterialRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  data: string,
) {
  ensureMaterialTables(db);
  app.get("/api/materials", (request) => {
    const query = q(request);
    return listMaterials(db, {
      node: query.node,
      archived: query.archived === "1" || query.archived === "true",
      before: query.before,
      limit: query.limit,
    });
  });
  app.get("/api/materials/stale", (request) => {
    const node = q(request).node;
    const ids = node ? subtree(db, node) : null;
    return {
      node: node ?? null,
      stale: staleMaterials(db, ids).map(({ hinted_at: _hinted, ...m }) => m),
      // 真删要用户点头：只在看全部时列。
      purge: node ? [] : purgeMaterials(db, Date.now(), true),
    };
  });
  app.get("/api/materials/:id", (request) => showMaterial(db, idOf(request)));
  // base64 比原文大三分之一，再留些余量给文件名与字段。
  app.post(
    "/api/materials",
    { bodyLimit: Math.ceil((MATERIAL_MAX_BYTES * 4) / 3) + 1024 * 1024 },
    (request, reply) =>
      reply
        .code(201)
        .send(
          addMaterial(db, data, validateUpload(request.body), who(request)),
        ),
  );
  app.post("/api/materials/:id/get", { bodyLimit: 1024 }, (request) => {
    const body = small(request.body, ["version", "task"]);
    let task: number | null = null;
    if (typeof body.task === "string" && body.task.trim())
      task = parseTaskRef(body.task, "ATRIUM_TASK");
    return openMaterial(db, idOf(request), {
      version: body.version,
      reader: who(request),
      task,
    });
  });
  app.get("/api/materials/:id/files", (request) => {
    const query = q(request);
    return readMaterialFile(db, data, idOf(request), query.version, query.path);
  });
  for (const action of ["archive", "restore", "keep"] as const)
    app.post(`/api/materials/:id/${action}`, { bodyLimit: 4096 }, (request) => {
      const body = small(request.body, ["note"]);
      return setMaterialState(
        db,
        idOf(request),
        action,
        noteOf(body.note, "--note"),
        who(request),
      );
    });
  app.delete("/api/materials/:id", (request) =>
    removeMaterial(db, data, idOf(request)),
  );
}
