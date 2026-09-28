import { publishInvolved } from "./notice.ts";
import { isTotal, openDescendants } from "./rollup-ledger.ts";
import { Problem } from "../problem.ts";
import { taskRef } from "./ledger-model.ts";
import { involvedOf } from "./also.ts";
import { specialistsForPart } from "./specialist-scope.ts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { leaderOf } from "../leaders/guard.ts";
import type { DatabaseSync } from "node:sqlite";
import {
  ackIds,
  listenInput,
  listOptions,
  waitSeconds,
  settleSeconds,
  sinceTime,
} from "./events.ts";
import {
  DEFAULT_OWNER,
  addTaskNote,
  createTask,
  ensureTaskTables,
  getTask,
  listTasks,
  ownerOf,
  taskTree,
  updateTask,
} from "./ledger.ts";
import { workerReport, workersReport } from "./workers-report.ts";
import {
  createJobRole,
  editJobRole,
  getJobRole,
  jobRoleHistory,
  listJobRoles,
} from "./job-roles.ts";
import { TaskRunner, type RunnerOptions } from "./runner.ts";
import {
  editProfile,
  listProfileViews,
  profileView,
} from "./worker-profile-edit.ts";
import { resolveActor } from "../actor.ts";
import { taskPlan } from "./schedule.ts";
import { parseTaskRef } from "./ledger.ts";
import { verifierOf } from "./verify-guard.ts";
import { markVerdict, whyOf } from "./urgent.ts";

type Query = Record<string, string | undefined>;
const params = (value: unknown) => (value ?? {}) as { id?: string };
const query = (value: unknown) => (value ?? {}) as Query;
/** 调用方以谁的名义（?as=），缺省 secretary。 */
const actorOf = (q: Query) =>
  q.as === undefined || q.as === "" ? DEFAULT_OWNER : ownerOf(q.as, "as");

/** 请求体里的对象字段（不是对象时为空）。 */
const bodyFields = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * 标紧急的权限（t215）：leader 标紧急须写原因，写了就知会用户；用户与秘书随时可标。
 * becoming 为这次请求是否新标上紧急；why 取请求里的，没给就用任务上已有的。
 */
function urgentGate(
  leader: string | undefined,
  becoming: boolean,
  why: unknown,
  existing?: string | null,
  stopgap?: unknown,
) {
  // 止损动作会停别处的任务、暂停主机，越过 leader 令牌的范围：只让用户与秘书写。
  if (leader && stopgap !== undefined && stopgap !== null && stopgap !== "")
    throw new Problem(
      403,
      `stopgap: ${leader} 不能写止损动作（会停别处的任务、暂停主机）；需要止损请上交`,
      "leader_scope",
    );
  const verdict = markVerdict({
    leader,
    urgent: becoming,
    why: whyOf(why) ?? existing ?? null,
  });
  if (!verdict.ok) throw new Problem(400, verdict.reason, "usage");
  return verdict.notify;
}

/** 客户端断开时中止长轮询。 */
function disconnect(request: FastifyRequest) {
  const controller = new AbortController();
  request.raw.once("close", () => controller.abort());
  return controller.signal;
}

/** 数值配置从环境读：ATRIUM_WORKERS_DIR、ATRIUM_EVENT_BATCH_SECONDS、ATRIUM_EVENT_LEASE_MINUTES。 */
export function runnerEnvOptions(env: NodeJS.ProcessEnv = process.env) {
  const options: Partial<RunnerOptions> = {};
  if (env.ATRIUM_WORKERS_DIR) options.workersDir = env.ATRIUM_WORKERS_DIR;
  const batch = Number(env.ATRIUM_EVENT_BATCH_SECONDS);
  if (Number.isFinite(batch) && batch > 0) options.batchMs = batch * 1000;
  const lease = Number(env.ATRIUM_EVENT_LEASE_MINUTES);
  if (Number.isFinite(lease) && lease > 0) options.leaseMs = lease * 60_000;
  const unknown = Number(env.ATRIUM_QUOTA_UNKNOWN_MINUTES);
  if (Number.isFinite(unknown) && unknown > 0)
    options.quotaUnknownMs = unknown * 60_000;
  const online = Number(env.ATRIUM_ONLINE_POLL_SECONDS);
  if (Number.isFinite(online) && online > 0)
    options.online = { pollMs: online * 1000 };
  return options;
}

