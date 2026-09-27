import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { resolveActor } from "../actor.ts";
import { Problem } from "../problem.ts";
import { ensureGoalTables } from "./schema.ts";
import { goalShow, goalTree } from "./read.ts";
import { addGoal, editGoal, settleGoal } from "./write.ts";
import { adoptTask } from "./adopt.ts";
import { judgeItem } from "./checks.ts";
import { GoalChecker, type GoalCheckOptions } from "./check-runtime.ts";
import { objectOf } from "../tasks/ledger-validate.ts";

type Query = { as?: string; root?: string; ids?: string; timeout?: string };
const q = (value: unknown) => (value ?? {}) as Query;
const p = (value: unknown) => (value ?? {}) as { id: string };

/**
 * 目标树的 HTTP 入口（#313）。走默认用户认证；以谁的名义操作看 ?as=（u1 或组织节点 leader aN），
 * 权限判定在 rules.ts，字段校验在 write.ts。
 */
export function registerGoalRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  checks: GoalCheckOptions,
) {
  ensureGoalTables(db);
  const checker = new GoalChecker(db, checks);
  app.addHook("onClose", async () => checker.close());
  const actor = (query: unknown) => resolveActor(db, q(query).as);
  app.get("/api/goals/tree", (request) => goalTree(db, q(request.query).root));
  app.get("/api/goals/:id", (request) => goalShow(db, p(request.params).id));
  app.post("/api/goals", { bodyLimit: 64 * 1024 }, (request, reply) =>
    reply.code(201).send(addGoal(db, request.body, actor(request.query))),
  );
  app.patch("/api/goals/:id", { bodyLimit: 64 * 1024 }, (request) =>
    editGoal(db, p(request.params).id, request.body, actor(request.query)),
  );
  app.post("/api/goals/:id/done", { bodyLimit: 8 * 1024 }, (request) =>
    settleGoal(
      db,
      p(request.params).id,
      { kind: "done" },
      request.body,
      actor(request.query),
    ),
  );
  app.post("/api/goals/:id/drop", { bodyLimit: 8 * 1024 }, (request) =>
    settleGoal(
      db,
      p(request.params).id,
      { kind: "drop" },
      request.body,
      actor(request.query),
    ),
  );
  // 达成判定（#313 第 2 步）：给 verdict 是人工判定，否则跑命令条目（异步），再用 check-wait 等结果。
  app.post("/api/goals/:id/check", { bodyLimit: 8 * 1024 }, (request) => {
    const body = objectOf(request.body ?? {});
    const who = actor(request.query);
    if (body.verdict !== undefined)
      return { checks: [judgeItem(db, p(request.params).id, body, who)] };
    const extra = Object.keys(body).filter((key) => key !== "item");
    if (extra.length)
      throw new Problem(400, `不认识的字段：${extra.join("、")}`, "usage");
    return checker.start(p(request.params).id, body.item, who);
  });
  app.get("/api/goals/:id/check-wait", (request) => {
    const query = q(request.query);
    const seconds = Number(query.timeout ?? 0);
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 240)
      throw new Problem(400, "timeout: 应为 0～240 的整数秒", "usage");
    const abort = new AbortController();
    request.raw.once("close", () => abort.abort());
    return checker.wait(p(request.params).id, query.ids, seconds, abort.signal);
  });
  // 父任务迁为里程碑：默认预览，apply 才写。
  app.post("/api/goals/adopt", { bodyLimit: 4 * 1024 }, (request) =>
    adoptTask(db, request.body, actor(request.query)),
  );
}
