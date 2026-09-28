import Fastify from "fastify";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { sameSecret } from "../shared/secret.ts";
import { Problem } from "./problem.ts";
import { UserAuth } from "./user-auth.ts";
import { authPolicy } from "./auth-policy.ts";
import { registerTaskRoutes, runnerEnvOptions } from "./tasks/routes.ts";
import { ensureScheduleTables } from "./schedules/model.ts";
import { SchedulePump } from "./schedules/runtime.ts";
import { registerScheduleRoutes } from "./schedules/routes.ts";
import type { Offset } from "./schedules/plan.ts";
import { registerOrgRoutes } from "./org/routes.ts";
import { ensureOrgTables } from "./org/schema.ts";
import { ensureTaskTables } from "./tasks/ledger-schema.ts";
import { globalPause, migrateOldPauses, partPause } from "./pause.ts";
import { registerSkillRoutes } from "./skills/routes.ts";
import { registerQuotaRoute } from "./tasks/quota.ts";
import type { QuotaReaders } from "./quota-readers/index.ts";
import type { RunnerOptions } from "./tasks/runner.ts";
import {
  SecretaryFallback,
  type ResumeRun,
} from "./tasks/secretary-fallback.ts";
import type { EventInbox } from "./tasks/events.ts";
import { LeaderTokens } from "./leaders/tokens.ts";
import { leaderOf, registerLeaderGuard } from "./leaders/guard.ts";
import { registerVerifierGuard } from "./tasks/verify-guard.ts";
import { registerLeaderRoutes } from "./leaders/routes.ts";
import { registerMemoRoutes } from "./memos/routes.ts";
import { registerMaterialRoutes } from "./materials/routes.ts";
import { registerSecretRoutes } from "./secrets/routes.ts";
import { decideAndAnnounce } from "./choices/notify.ts";
import { registerChoiceRoutes } from "./choices/routes.ts";
import { registerHostRoutes } from "./hosts/routes.ts";
import { TelegramNotifier, type NotifierOptions } from "./notify/runtime.ts";
import { awayPush } from "./notify/model.ts";
import { registerNotifyRoutes } from "./notify/routes.ts";
import {
  LeaderWaker,
  leaderEnvOptions,
  leaderWakeEnabled,
  type LeaderWakerOptions,
} from "./leaders/runtime.ts";
import { registeredLeaders } from "./leaders/model.ts";
import { isDefaultData } from "./service-state.ts";
import { MapLogin } from "./map/login.ts";
import { importLegacyState } from "./imports/index.ts";
import {
  expiredPage,
  isLoopback,
  notLocal,
  registerMapRoutes,
} from "./map/routes.ts";

/** 打开数据库。旧运行时留下的表（身份、聊天、账号等）不读不写，也不因它们存在而报错。 */
export function openDatabase(data: string) {
  const db = new DatabaseSync(join(data, "atrium.sqlite"));
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;",
  );
  return db;
}

/**
 * 组织运行时的 HTTP 入口（#291）：只注册用户认证、任务账本与派活、组织树、全景图、额度和事件路由；
 * 服务控制（/api/service/*）由 main.ts 注册。
 */
