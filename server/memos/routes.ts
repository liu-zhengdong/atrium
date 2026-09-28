import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { leaderRef, requireLeader, showLeader } from "../leaders/model.ts";
import { cloneOf, leaderOf } from "../leaders/guard.ts";
import { memoTarget } from "../leaders/clones.ts";
import { ensureMemoPartTables, readMemoParts, writeMemoTo } from "./parts.ts";
import { nodeByAddress } from "../org/model.ts";
import { LOCAL_USER } from "../../shared/user.ts";
import {
  addDecision,
  listDecisions,
  parseLimit,
  searchTerms,
  supersedeDecision,
  type DecisionScope,
} from "./decisions.ts";
import {
  markDecision,
  settleDecision,
  tagDecision,
  unsupersedeDecision,
} from "./curate.ts";
import { nodeChain, ownerDigest } from "./digest.ts";
import { ensureMemoTables, MEMO_MAX, memoText, readMemo } from "./store.ts";

/**
 * 备忘与决定记录的接口（atrium memo …、atrium decision …）。记录的主人由 `?as=` 指定：
 * secretary（缺省）、u1（用户自己那份）或已登记的 aN。leader 令牌下 guard.ts 已把 `?as=` 锁成自己，
 * 所以 leader 只能读写自己的；用户令牌（秘书与用户本人）可以读写任何一位的。
 * 整理（tag、mark、settle、unsupersede）按短号找决定，leader 令牌只能整理自己那份（curate.ts 判）。
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

/**
 * 一位的全貌：名称、备忘、决定摘要（原则 + 最近的，有字数上限，t211）；
 * 秘书开新会话、网页详情页都用它。全部的用 decision ls / search 查。
 */
export function memoView(db: DatabaseSync, owner: string) {
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
    // 多个分身同时在跑时各自写的分段（t275），只剩一个分身时合并进主备忘。
    memo_parts: readMemoParts(db, owner),
    ...ownerDigest(db, owner),
  };
}

type Q = Record<string, string | undefined>;
const q = (value: unknown) => (value ?? {}) as Q;
const flag = (value: string | undefined) => value === "1" || value === "true";

/** 列表与检索的范围：给了节点是本节点及上级（谁记的都算）；否则是 ?as= 那一份，检索缺省全部。 */
function scopeOf(
  db: DatabaseSync,
  query: Q,
  search: boolean,
): DecisionScope | null {
  if (query.node) return nodeChain(db, nodeByAddress(db, query.node).id);
  if (search && !query.owner) return null;
  return { owners: [ownerOf(db, search ? query.owner : query.as)] };
}

export function registerMemoRoutes(app: FastifyInstance, db: DatabaseSync) {
  ensureMemoTables(db);
  ensureMemoPartTables(db);
  const actor = (request: FastifyRequest) =>
    leaderOf(request) ?? ownerOf(db, q(request.query).as);
  const id = (request: FastifyRequest) => (request.params as { id: string }).id;
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
    // leader 分身（t275）：有别的分身在跑时只写自己这段，只剩自己时合并进主备忘。
    const clone = cloneOf(request);
    writeMemoTo(
      db,
      owner,
      memoText(body.memo, `atrium memo show --as ${owner}`),
      memoTarget(
        clone && {
          label: clone.clone.label,
          started: clone.clone.started,
          siblings: clone.siblings.length,
        },
      ),
    );
    return {
      ...memoView(db, owner),
      ...(clone?.siblings.length ? { written_to: clone.clone.label } : {}),
    };
  });
  app.get("/api/decisions", (request) => {
    const query = q(request.query);
    const scope = scopeOf(db, query, false);
    return {
      ...(query.node ? { node: query.node } : { owner: scope!.owners![0] }),
      ...listDecisions(db, scope, {
        all: flag(query.all),
        before: query.before,
        limit: parseLimit(query.limit),
      }),
    };
  });
  app.get("/api/decisions/search", (request) => {
    const query = q(request.query);
    const terms = searchTerms(query.q);
    return {
      query: terms.join(" "),
      ...listDecisions(db, scopeOf(db, query, true), {
        all: flag(query.all),
        before: query.before,
        limit: parseLimit(query.limit),
        terms,
      }),
    };
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
      id(request),
      request.body,
    ),
  );
  app.post("/api/decisions/:id/tag", { bodyLimit: 4 * 1024 }, (request) =>
    tagDecision(db, id(request), request.body, leaderOf(request)),
  );
  app.post("/api/decisions/:id/mark", { bodyLimit: 1024 }, (request) =>
    markDecision(db, id(request), request.body, leaderOf(request)),
  );
  app.post("/api/decisions/:id/settle", { bodyLimit: 8 * 1024 }, (request) =>
    settleDecision(
      db,
      id(request),
      request.body,
      actor(request),
      leaderOf(request),
    ),
  );
  app.post(
    "/api/decisions/:id/unsupersede",
    { bodyLimit: 4 * 1024 },
    (request) =>
      unsupersedeDecision(
        db,
        id(request),
        request.body,
        actor(request),
        leaderOf(request),
      ),
  );
}
