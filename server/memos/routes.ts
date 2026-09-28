import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { leaderRef, requireLeader, showLeader } from "../leaders/model.ts";
import { LOCAL_USER } from "../../shared/user.ts";
import {
  addDecision,
  listDecisions,
  parseLimit,
  searchTerms,
} from "./decisions.ts";
import {
  ensureMemoTables,
  MEMO_MAX,
  memoText,
  readMemo,
  writeMemo,
} from "./store.ts";

/**
 * 备忘与决定记录的接口（atrium memo …、atrium decision …）。备忘的主人由 `?as=` 指定：
 * secretary（缺省）、u1 或已登记的 aN；leader 令牌下 guard.ts 已把 `?as=` 锁成自己。
 * 决定记录只有一份（用户拍板的事），只有用户令牌能记（leader 规则表没登记，默认拒绝）。
 */

export const SECRETARY = "secretary";

/** 记录的主人：不给是秘书；u1 是用户自己那份；aN 须已登记。 */
export function ownerOf(db: DatabaseSync, value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text === SECRETARY) return SECRETARY;
  if (text === LOCAL_USER) return LOCAL_USER;
  if (!/^a/.test(text))
    throw new Problem(
      400,
      "--as: 应为 secretary、u1 或 leader 短号 aN",
      "usage",
      undefined,
      "atrium leader ls",
    );
  return leaderRef(requireLeader(db, text).id);
}

/** 一位的全貌：名称、备忘；秘书开新会话、网页详情页都用它。 */
function memoView(db: DatabaseSync, owner: string) {
  const memo = readMemo(db, owner);
  const leader =
    owner === SECRETARY || owner === LOCAL_USER ? null : showLeader(db, owner);
  return {
    owner,
    name: leader?.name ?? (owner === LOCAL_USER ? "用户" : "秘书"),
    kind: leader
      ? ("leader" as const)
      : owner === LOCAL_USER
        ? ("user" as const)
        : ("secretary" as const),
    worker: leader?.worker ?? null,
    nodes: leader?.nodes ?? [],
    wake: leader?.wake ?? null,
    memo: memo.body,
    memo_max: MEMO_MAX,
    memo_updated_at: memo.updated_at,
  };
}

type Q = Record<string, string | undefined>;
const q = (value: unknown) => (value ?? {}) as Q;
const flag = (value: string | undefined) => value === "1" || value === "true";

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
    return listDecisions(db, {
      node: query.node || undefined,
      all: flag(query.all),
      before: query.before,
      limit: parseLimit(query.limit),
      terms: searchTerms(query.q),
    });
  });
  app.post("/api/decisions", { bodyLimit: 16 * 1024 }, (request, reply) =>
    reply.code(201).send(addDecision(db, request.body)),
  );
}
