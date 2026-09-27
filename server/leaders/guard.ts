import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { nodeByAddress, nodes, ref } from "../org/model.ts";
import { matchRole } from "../org/task-node.ts";
import { partForTask } from "../org/task-part.ts";
import { getTask } from "../tasks/ledger.ts";
import { parentOf } from "../tasks/ledger-validate.ts";
import { ackIds, type EventInbox } from "../tasks/events.ts";
import { taskPartId } from "./subscriber.ts";
import { LeaderTokens } from "./tokens.ts";
import {
  ackVerdict,
  asVerdict,
  denied,
  denyReason,
  escalateVerdict,
  ESCALATE_HINT,
  leaderEditVerdict,
  leaderRule,
  mapEditVerdict,
  nodeEditVerdict,
  ownerVerdict,
  scopeOf,
  scopeVerdict,
  type ScopeCheck,
} from "./scope.ts";

/**
 * leader 令牌的服务端校验（路由匹配后的统一入口）：onRequest 认令牌、按路由判规则、锁定 ?as=；
 * preHandler 在请求体解析后按作用范围判定。判定是 scope.ts 的纯函数，这里只取事实。
 */

const leaders = new WeakMap<FastifyRequest, string>();

/** 这次请求以哪位 leader 的令牌发来；用户令牌为 undefined。 */
export const leaderOf = (request: FastifyRequest) => leaders.get(request);

const forbid = (message: string) =>
  new Problem(403, message, "leader_scope", undefined, ESCALATE_HINT);

type Body = Record<string, unknown>;
const bodyOf = (request: FastifyRequest): Body =>
  request.body &&
  typeof request.body === "object" &&
  !Array.isArray(request.body)
    ? (request.body as Body)
    : {};
const idParam = (request: FastifyRequest) =>
  String((request.params as { id?: string } | undefined)?.id ?? "");
const given = (value: unknown) =>
  value !== undefined && value !== null && value !== "";
/** 真正要改的字段：命令行会带上 archive:false 这类缺省值，不算改动。 */
const changed = (body: Body) =>
  Object.entries(body)
    .filter(
      ([key, value]) =>
        value !== undefined && !(key === "archive" && value === false),
    )
    .map(([key]) => key);

function taskCheck(db: DatabaseSync, reference: unknown, what = "任务") {
  const task = getTask(db, reference);
  return {
    what: `${what} ${task.ref}`,
    node: taskPartId(db, task),
  } satisfies ScopeCheck;
}

function nodeCheck(
  db: DatabaseSync,
  address: string,
  what: string,
): ScopeCheck {
  const node = nodeByAddress(db, address);
  return { what: `${what} ${ref(node.id)}`, node: node.id };
}

/** 建任务、改任务、发会审时 body 里的归属部分、记账节点与父任务。 */
function bodyChecks(
  db: DatabaseSync,
  body: Body,
  roleKey: "role" | "leader",
): ScopeCheck[] {
  const checks: ScopeCheck[] = [];
  if (given(body.part)) {
    const id = partForTask(db, body.part);
    checks.push({ what: `归属部分 ${ref(id!)}`, node: id });
  }
  if (given(body.goal)) {
    const id = partForTask(db, body.goal, "goal");
    checks.push({ what: `归属部分 ${ref(id!)}`, node: id });
  }
  if (given(body.from))
    checks.push(nodeCheck(db, String(body.from), "投任务的节点"));
  const role = body[roleKey];
  if (typeof role === "string" && role.trim()) {
    const node =
      roleKey === "leader"
        ? nodeByAddress(db, role.trim())
        : matchRole(
            db,
            role.trim(),
            typeof body.repo === "string" ? body.repo : null,
            true,
          ).node;
    if (node) checks.push({ what: `记账节点 ${ref(node.id)}`, node: node.id });
  }
  if (given(body.parent)) {
    const parent = parentOf(db, body.parent);
    if (parent !== null) checks.push(taskCheck(db, parent, "父任务"));
  }
  return checks;
}

