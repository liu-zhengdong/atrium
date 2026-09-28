import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { leaderOf } from "../leaders/guard.ts";
import { noteOf } from "../materials/model.ts";
import { secretValue } from "./model.ts";
import {
  ensureSecretTables,
  listSecrets,
  removeSecret,
  setSecret,
  setSecretState,
} from "./store.ts";

/**
 * 凭据接口（atrium secret …）。设值、归档、恢复、留下：用户令牌，或 leader 在自己负责的部分里
 * （leaders/scope.ts 登记、guard.ts 按 body.node 判）；真删只认用户令牌。
 * 没有读值的接口：值只在派活那一刻由运行时读出注入执行者，回执、列表、报错都不带值。
 */

type Q = Record<string, string | undefined>;
const q = (request: FastifyRequest) => (request.query ?? {}) as Q;
const who = (request: FastifyRequest) => leaderOf(request) ?? "secretary";

function bodyOf(body: unknown, keys: readonly string[]) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Problem(400, "请求体应为对象", "usage");
  for (const key of Object.keys(body))
    if (!keys.includes(key))
      throw new Problem(400, `${key}: 是未知字段`, "usage");
  return body as Record<string, unknown> & { node?: unknown; name?: unknown };
}

export function registerSecretRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  data: string,
) {
  ensureSecretTables(db);
  app.get("/api/secrets", (request) => {
    const query = q(request);
    return listSecrets(db, {
      node: query.node,
      archived: query.archived === "1" || query.archived === "true",
      before: query.before,
      limit: query.limit,
    });
  });
  app.put("/api/secrets", { bodyLimit: 64 * 1024 }, (request) => {
    const body = bodyOf(request.body, ["node", "name", "value"]);
    if (typeof body.node !== "string" || !body.node.trim())
      throw new Problem(400, "节点: 要挂在哪个节点上，如 o4", "usage");
    return setSecret(
      db,
      data,
      {
        node: body.node.trim(),
        name: typeof body.name === "string" ? body.name : "",
        value: secretValue(body.value),
      },
      who(request),
    );
  });
  for (const action of ["archive", "restore", "keep"] as const)
    app.post(`/api/secrets/${action}`, { bodyLimit: 4096 }, (request) => {
      const body = bodyOf(request.body, ["node", "name", "note"]);
      return setSecretState(
        db,
        body,
        action,
        noteOf(body.note, "--note"),
        who(request),
      );
    });
  app.delete("/api/secrets", { bodyLimit: 4096 }, (request) =>
    removeSecret(db, data, bodyOf(request.body, ["node", "name"])),
  );
}
