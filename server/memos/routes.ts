import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { leaderRef, requireLeader, showLeader } from "../leaders/model.ts";
import {
  addDecision,
  listDecisions,
  parseLimit,
  PAGE_MAX,
  supersedeDecision,
} from "./decisions.ts";
import {
  ensureMemoTables,
  MEMO_MAX,
  memoText,
  readMemo,
  writeMemo,
} from "./store.ts";

/**
 * 备忘与决定记录的接口（atrium memo …、atrium decision …）。记录的主人由 `?as=` 指定：
 * secretary（缺省）或已登记的 aN。leader 令牌下 guard.ts 已把 `?as=` 锁成自己，
 * 所以 leader 只能读写自己的；用户令牌（秘书与用户本人）可以读写任何一位的。
 */

export const SECRETARY = "secretary";

/** 记录的主人：不给是秘书；aN 须已登记。 */
export function ownerOf(db: DatabaseSync, value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text === SECRETARY) return SECRETARY;
  if (!/^a/.test(text))
    throw new Problem(
      400,
      "--as: 应为 secretary 或 leader 短号 aN",
      "usage",
      undefined,
      "atrium leader ls",
    );
  return leaderRef(requireLeader(db, text).id);
}

/** 一位的全貌：名称、备忘、有效的决定（新的在前）；秘书开新会话、网页详情页都用它。 */
export function memoView(db: DatabaseSync, owner: string, all = false) {
  const memo = readMemo(db, owner);
  const leader = owner === SECRETARY ? null : showLeader(db, owner);
  const { owner: _, ...decisions } = listDecisions(db, owner, {
    all,
    limit: PAGE_MAX,
  });
  return {
    owner,
    name: leader?.name ?? "秘书",
    kind: leader ? ("leader" as const) : ("secretary" as const),
    worker: leader?.worker ?? null,
    nodes: leader?.nodes ?? [],
    wake: leader?.wake ?? null,
    memo: memo.body,
    memo_max: MEMO_MAX,
    memo_updated_at: memo.updated_at,
    ...decisions,
  };
}

type Q = Record<string, string | undefined>;
const q = (value: unknown) => (value ?? {}) as Q;

export function registerMemoRoutes(app: FastifyInstance, db: DatabaseSync) {
  ensureMemoTables(db);
  app.get("/api/memo", (request) =>
    memoView(db, ownerOf(db, q(request.query).as)),
  );
  app.put("/api/memo", { bodyLimit: 32 * 1024 }, (request) => {
    const owner = ownerOf(db, q(request.query).as);
    const body = request.body as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Problem(400, "请求体应为对象", "usage");
    for (const key of Object.keys(body))
      if (key !== "memo") throw new Problem(400, `${key}: 是未知字段`, "usage");
    writeMemo(db, owner, memoText(body.memo, `atrium memo show --as ${owner}`));
    return memoView(db, owner);
  });
  app.get("/api/decisions", (request) => {
    const query = q(request.query);
    return listDecisions(db, ownerOf(db, query.as), {
      all: query.all === "1" || query.all === "true",
      before: query.before,
      limit: parseLimit(query.limit),
    });
  });
  app.post("/api/decisions", { bodyLimit: 16 * 1024 }, (request, reply) =>
    reply
      .code(201)
      .send(addDecision(db, ownerOf(db, q(request.query).as), request.body)),
  );
  app.post("/api/decisions/:id/supersede", { bodyLimit: 1024 }, (request) =>
    supersedeDecision(
      db,
      ownerOf(db, q(request.query).as),
      (request.params as { id: string }).id,
      request.body,
    ),
  );
}
