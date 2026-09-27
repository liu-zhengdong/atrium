import type { FastifyInstance, FastifyRequest } from "fastify";
import { leaderOf } from "../leaders/guard.ts";
import type { DatabaseSync } from "node:sqlite";
import {
  ackIds,
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
import {
  confirmWorkerAdvice,
  workerReport,
  workersReport,
} from "./workers-report.ts";
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

type Query = Record<string, string | undefined>;
const params = (value: unknown) => (value ?? {}) as { id?: string };
const query = (value: unknown) => (value ?? {}) as Query;
/** 调用方以谁的名义（?as=），缺省 secretary。 */
const actorOf = (q: Query) =>
  q.as === undefined || q.as === "" ? DEFAULT_OWNER : ownerOf(q.as, "as");

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
  // 仅 node:test 派生的隔离服务可模拟磁盘；生产服务始终读 statfs。
  if (env.NODE_TEST_CONTEXT && env.ATRIUM_TEST_DISK_FREE_GB) {
    const gb = Number(env.ATRIUM_TEST_DISK_FREE_GB);
    if (Number.isFinite(gb) && gb >= 0) options.diskFreeGb = async () => gb;
  }
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
  app.post("/api/workers/advice/confirm", { bodyLimit: 4096 }, (request) =>
    confirmWorkerAdvice(db, request.body),
  );
  app.get("/api/roles", () => listJobRoles(db));
  app.post("/api/roles", { bodyLimit: 32 * 1024 }, (request, reply) =>
    reply.code(201).send(createJobRole(db, request.body)),
  );
  app.get("/api/roles/:id", async (request) => {
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
      suggestions: workers.suggestions,
    };
  });
  app.patch("/api/roles/:id", { bodyLimit: 32 * 1024 }, (request) =>
    editJobRole(db, params(request.params).id, request.body),
  );
  app.get("/api/roles/:id/history", (request) =>
    jobRoleHistory(db, params(request.params).id),
  );
  // 详述进库（#355）：内容至多 64 KB，JSON 转义后留足余量。
  app.post("/api/tasks", { bodyLimit: 256 * 1024 }, async (request, reply) => {
    const task = createTask(db, request.body, Date.now(), leaderOf(request));
    return reply.code(201).send(task);
  });
  app.get("/api/tasks", (request) => {
    const { parent, status, after, limit } = query(request.query);
    return listTasks(db, { parent, status, after, limit });
  });
  app.get("/api/tasks/tree", (request) =>
    taskTree(db, query(request.query).root),
  );
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
    const task = updateTask(db, params(request.params).id, request.body);
    if (task.status === "cancelled") await runner.cleanupCancelled(task.id);
    return getTask(db, task.id);
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
  app.post("/api/tasks/:id/run", { bodyLimit: 16 * 1024 }, (request) =>
    runner.run(params(request.params).id, request.body),
  );
  app.post("/api/tasks/:id/stop", (request) =>
    runner.stop(params(request.params).id, actorOf(query(request.query))),
  );
  app.post("/api/tasks/:id/merge", (request) =>
    runner.requeueMerge(params(request.params).id),
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
  // 会审（#322 第 3 步）：议题 → 并行专员意见 → leader 汇总 → 结论。
  app.post("/api/reviews", { bodyLimit: 256 * 1024 }, async (request, reply) =>
    reply.code(201).send(await runner.addCouncil(request.body)),
  );
  app.get("/api/reviews/:id", (request) =>
    runner.council(params(request.params).id),
  );
  app.post("/api/reviews/:id/decide", { bodyLimit: 16 * 1024 }, (request) => {
    const q = query(request.query);
    // 拍板人缺省是用户 u1；秘书代为转达时也记 u1 的决定。
    const actor =
      q.as === undefined || q.as === "" ? "u1" : ownerOf(q.as, "as");
    return runner.decideCouncil(params(request.params).id, request.body, actor);
  });
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
  app.get("/api/events", (request) => {
    const q = query(request.query);
    return runner.inbox.list(actorOf(q), listOptions(q));
  });
  app.post("/api/events/ack", { bodyLimit: 64 * 1024 }, (request) =>
    runner.inbox.ack(ackIds(request.body)),
  );
  return runner;
}