export function registerLeaderGuard(
  app: FastifyInstance,
  db: DatabaseSync,
  tokens: LeaderTokens,
  inbox: () => EventInbox,
) {
  app.addHook("onRequest", async (request) => {
    const header = request.headers.authorization;
    if (!LeaderTokens.looksLike(header)) return;
    const leader = tokens.verify(header);
    if (!leader)
      throw new Problem(
        401,
        "leader 令牌无效或已过期（本次唤醒已结束）；这次唤醒没做完的事会随事件重投再唤醒你，现在直接退出",
        "leader_scope",
      );
    const route = request.routeOptions.url ?? "";
    if (!route.startsWith("/api/") || route.startsWith("/api/service"))
      throw forbid(denyReason(leader, request.method, route || request.url));
    const rule = leaderRule(request.method, route);
    if (rule === "deny")
      throw forbid(denyReason(leader, request.method, route));
    const query = (request.query ?? {}) as Record<string, string | undefined>;
    const as = asVerdict(leader, query.as);
    if (as) throw forbid(as);
    query.as = leader;
    leaders.set(request, leader);
  });

  app.addHook("preHandler", async (request) => {
    const leader = leaders.get(request);
    if (!leader) return;
    const rule = leaderRule(request.method, request.routeOptions.url ?? "");
    if (rule === "read" || rule === "deny") return;
    const { led, scope } = scopeOf(nodes(db), leader);
    const body = bodyOf(request);
    let verdict: string | null = null;
    switch (rule) {
      case "task-create":
      case "review-create": {
        verdict = ownerVerdict(leader, body.owner);
        if (verdict) break;
        if (!given(body.part) && !given(body.goal)) {
          const home = [...led].sort((a, b) => a - b)[0];
          if (home === undefined) {
            verdict = denied(leader, "建任务：你还没有负责的节点");
            break;
          }
          // 不写归属部分时记在自己负责的节点上，事件也就回到自己这里。
          body.part = ref(home);
        }
        verdict = scopeVerdict(
          leader,
          scope,
          bodyChecks(db, body, rule === "task-create" ? "role" : "leader"),
        );
        break;
      }
      case "task":
        verdict = scopeVerdict(leader, scope, [
          taskCheck(db, idParam(request)),
        ]);
        break;
      case "task-patch":
        verdict =
          ownerVerdict(leader, body.owner) ??
          scopeVerdict(leader, scope, [
            taskCheck(db, idParam(request)),
            ...bodyChecks(db, body, "role"),
          ]);
        break;
      case "point":
        // 改删要点由 points.ts 按 leader 链判；新建先看节点。
        if (request.method === "POST")
          verdict = scopeVerdict(leader, scope, [
            nodeCheck(db, idParam(request), "节点"),
          ]);
        break;
      case "stages":
        verdict = scopeVerdict(leader, scope, [
          nodeCheck(db, idParam(request), "节点"),
        ]);
        break;
      case "node-edit":
        verdict = nodeEditVerdict({
          leader,
          keys: changed(body),
          node: nodeByAddress(db, idParam(request)).id,
          led,
          scope,
        });
        break;
      case "map-edit":
        verdict =
          mapEditVerdict(leader, changed(body)) ??
          scopeVerdict(leader, scope, [
            nodeCheck(db, idParam(request), "节点"),
          ]);
        break;
      case "leader-edit":
        verdict = leaderEditVerdict(leader, idParam(request), changed(body));
        break;
      case "escalate":
        verdict =
          escalateVerdict(leader, idParam(request)) ??
          (given(body.task)
            ? scopeVerdict(leader, scope, [taskCheck(db, body.task)])
            : null);
        break;
      case "events-ack": {
        const found = inbox().subscribersOf(ackIds(request.body));
        verdict = ackVerdict(leader, [...found.values()]);
        break;
      }
    }
    if (verdict) throw forbid(verdict);
  });
}