/**
 * 任务账本、派活与事件投递的 HTTP 入口（#262）。走默认的用户认证（auth-policy 未列出即要求用户凭据）；
 * 字段校验在领域模块里，这里只转交。
 */
export function registerTaskRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  runnerOptions: RunnerOptions,
) {
  ensureTaskTables(db);
  const runner = new TaskRunner(db, runnerOptions);
  runner.start();
  app.post("/api/quota/:provider/clear", (request) =>
    runner.clearQuota(
      ((request.params ?? {}) as { provider: string }).provider,
    ),
  );
  app.addHook("preClose", async () => runner.close());
  app.get("/api/workers", (request) =>
    workersReport(db, query(request.query).role),
  );
  app.get("/api/workers/:id", (request) =>
    workerReport(db, params(request.params).id!),
  );
  // 执行者档案（#355）：库里的三层档案，改动留修订；`层/名` 拆成两段路径参数。
  const profileRef = (request: FastifyRequest) => {
    const p = (request.params ?? {}) as { layer?: string; name?: string };
    return `${p.layer ?? ""}/${p.name ?? ""}`;
  };
  app.get("/api/workers/profiles", () => ({
    profiles: listProfileViews(db),
  }));
  app.get("/api/workers/profiles/:layer/:name", (request) =>
    profileView(db, profileRef(request)),
  );
  app.put(
    "/api/workers/profiles/:layer/:name",
    { bodyLimit: 256 * 1024 },
    (request) =>
      editProfile(
        db,
        profileRef(request),
        request.body,
        resolveActor(db, query(request.query).as),
      ),
  );
  app.get("/api/specialists", (request) => {
    const part = query(request.query).part;
    return part ? specialistsForPart(db, part) : listJobRoles(db);
  });
  app.post("/api/specialists", { bodyLimit: 32 * 1024 }, (request, reply) =>
    reply.code(201).send(createJobRole(db, request.body)),
  );
  app.get("/api/specialists/:id", async (request) => {
    const role = getJobRole(db, params(request.params).id);
    const tasks = (
      db
        .prepare(
          "SELECT id,title,status,worker,created_at,started_at,ended_at,delivery_stage FROM tasks WHERE job_id=? ORDER BY id DESC LIMIT 200",
        )
        .all(role.id) as {
        id: number;
        title: string;
        status: string;
        worker: string | null;
        created_at: number;
        started_at: number | null;
        ended_at: number | null;
        delivery_stage: string | null;
      }[]
    ).map((task) => ({ ...task, ref: `t${task.id}` }));
    const workers = await workersReport(db, role.ref);
    const skillDetails = role.skills
      .map((slug) =>
        db
          .prepare(
            "SELECT id,slug,name,description,rev FROM org_skills WHERE slug=? AND archived_at IS NULL",
          )
          .get(slug),
      )
      .filter(Boolean);
    return {
      ...role,
      tasks,
      skill_details: skillDetails,
      workers: workers.stats,
    };
  });
  app.patch("/api/specialists/:id", { bodyLimit: 32 * 1024 }, (request) =>
    editJobRole(db, params(request.params).id, request.body),
  );
  app.get("/api/specialists/:id/history", (request) =>
    jobRoleHistory(db, params(request.params).id),
  );
  // 详述进库（#355）：内容至多 64 KB，JSON 转义后留足余量。
  app.post("/api/tasks", { bodyLimit: 256 * 1024 }, async (request, reply) => {
    const input = bodyFields(request.body);
    const leader = leaderOf(request);
    const notify = urgentGate(
      leader,
      input.urgent === true,
      input.why,
      null,
      input.stopgap,
    );
    const task = createTask(db, request.body, Date.now(), leader);
    publishInvolved(runner.inbox, db, task.id, [], leader);
    // 紧急通道（t215）：leader 标的知会用户；写了止损动作的建好就先执行。
    if (notify)
      runner.lane.notifyMarked(task.id, leader!, task.urgent_why ?? null);
    const stopgap = task.stopgap ? await runner.lane.stopgap(task.id) : null;
    const warning = task.urgent === 1 ? runner.lane.crowd() : null;
    return reply.code(201).send({
      ...(stopgap ? getTask(db, task.id) : task),
      ...(stopgap ? { stopgap_results: stopgap } : {}),
      ...(warning ? { urgent_warning: warning } : {}),
    });
  });
  app.get("/api/tasks", (request) => {
    const { parent, status, after, limit } = query(request.query);
    return listTasks(db, { parent, status, after, limit });
  });
  app.get("/api/tasks/tree", (request) => {
    const { root, all, after, limit } = query(request.query);
    return taskTree(db, root, { all, after, limit });
  });
  // 静态路径要排在 :id 前面，别让 top 被当成任务短号。
  app.get("/api/tasks/top", (request) =>
    runner.top({ as: query(request.query).as }),
  );
  app.get("/api/tasks/plan", (request) => {
    const q = query(request.query);
    return taskPlan(
      db,
      q.after ? parseTaskRef(q.after, "after") : 0,
      q.limit ? Number(q.limit) : 200,
    );
  });
  app.get("/api/tasks/:id", (request) =>
    getTask(db, params(request.params).id),
  );
  app.patch("/api/tasks/:id", { bodyLimit: 256 * 1024 }, async (request) => {
    const id = parseTaskRef(params(request.params).id);
    const exists = db.prepare("SELECT 1 FROM tasks WHERE id=?").get(id);
    const before = exists ? involvedOf(db, getTask(db, id)) : undefined;
    const { body, withChildren } = cascadeOf(request.body);
    const input = bodyFields(body);
    const leader = leaderOf(request);
    const current = exists ? getTask(db, id) : undefined;
    const notify = urgentGate(
      leader,
      input.urgent === true && current?.urgent !== 1,
      input.why,
      current?.urgent_why,
      input.stopgap,
    );
    // 总任务取消（t190）：下面还有没结束的子孙时先问一句，带 --with-children 才连带取消。
    const open =
      exists &&
      (body as { status?: unknown } | null)?.status === "cancelled" &&
      isTotal(db, id)
        ? openDescendants(db, id)
        : [];
    if (open.length && !withChildren)
      throw new Problem(
        409,
        `${taskRef(id)} 是总任务，下面还有 ${open.length} 个没结束的子孙：${open
          .slice(0, 10)
          .map((child) => taskRef(child.id))
          .join(
            "、",
          )}${open.length > 10 ? "…" : ""}；要连带取消加 --with-children（在跑的先停，已上线、已完成的不动）`,
        "conflict",
        undefined,
        `atrium task set ${taskRef(id)} --status cancelled --with-children`,
      );
    const task = updateTask(db, params(request.params).id, body, Date.now(), {
      by: leader,
    });
    if (notify)
      runner.lane.notifyMarked(task.id, leader!, task.urgent_why ?? null);
    // 新写的止损动作立刻执行（t215）。
    const stopgap =
      "stopgap" in input && task.urgent === 1 && task.stopgap
        ? await runner.lane.stopgap(task.id)
        : null;
    const cascade = open.length
      ? await runner.cancelDescendants(id, leaderOf(request))
      : null;
    if (task.status === "cancelled") await runner.cleanupCancelled(task.id);
    if ((body as { status?: unknown } | null)?.status !== undefined)
      runner.changedTotals(task.id);
    // 标了紧急或改了闲时 / 普通：排队中的立刻按新先后再排一轮。
    const reordered =
      !!request.body &&
      typeof request.body === "object" &&
      "priority" in request.body;
    if (task.urgent === 1 || reordered) await runner.urgentQueued(task.id);
    if (task.status !== "cancelled" && before)
      publishInvolved(
        runner.inbox,
        db,
        task.id,
        [...before.also, ...before.auto],
        leaderOf(request),
      );
    const warning =
      input.urgent === true && task.urgent === 1 ? runner.lane.crowd() : null;
    return {
      ...getTask(db, task.id),
      ...(cascade
        ? { cancelled_children: cascade.cancelled, stopped: cascade.stopped }
        : {}),
      ...(stopgap ? { stopgap_results: stopgap } : {}),
      ...(warning ? { urgent_warning: warning } : {}),
    };
  });
  app.post("/api/tasks/:id/note", { bodyLimit: 4 * 1024 }, (request) =>
    addTaskNote(
      db,
      params(request.params).id,
      request.body,
      Date.now(),
      leaderOf(request) ?? "u1",
    ),
  );
  app.post("/api/tasks/:id/tell", { bodyLimit: 32 * 1024 }, (request) =>
    runner.tell(
      params(request.params).id,
      request.body,
      leaderOf(request) ?? "u1",
    ),
  );
  app.get("/api/tasks/:id/pick", (request) =>
    runner.pick(params(request.params).id, query(request.query).risk),
  );
  app.post("/api/tasks/:id/run", { bodyLimit: 16 * 1024 }, async (request) => {
    const input = bodyFields(request.body);
    const leader = leaderOf(request);
    const current = getTask(db, params(request.params).id);
    const becoming = input.urgent === true && current.urgent !== 1;
    const notify = urgentGate(leader, becoming, input.why, current.urgent_why);
    const result = await runner.run(current.ref, request.body, leader);
    if (notify) {
      const task = getTask(db, current.id);
      runner.lane.notifyMarked(task.id, leader!, task.urgent_why ?? null);
    }
    const warning = becoming ? runner.lane.crowd() : null;
    return warning ? { ...result, urgent_warning: warning } : result;
  });
  // 停止事件记发起者（t239）：上线验证执行者停自己记它的 tN，其余记 ?as=。
  app.post("/api/tasks/:id/stop", (request) =>
    runner.stop(
      params(request.params).id,
      verifierOf(request) || actorOf(query(request.query)),
    ),
  );
  app.post("/api/tasks/:id/merge", (request) =>
    runner.requeueMerge(params(request.params).id),
  );
  // 秘书、leader 亲自做完的活登记 PR 与工作树，进合入队列（t257）；执行者经命令行防护拒绝。
  app.post("/api/tasks/:id/deliver", { bodyLimit: 8 * 1024 }, (request) =>
    runner.deliver(
      params(request.params).id,
      request.body,
      leaderOf(request) ?? actorOf(query(request.query)),
    ),
  );
  app.get("/api/tasks/:id/log", (request) =>
    runner.log(params(request.params).id, query(request.query).after),
  );
  app.get("/api/tasks/:id/wait", (request) =>
    runner.wait(
      params(request.params).id,
      waitSeconds(query(request.query).timeout),
      disconnect(request),
    ),
  );
  app.get("/api/events/wait", (request) => {
    const q = query(request.query);
    return runner.inbox.wait(
      actorOf(q),
      waitSeconds(q.timeout),
      disconnect(request),
      {
        peek: q.peek === "1" || q.peek === "true",
        all: q.all === "1",
        settleSeconds: settleSeconds(q.settle),
      },
    );
  });
  app.get("/api/events/digest", (request) => {
    const q = query(request.query);
    return runner.inbox.digest(actorOf(q), sinceTime(q.since));
  });
  app.post("/api/events/deliver", { bodyLimit: 64 * 1024 }, (request) => ({
    events: runner.inbox.deliver(
      actorOf(query(request.query)),
      ackIds(request.body),
    ),
  }));
  // 经注入在听（t243 `atrium secretary bridge`）：定时续报，后台兜底据此不另起秘书。
  app.post("/api/events/listen", { bodyLimit: 4 * 1024 }, (request) => ({
    listener: runner.inbox.listen(
      actorOf(query(request.query)),
      listenInput(request.body),
    ),
  }));
  app.get("/api/events/listen", (request) => ({
    listener: runner.inbox.listener(actorOf(query(request.query))) ?? null,
  }));
  app.get("/api/events", (request) => {
    const q = query(request.query);
    return runner.inbox.list(actorOf(q), listOptions(q));
  });
  app.post("/api/events/ack", { bodyLimit: 64 * 1024 }, (request) =>
    runner.inbox.ack(ackIds(request.body)),
  );
  return runner;
}

/** task set 的 with_children（取消总任务时连带取消子孙）不是任务字段：先摘出来再交给 updateTask。 */
function cascadeOf(body: unknown) {
  if (!body || typeof body !== "object" || !("with_children" in body))
    return { body, withChildren: false };
  const { with_children, ...rest } = body as Record<string, unknown>;
  if (with_children !== true && with_children !== false)
    throw new Problem(400, "with_children: 应为 true 或 false", "usage");
  if (with_children && rest.status !== "cancelled")
    throw new Problem(
      400,
      "--with-children 只用于取消总任务：同时给 --status cancelled",
      "usage",
    );
  return { body: rest, withChildren: with_children };
}