export async function createApp(options: {
  data: string;
  controlToken?: string;
  /** 领域测试显式关闭用户认证；生产从不设置。 */
  auth?: boolean;
  /** 安全测试逐条审计已注册的路由。 */
  onRoute?: (method: string, url: string) => void;
  /** 任务运行时（#262）的注入项：测试用来缩短看门狗间隔、替换 git/gh 调用。 */
  tasks?: Partial<RunnerOptions>;
  /** 全景网页失效通知的检查间隔（毫秒），测试缩短。 */
  mapPollMs?: number;
  /** 全景变更检测（测试可注入计数）；缺省读 map_revision。 */
  mapDetect?: (db: DatabaseSync) => string | number;
  /** 全景检测定时器（测试可手动打点）；缺省 setInterval。 */
  mapRepeat?: (ms: number, tick: () => void) => () => void;
  /** OpenQuota 可执行文件路径，测试注入假二进制。 */
  quotaBin?: string;
  /** 自带额度读取器（#352），测试注入假凭据与假接口；null 关掉，缺省用服务共用的一份。 */
  quotaReaders?: QuotaReaders | null;
  /** 服务地址（main.ts 给），写进 leader 进程环境；内存服务没有。 */
  serviceUrl?: string;
  /** leader 唤醒的注入项：测试用来缩短攒批、替换 leader 进程。 */
  leaders?: Partial<Omit<LeaderWakerOptions, "data">>;
  /** 旧的 ~/Atrium 目录（main.ts 给）：启动时导入一次根章程预算；不给就不读。 */
  legacyDir?: string;
  /** 周期任务（#404）：测试缩短巡检间隔、注入时钟与时区。 */
  schedules?: { tickMs?: number; now?: () => number; offset?: Offset };
  /** 推送到手机（Telegram）：测试给假接口地址、显式环境（不读本机代理）与时钟。 */
  notify?: Partial<Omit<NotifierOptions, "data">>;
  /** 秘书后台兜底（t242）：测试缩短「没人听多久叫醒」、替换恢复进程。 */
  secretary?: { graceMs?: number; runTurn?: ResumeRun };
}) {
  mkdirSync(options.data, { recursive: true, mode: 0o700 });
  const db = openDatabase(options.data);
  const auth = new UserAuth(db, options.data);
  const app = Fastify({
    logger: { level: "warn" },
    bodyLimit: 4 * 1024 * 1024,
    forceCloseConnections: "idle",
  });
  app.addHook("onRoute", (route) => {
    for (const method of [route.method].flat())
      options.onRoute?.(method, route.url);
  });
  app.addHook("onClose", async () => db.close());
  app.setErrorHandler((error, request, reply) => {
    const status =
      error instanceof z.ZodError
        ? 400
        : error instanceof Problem
          ? error.statusCode
          : ((error as { statusCode?: number }).statusCode ?? 500);
    void reply.code(status).send({
      code:
        error instanceof Problem
          ? error.code
          : status === 400
            ? "usage"
            : status === 403 || status === 409
              ? "conflict"
              : status === 404
                ? "not_found"
                : "internal",
      ...(error instanceof Problem && error.candidates?.length
        ? { candidates: error.candidates }
        : {}),
      ...(error instanceof Problem && error.nextCommand
        ? { nextCommand: error.nextCommand }
        : {}),
      error:
        error instanceof z.ZodError
          ? error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("；")
          : status >= 500
            ? "服务处理失败，请检查本地日志"
            : error instanceof Error
              ? error.message
              : String(error),
    });
    if (status >= 500) {
      if (/^\/api\/auth(\/|$)/.test(request.url))
        app.log.error("认证处理失败（详情已隐藏）");
      else app.log.error(error);
    }
  });
  app.addHook("onRequest", async (request, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer");
    // 代理接口（#358）只认主机令牌，远程机器经转发连进来时 Host 不是本机名；其余管理入口仅面向本机。
    const agent =
      authPolicy(request.method, request.routeOptions.url ?? "") === "agent";
    let hostname: string;
    try {
      hostname = new URL(`http://${request.headers.host}`).hostname;
    } catch {
      throw new Problem(403, "不接受此 Host");
    }
    if (
      !agent &&
      !["localhost", "atrium.localhost", "127.0.0.1", "[::1]"].includes(
        hostname,
      )
    )
      throw new Problem(403, "管理入口仅面向本机");
    const origin = request.headers.origin;
    if (origin) {
      let host: string;
      try {
        host = new URL(origin).host;
      } catch {
        throw new Problem(403, "Origin 格式无效");
      }
      if (host !== request.headers.host)
        throw new Problem(403, "不接受跨站请求");
    }
  });
  const requireRotation = (authorization: string | undefined) => {
    const control = options.controlToken;
    if (
      !auth.validUser(authorization) &&
      !(
        control &&
        sameSecret(authorization?.replace(/^Bearer /i, "") ?? "", control)
      )
    )
      throw new Problem(
        401,
        "用户或实例控制凭据无效",
        "auth_required",
        undefined,
        "atrium auth rotate",
      );
  };
  // leader 令牌（每次唤醒签发）先于用户认证判定：认出来就按 leader 的权限边界走，不再要求用户令牌。
  const leaderTokens = new LeaderTokens();
  let inbox: (() => EventInbox) | undefined;
  registerLeaderGuard(app, db, leaderTokens, () => inbox!());
  // 上线验证执行者（t239）：认出验证身份头就拒绝止损类写接口（停别人的活、改主机与服务状态）。
  registerVerifierGuard(app);
  // onRequest 拿得到匹配的路由，且在读请求体之前运行。
  const mapLogin = new MapLogin(db);
  app.addHook("onRequest", async (request, reply) => {
    if (options.auth === false || leaderOf(request)) return;
    const route = request.routeOptions.url ?? "";
    if (route === "/api/auth/rotate") {
      requireRotation(request.headers.authorization);
      return;
    }
    const policy = authPolicy(request.method, route);
    // 网页拍板选项单：本机会话也行，但必须是同源页面发起的（有 Origin，上面已核对与 Host 一致）。
    if (policy === "map-write") {
      if (
        isLoopback(request.socket.remoteAddress) &&
        request.headers.origin &&
        mapLogin.valid(request.headers.cookie)
      )
        return;
    }
    // 全景网页（#322）：只接受本机连接；页面认会话 cookie，只读接口令牌或会话都行，一次性链接由路由自己校验。
    else if (policy.startsWith("map-")) {
      if (!isLoopback(request.socket.remoteAddress)) throw notLocal();
      if (policy === "map-login") return;
      if (mapLogin.valid(request.headers.cookie)) return;
      if (policy === "map-page")
        return reply
          .code(401)
          .header("content-type", "text/html; charset=utf-8")
          .header("cache-control", "no-store")
          .send(expiredPage("全景网页的登录已失效"));
    }
    // /api/service/* 由 main.ts 用实例控制凭据校验；代理接口由路由自己认接入码或主机令牌；
    // 没有 Web 外壳，未匹配的路径也要求用户凭据再报 404。
    else if (policy !== "user") return;
    if (auth.validUser(request.headers.authorization)) return;
    if (mapLogin.valid(request.headers.cookie))
      throw new Problem(
        403,
        "这个页面的数据接口没开放给网页（Atrium 的问题，不是你的登录）",
        "map_session_forbidden",
      );
    throw new Problem(
      401,
      request.headers.authorization
        ? "用户认证失效；请运行 atrium auth rotate（确认 ATRIUM_DATA 指向当前数据目录）"
        : "服务已升级，请重新运行命令；若仍失败，请运行 atrium auth rotate（确认 ATRIUM_DATA 指向当前数据目录）",
      "auth_required",
      undefined,
      "atrium auth rotate",
    );
  });
  app.post("/api/auth/rotate", { bodyLimit: 16 * 1024 }, () => {
    auth.rotate();
    return { rotated: true };
  });
  // 任务账本（#262）：表与路由在 server/tasks/；执行者进程由服务持有，日志在 <ATRIUM_DATA>/tasks/<id>/。
  const taskOptions = {
    data: resolve(options.data),
    ...runnerEnvOptions(),
    ...options.tasks,
  };
  // 表先建好，任务运行时才接管与派发。
  ensureTaskTables(db);
  ensureOrgTables(db);
  ensureScheduleTables(db);
  // 一键停机（server/pause.ts）：旧的主机暂停、周期任务暂停在任务运行时起来前并进来，只迁一次。
  try {
    for (const note of migrateOldPauses(db)) console.log(note);
  } catch (error) {
    console.error("旧的暂停状态迁移失败，已跳过：", error);
  }
  const taskRunner = registerTaskRoutes(app, db, taskOptions);
  // 周期任务（#404）：到点在节点下建普通任务并派发；等任务运行时接管完上次在跑的再判上一轮。
  const schedulePump = new SchedulePump(
    db,
    {
      run: (reference, body) => taskRunner.run(reference, body),
      inbox: taskRunner.inbox,
    },
    {
      ready: () => taskRunner.ready,
      paused: (node) => !!globalPause(db) || !!partPause(db, node),
      ...options.schedules,
    },
  );
  registerScheduleRoutes(app, db, schedulePump);
  schedulePump.start();
  app.addHook("preClose", async () => schedulePump.close());
  registerHostRoutes(app, db, taskRunner);
  inbox = () => taskRunner.inbox;
  registerOrgRoutes(app, db);
  // 账本与组织树的表都建好后导入旧状态（#355）：详述回填、根章程预算；幂等，坏记录只记日志。
  importLegacyState(db, { legacyDir: options.legacyDir });
  registerLeaderRoutes(app, db, taskRunner.inbox);
  registerMemoRoutes(app, db);
  // 资料（t192）：文件在 <ATRIUM_DATA>/materials/；表要在全景变更检测挂触发器之前建好。
  registerMaterialRoutes(app, db, resolve(options.data));
  // 凭据（t194）：值在 <ATRIUM_DATA>/secrets/，只在派活时注入执行者。
  registerSecretRoutes(app, db, resolve(options.data));
  // 选项单的表要在全景变更检测挂触发器（registerMapRoutes）之前建好。
  registerChoiceRoutes(app, db, taskRunner.inbox);
  // 推送到手机：等你拍板、上交到用户这层的卡住／越界、里程碑上线（t185）。
  // 在 Telegram 里拍板（t188）：按钮等同 atrium choice pick / pass，拍板人是用户。
  const notifier = new TelegramNotifier(db, {
    data: resolve(options.data),
    decide: (ref, action, body) =>
      decideAndAnnounce(db, taskRunner.inbox, ref, action, body, "u1"),
    ...options.notify,
  });
  taskRunner.inbox.observe((event) => notifier.observe(event));
  registerNotifyRoutes(app, notifier);
  notifier.start();
  app.addHook("preClose", async () => notifier.close());
  // 秘书没在听满 3 分钟就在后台叫醒一次；叫不起来推给用户、状态栏标红（t242）。
  const secretaryFallback = new SecretaryFallback(
    taskRunner.inbox,
    resolve(options.data),
    {
      ...options.secretary,
      paused: () => !!globalPause(db),
      alert: (alert) => notifier.push(awayPush(alert)),
    },
  );
  taskRunner.secretaryWatch = () => ({
    graceMs: secretaryFallback.graceMs,
    ...secretaryFallback.status(),
  });
  secretaryFallback.start();
  app.addHook("preClose", async () => secretaryFallback.close());
  const leaderWaker = new LeaderWaker(db, taskRunner.inbox, leaderTokens, {
    data: resolve(options.data),
    env: options.tasks?.env,
    url: () => options.serviceUrl,
    // 全局暂停不叫醒任何 leader；部分暂停不叫醒负责那一块的 leader。
    paused: (leader) =>
      !!globalPause(db) ||
      (leader !== undefined &&
        (
          db
            .prepare(
              "SELECT id FROM org_nodes WHERE leader=? AND archived_at IS NULL LIMIT 100",
            )
            .all(leader) as { id: number }[]
        ).some((node) => !!partPause(db, node.id))),
    ...leaderEnvOptions(),
    ...options.leaders,
  });
  // 隔离服务缺省不起真 leader 进程（t128）；注入了假进程（测试）照常唤醒。
  if (
    options.leaders?.run ||
    leaderWakeEnabled(process.env.ATRIUM_LEADER_WAKE, {
      defaultData: isDefaultData(options.data),
    })
  )
    leaderWaker.start();
  else if (registeredLeaders(db).size)
    console.warn(
      "隔离数据目录不唤醒 leader，事件留在收件箱；要唤醒请设 ATRIUM_LEADER_WAKE=1",
    );
  app.addHook("preClose", async () => leaderWaker.close());
  registerSkillRoutes(app, db);
  registerMapRoutes(app, db, {
    login: mapLogin,
    live: async () => (await taskRunner.top()).rows,
    pollMs: options.mapPollMs,
    detect: options.mapDetect,
    repeat: options.mapRepeat,
  });
  registerQuotaRoute(app, {
    bin: options.quotaBin,
    db,
    readers: options.quotaReaders,
  });
  return { app, db, taskRunner, leaderTokens, notifier };
}
