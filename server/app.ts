import Fastify, { type FastifyRequest } from "fastify";
import staticFiles from "@fastify/static";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mkdirSync, existsSync, createReadStream } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spaceFileKind } from "../shared/space.ts";
import { z } from "zod";
import {
  id,
  text,
  displayName,
  forkSource,
  inviteNote,
  preferencePatch,
  sendInput,
  type Overview,
} from "../shared/schema.ts";
import { modelSpec, type ModelOption } from "../shared/model.ts";
import { Store, Problem } from "./store.ts";
import { Accounts } from "./accounts.ts";
import {
  assignmentCommand,
  hasAssignment,
  removeSharedLinks,
} from "./assignment.ts";
import { customSchema } from "./custom-providers.ts";
import { Runtimes } from "./runtime.ts";
import { createMcp } from "./mcp.ts";
import {
  createAgent,
  defaultDesktops,
  displayDesktops,
  resolvePiHome,
  retargetProfileLink,
} from "./agents.ts";
import { currentVersion } from "./service-state.ts";
import { readRestartState } from "./supervisor.ts";
import { TraceStore } from "./trace.ts";
import { listAdapters, receiveInbox, writeGithubTemplate } from "./adapters.ts";
import { readUser, resolveActor, writeUser } from "./users.ts";
import {
  deletionPreview,
  disbandGroup,
  removeMember,
  updateGroup,
} from "./groups.ts";
import { fileRecords, messageRecords, recordQuery } from "./records.ts";
import { UserAuth } from "./user-auth.ts";
import { RunnerAuth } from "./runner-auth.ts";
import { authPolicy, protectedNamespace } from "./auth-policy.ts";
import { groupName } from "../shared/group.ts";
import { isUserRef, LOCAL_USER } from "../shared/user.ts";
import {
  changeSkill,
  listRules,
  listSkills,
  listTemplateSkills,
  readMcp,
  writeMcp,
  writeRule,
} from "./identity-resources.ts";
import {
  agentDefaults,
  templateDefaults,
  saveAgentDefaults,
  packageList,
  ensureOwnPackages,
  changePackages,
  serialized,
  type AgentDefaults,
} from "./identity-packages.ts";

/** 以谁的名义：用户短号，或身份的短号、名称、ID；不给就是本机用户。 */
const actor = z.string().trim().min(1).max(60);

export async function createApp(options: {
  data: string;
  webRoot?: string;
  runtime?: boolean;
  desktops?: string;
  piHome?: string;
  controlToken?: string;
  /** Existing domain tests disable user auth explicitly; production never sets this. */
  auth?: boolean;
  /** Audit every registered route in security tests. */
  onRoute?: (method: string, url: string) => void;
}) {
  const desktops = options.desktops ?? defaultDesktops();
  const piHome = options.piHome;
  mkdirSync(options.data, { recursive: true, mode: 0o700 });
  mkdirSync(join(options.data, "credentials"), {
    recursive: true,
    mode: 0o700,
  });
  const store = new Store(join(options.data, "atrium.sqlite"));
  const auth = new UserAuth(store, options.data);
  const runnerAuth = new RunnerAuth(store);
  const accounts = new Accounts(store, options.data);
  removeSharedLinks(store);
  if (options.runtime !== false) {
    accounts.start();
    accounts.preloadProviders();
  }
  const app = Fastify({
    logger: { level: "warn" },
    bodyLimit: 11 * 1024 * 1024,
  });
  app.addHook("onRoute", (route) => {
    for (const method of [route.method].flat())
      options.onRoute?.(method, route.url);
  });
  const streams = new Set<import("node:http").ServerResponse>();
  const waiters = new Set<{ wake: () => void; cancel: () => void }>();
  const changed = () => {
    for (const waiter of [...waiters]) waiter.wake();
    for (const stream of streams)
      if (!stream.write("event: change\ndata: {}\n\n")) stream.destroy();
  };
  const revokeSubscriptions = () => {
    for (const stream of streams) stream.end();
    for (const waiter of [...waiters]) waiter.cancel();
  };
  const runtimes =
    options.runtime === false
      ? null
      : new Runtimes(
          store,
          options.data,
          changed,
          () => {
            const address = app.server.address();
            if (!address || typeof address === "string")
              throw new Problem(503, "Atrium HTTP 入口尚未就绪");
            return `http://127.0.0.1:${address.port}`;
          },
          piHome,
          desktops,
          (agent, text) => accounts.redact(agent, text),
          (agent, detail) => accounts.markModelAuthFailure(agent, detail),
        );
  const traces =
    runtimes?.traces ??
    new TraceStore(store, (agent, text) => accounts.redact(agent, text));
  // 统一接收口接受任意内容类型；JSON 走默认解析器，其余保留原始文本。
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) =>
    done(null, body),
  );
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
          : status >= 500 &&
              !(error instanceof Problem && error.code === "new_session_failed")
            ? "服务处理失败，请检查本地日志"
            : error instanceof Error
              ? error.message
              : String(error),
    });
    // Credential JSON parse failures can include a slice of the token in their exception.
    if (status >= 500) {
      if (/^\/(hooks|auth)(\/|$)/.test(request.url))
        app.log.error("认证或推送处理失败（秘密 URL 已隐藏）");
      else if (/^\/api\/(accounts|assign|credentials)(\/|$)/.test(request.url))
        app.log.error("账号操作失败（详情已隐藏，避免凭据进入日志）");
      else app.log.error(error);
    }
  });
  app.addHook("onRequest", async (request, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer");
    let hostname: string;
    try {
      hostname = new URL(`http://${request.headers.host}`).hostname;
    } catch {
      throw new Problem(403, "不接受此 Host");
    }
    if (
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
  // Fastify has matched the route here. Raw URL prefixes are not an auth boundary:
  // /%61pi/overview matches /api/overview after decoding.
  app.addHook("preHandler", async (request, reply) => {
    if (options.auth === false) return;
    const route = request.routeOptions.url ?? "";
    const policy = authPolicy(request.method, route);
    if (
      policy === "public" &&
      route === "/*" &&
      protectedNamespace(request.url)
    )
      throw new Problem(404, "接口不存在");
    if (policy !== "user") return;
    if (auth.validUser(request.headers.authorization)) return;
    if (auth.validSession(request.headers.cookie)) {
      reply.header("Set-Cookie", auth.refreshCookie(request.headers.cookie));
      return;
    }
    throw new Problem(
      401,
      request.headers.authorization || request.headers.cookie
        ? "用户认证失效；请运行 atrium auth rotate（确认 ATRIUM_DATA 指向当前数据目录）"
        : "服务已升级，请重新运行命令；若仍失败，请运行 atrium auth rotate（确认 ATRIUM_DATA 指向当前数据目录）",
      "auth_required",
      undefined,
      "atrium auth rotate",
    );
  });
  app.get("/api/runners", () => runnerAuth.list());
  app.post("/api/runners", (request) => {
    const input = z
      .object({
        name: z.string().trim().min(1).max(100),
        tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .parse(request.body);
    return runnerAuth.issue(input.name, input.tokenHash);
  });
  app.post("/api/runners/:ref/rotate", (request) => {
    const { ref } = request.params as { ref: string };
    const { tokenHash } = z
      .object({ tokenHash: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(request.body);
    return runnerAuth.rotate(ref, tokenHash);
  });
  app.post("/api/runners/:ref/revoke", (request) => {
    runnerAuth.revoke((request.params as { ref: string }).ref);
    return { revoked: true };
  });
  app.get("/api/auth/session", (request) => ({
    authenticated: auth.validSession(request.headers.cookie),
  }));
  app.post("/api/auth/link", () => ({ code: auth.issueCode() }));
  app.get("/auth/claim/:code", (request, reply) => {
    if (
      new URL(`http://${request.headers.host}`).hostname !== "atrium.localhost"
    )
      throw new Problem(403, "请用 atrium open 获取本机登录链接");
    const code = z
      .object({ code: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(request.params).code;
    try {
      reply.header("Set-Cookie", auth.claimCode(code));
      return reply.redirect("/");
    } catch (error) {
      if (!(error instanceof Problem) || error.statusCode !== 401) throw error;
      return reply.code(401).type("text/html; charset=utf-8")
        .send(`<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>登录链接已失效 · Atrium</title>
<main style="max-width:28rem;margin:18vh auto;padding:2rem;font:16px/1.7 system-ui,sans-serif;color:#222">
<h1>登录链接已失效</h1><p>请在终端重新运行 <code>atrium open</code> 获取新链接。</p>
</main></html>`);
    }
  });
  app.post("/api/auth/logout", (_request, reply) => {
    auth.logout();
    revokeSubscriptions();
    reply.header("Set-Cookie", auth.clearCookie());
    return { ok: true };
  });
  app.post("/api/auth/rotate", (request) => {
    const authorization = request.headers.authorization;
    const control = options.controlToken;
    if (
      !auth.validUser(authorization) &&
      !(control && authorization?.replace(/^Bearer /i, "") === control)
    )
      throw new Problem(
        401,
        "用户或实例控制凭据无效",
        "auth_required",
        undefined,
        "atrium auth rotate",
      );
    auth.rotate();
    revokeSubscriptions();
    return { rotated: true };
  });
  const agentParams = (request: FastifyRequest) =>
    z.object({ id }).parse(request.params).id;
  const requireAgent = (request: FastifyRequest) => {
    const agentId = agentParams(request),
      token = request.headers.authorization?.replace(/^Bearer /i, "") ?? "";
    if (!store.authenticate(agentId, token))
      throw new Problem(401, "Agent 凭据无效");
    return agentId;
  };
  const accountRef = (request: FastifyRequest) =>
    z.object({ ref: z.string() }).parse(request.params).ref;
  const identityRef = (request: FastifyRequest) =>
    store.resolveAgentId(
      z.object({ agent: z.string() }).parse(request.params).agent,
    );
  app.get("/api/settings/service", (request) => ({
    address: `http://${request.headers.host}`,
    data: resolve(options.data),
    log: join(resolve(options.data), "service.log"),
  }));
  app.get("/api/settings/agent-defaults", () => agentDefaults(options.data));
  app.get("/api/settings/agent-defaults/template", () => templateDefaults());
  const displayModels = async (options: ModelOption[]) => {
    if (!options.length) return options;
    let providerNames = new Map<string, string>();
    try {
      providerNames = new Map(
        (await accounts.providersList()).map((item) => [item.id, item.name]),
      );
    } catch {
      // 模型目录仍可用，供应商显示名缺失时不猜测。
    }
    return options.map((option) => ({
      ...option,
      ...(providerNames.has(option.id.slice(0, option.id.indexOf("/")))
        ? {
            providerName: providerNames.get(
              option.id.slice(0, option.id.indexOf("/")),
            ),
          }
        : {}),
    }));
  };
  const modelsForDisplay = async () =>
    displayModels(runtimes ? await runtimes.modelsForDefaults() : []);
  app.get("/api/models", modelsForDisplay);
  app.get("/api/settings/agent-defaults/models", modelsForDisplay);
  app.put("/api/settings/agent-defaults", (request) => {
    const input = z
      .object({
        packages: z.array(
          z.union([
            z.string().trim().min(1).max(4096),
            z
              .object({
                source: z.string().trim().min(1).max(4096),
                extensions: z.array(z.string()).optional(),
                skills: z.array(z.string()).optional(),
                prompts: z.array(z.string()).optional(),
                themes: z.array(z.string()).optional(),
              })
              .strict(),
          ]),
        ),
        skills: z.array(z.string().min(1).max(255)),
        model: z
          .object({
            provider: z.string().trim().min(1),
            model: z.string().trim().min(1),
          })
          .strict()
          .nullable(),
      })
      .strict()
      .parse(request.body) satisfies AgentDefaults;
    return saveAgentDefaults(options.data, input);
  });
  app.get("/api/providers", () => accounts.providersList());
  app.get("/api/accounts", () => accounts.list());
  app.get("/api/custom/:provider", (request) =>
    accounts.customConfig((request.params as { provider: string }).provider),
  );
  app.post("/api/custom/models", (request) => {
    const { config, key } = z
      .object({ config: customSchema, key: z.string() })
      .strict()
      .parse(request.body);
    return accounts.customModels(config, key);
  });
  app.post("/api/accounts/validate", (request) => {
    const { provider, key } = z
      .object({ provider: z.string(), key: z.string() })
      .strict()
      .parse(request.body);
    return accounts.probeKey(provider, key);
  });
  app.post("/api/accounts", (request) => {
    const { provider, name, key, allowUnverified, custom } = z
      .object({
        provider: z.string(),
        name: z.string().trim().min(1).max(80),
        key: z.string(),
        allowUnverified: z.boolean().optional(),
        custom: customSchema.optional(),
      })
      .strict()
      .parse(request.body);
    return accounts.addValidated(
      provider,
      name,
      key || (custom ? "atrium-local" : ""),
      allowUnverified,
      custom,
    );
  });
  app.post("/api/accounts/local", (request) => {
    const { provider } = z
      .object({ provider: z.literal("claude-bridge") })
      .strict()
      .parse(request.body);
    return accounts.addLocal(provider);
  });
  app.post("/api/accounts/:ref/check", (request) =>
    accounts.checkLocal(accountRef(request)),
  );
  app.put("/api/accounts/:ref/key", (request) => {
    const { key, allowUnverified, custom } = z
      .object({
        key: z.string(),
        allowUnverified: z.boolean().optional(),
        custom: customSchema.optional(),
      })
      .strict()
      .parse(request.body);
    return accounts.replaceKey(
      accountRef(request),
      key,
      allowUnverified,
      custom,
    );
  });
  app.post("/api/accounts/login", (request) => {
    const { provider, name } = z
      .object({ provider: z.string(), name: z.string().trim().min(1).max(80) })
      .strict()
      .parse(request.body);
    return accounts.login(provider, name);
  });
  app.post("/api/accounts/:ref/login", (request) =>
    accounts.relogin(accountRef(request)),
  );
  app.get("/api/accounts/:ref/login", (request) => {
    const after = z.coerce
      .number()
      .int()
      .min(0)
      .parse((request.query as { after?: unknown }).after ?? 0);
    return accounts.loginEvents(accountRef(request), after);
  });
  app.post("/api/accounts/:ref/login/answer", (request) => {
    const { value } = z
      .object({ value: z.string().nullable() })
      .strict()
      .parse(request.body);
    return accounts.answer(accountRef(request), value);
  });
  app.post("/api/accounts/:ref/login/cancel", (request) =>
    accounts.cancel(accountRef(request)),
  );
  app.patch("/api/accounts/:ref", (request) => {
    const { name } = z
      .object({ name: z.string().trim().min(1).max(80) })
      .strict()
      .parse(request.body);
    return accounts.rename(accountRef(request), name);
  });
  app.delete("/api/accounts/:ref", async (request) => {
    const ref = accountRef(request);
    const account = accounts.list().find((entry) => entry.id === ref);
    if (account)
      for (const agentRef of account.assigned) {
        const id = store.resolveAgentId(agentRef);
        const remaining = store.one<{ count: number }>(
          "SELECT count(*) AS count FROM account_assignments WHERE agent_id=?",
          id,
        )?.count;
        if (remaining === 1) await runtimes?.stopForUnassignment(id);
      }
    const result = accounts.remove(ref);
    changed();
    return result;
  });
  app.get("/api/credentials/:agent", (request) => {
    const id = identityRef(request);
    return { ...accounts.switchMode(id), ref: store.agent(id).ref };
  });
  app.get("/api/assignment-check", () => {
    const available = accounts.list();
    const unassigned = store
      .agents()
      .filter((agent) => !hasAssignment(store, agent.id))
      .map((agent) => {
        const command = assignmentCommand(store, agent.id, available);
        return {
          ref: agent.ref,
          name: agent.name,
          command: command ?? `atrium assign ${agent.ref} <账号短号>`,
          matched: !!command,
        };
      });
    return {
      unassigned,
      accounts: unassigned.some((agent) => !agent.matched)
        ? available.map(({ id, provider, name, status }) => ({
            id,
            provider,
            name,
            status,
          }))
        : [],
    };
  });
  app.put("/api/credentials/:agent", (request) => {
    const { mode } = z
      .object({ mode: z.enum(["shared", "assigned"]) })
      .strict()
      .parse(request.body);
    return accounts.switchMode(identityRef(request), mode);
  });
  app.post("/api/assign/:agent", (request) => {
    const { account, replace } = z
      .object({ account: z.string(), replace: z.boolean().optional() })
      .strict()
      .parse(request.body);
    const id = identityRef(request);
    const result = accounts.assign(id, account, replace);
    changed();
    return {
      ...result,
      agentName: store.agent(id).name,
      accountName: accounts.list().find((entry) => entry.id === account)?.name,
    };
  });
  app.delete("/api/assign/:agent/:provider", async (request) => {
    const { provider } = z
      .object({ provider: z.string() })
      .parse(request.params);
    const id = identityRef(request);
    const remaining = store.one<{ count: number }>(
      "SELECT count(*) AS count FROM account_assignments WHERE agent_id=?",
      id,
    )?.count;
    const previous = store.one<{ account_number: number }>(
      "SELECT account_number FROM account_assignments WHERE agent_id=? AND provider=?",
      id,
      provider,
    );
    const last = remaining === 1 && !!previous;
    const stopped = !!(last && runtimes?.connections.has(id));
    if (last) await runtimes?.stopForUnassignment(id);
    const result = accounts.unassign(id, provider);
    changed();
    const assigned = hasAssignment(store, id);
    return {
      ...result,
      name: store.agent(id).name,
      stopped,
      hasAssignment: assigned,
      nextCommand: assigned
        ? null
        : (assignmentCommand(
            store,
            id,
            accounts.list(),
            previous ? `k${previous.account_number}` : undefined,
          ) ?? "atrium account check"),
    };
  });
  app.get("/api/overview", () => {
    const discovery = runtimes?.directory() ?? {
      runtimes: [],
      scanning: false,
      error: null,
    };
    const available = new Set(discovery.runtimes.map((r) => r.bound_agent));
    const restart = readRestartState(options.data);
    return {
      version: currentVersion(),
      rollback:
        restart?.status === "rolled_back" &&
        restart.fromVersion &&
        restart.failedVersion
          ? {
              fromVersion: restart.fromVersion,
              failedVersion: restart.failedVersion,
              error: restart.error ?? "启动验证失败",
            }
          : null,
      agents: store.agents().map((a) => ({
        ...a,
        runtime: runtimes?.connections.get(a.id)?.info ?? null,
        available: available.has(a.id) || !!runtimes?.connections.has(a.id),
        running: runtimes?.running(a.id, discovery.runtimes) ?? false,
        error: store.failure(a.id)?.text ?? runtimes?.errors.get(a.id) ?? null,
        failure: store.failure(a.id),
        unread: store.boxCount(a.id),
        unassigned: !hasAssignment(store, a.id),
        needs_reload: runtimes?.needsReload.has(a.id) ?? false,
      })),
      chats: store.chats(),
      user: readUser(store),
      discovery,
      desktops_root: displayDesktops(desktops),
    } satisfies Overview;
  });
  app.get("/api/user", () => readUser(store));
  // 资料由用户本人维护，Agent 只能用 user_info 读。
  app.patch("/api/user", (request) => {
    const value = writeUser(store, LOCAL_USER, request.body);
    changed();
    return value;
  });
  app.get("/api/events", (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    reply.raw.write(": connected\n\n");
    streams.add(reply.raw);
    const heartbeat = setInterval(
      () => reply.raw.write(": heartbeat\n\n"),
      20000,
    ).unref();
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      streams.delete(reply.raw);
    });
  });
  app.post("/api/agents", async (request, reply) => {
    const input = z
      .object({
        name: displayName,
        start: z.boolean().default(false),
        description: z.string().trim().max(1000).default(""),
        template: z.string().min(1).max(4096).optional(),
        source: forkSource.optional(),
      })
      .strict()
      .parse(request.body);
    if (input.start)
      throw new Problem(
        409,
        "先创建身份并分配账号，再执行 atrium start <身份短号>",
        "unassigned_account",
      );
    const agent = createAgent(store, options.data, input.name, desktops, {
      ...input,
      piHome,
    });
    changed();
    void reply.code(201);
    return { agent };
  });
  app.post("/api/runtimes/:id/chat", async (request) => {
    if (!runtimes) throw new Problem(503, "运行时未启用");
    const agent = await runtimes.agentForRuntime(agentParams(request));
    const chat = store.createChat(agent.name, [agent.id], agent.id);
    // A conversation is usable immediately; connecting does not hold the HTTP UI open.
    void runtimes.pump(agent.id, true);
    changed();
    return chat;
  });
  app.get("/api/runtimes", async () => {
    if (!runtimes) throw new Problem(503, "运行时未启用");
    return { runtimes: await runtimes.available() };
  });
  app.patch("/api/agents/:id/profile", (request) => {
    const agentId = agentParams(request);
    const previous = store.agent(agentId);
    const value = z
      .object({ name: displayName, description: z.string().trim().max(1000) })
      .strict()
      .parse(request.body);
    if (
      store.one(
        "SELECT 1 FROM agents WHERE name=? AND id<>?",
        value.name,
        agentId,
      )
    )
      throw new Problem(409, "这个名称已经被使用");
    store.transaction(() => {
      store.run(
        "UPDATE agents SET name=?,description=? WHERE id=?",
        value.name,
        value.description,
        agentId,
      );
      // Follow the identity name for default private-chat titles, not custom titles.
      store.run(
        "UPDATE chats SET name=? WHERE direct_agent=? AND name=?",
        value.name,
        agentId,
        previous.name,
      );
      if (previous.agent_directory)
        retargetProfileLink(
          resolvePiHome(piHome),
          previous.name,
          value.name,
          previous.agent_directory,
        );
    });
    changed();
    return store.agent(agentId);
  });
  app.delete("/api/agents/:id", async (request) => {
    if (!runtimes) throw new Problem(503, "运行时未启用，无法确认是否可删除");
    const { confirm } = z
      .object({ confirm: z.string() })
      .strict()
      .parse(request.body);
    await runtimes.remove(agentParams(request), confirm);
    return { removed: true };
  });
  app.post("/api/agents/:id/promote", async (request) => {
    if (!runtimes) throw new Problem(503, "运行时未启用");
    const value = z
      .object({ template: z.string().min(1).max(4096).optional() })
      .strict()
      .parse(request.body ?? {});
    return runtimes.promote(agentParams(request), value.template);
  });
  app.post("/api/agents/:id/attach", async (request) => {
    if (!runtimes) throw new Problem(503, "运行时未启用");
    const input = z.object({ runtime_id: id }).strict().parse(request.body);
    await runtimes.attach(agentParams(request), input.runtime_id);
    return { connected: true };
  });
  const packageDirectory = (request: FastifyRequest) => {
    const agent = store.agent(agentParams(request));
    if (!agent.agent_directory) throw new Problem(409, "旧身份尚无配置目录");
    return agent.agent_directory;
  };
  app.get("/api/agents/:id/skills", (request) =>
    listSkills(packageDirectory(request)),
  );
  app.get("/api/agents/:id/skills/available", (request) =>
    listTemplateSkills(packageDirectory(request)),
  );
  app.post("/api/agents/:id/skills", (request) => {
    const directory = packageDirectory(request);
    const input = z
      .object({
        action: z.enum(["enable", "disable", "remove", "copy"]),
        name: z.string().min(1).max(100),
      })
      .strict()
      .parse(request.body);
    return serialized(directory, async () =>
      changeSkill(directory, input.action, input.name),
    );
  });
  app.get("/api/agents/:id/mcp", (request) =>
    readMcp(packageDirectory(request)),
  );
  app.put("/api/agents/:id/mcp", (request) => {
    const directory = packageDirectory(request);
    const { text } = z
      .object({ text: z.string().max(1024 * 1024) })
      .strict()
      .parse(request.body);
    return serialized(directory, async () => writeMcp(directory, text));
  });
  app.get("/api/agents/:id/rules", (request) =>
    listRules(packageDirectory(request)),
  );
  app.put("/api/agents/:id/rules", (request) => {
    const directory = packageDirectory(request);
    const { name, text } = z
      .object({
        name: z.enum(["AGENTS.md", "SYSTEM.md", "APPEND_SYSTEM.md"]),
        text: z.string().max(1024 * 1024),
      })
      .strict()
      .parse(request.body);
    return serialized(directory, async () => writeRule(directory, name, text));
  });
  app.get("/api/agents/:id/plugins", (request) =>
    packageList(packageDirectory(request)),
  );
  // Keep a clear error for older clients; no mode changes are supported.
  app.put("/api/agents/:id/plugins/mode", () => {
    throw new Problem(410, "插件模式不可切换；每个身份独立安装");
  });
  app.post("/api/agents/:id/plugins", async (request) => {
    const directory = packageDirectory(request);
    const input = z
      .object({
        action: z.enum([
          "add",
          "remove",
          "update",
          "enable",
          "disable",
          "update-all",
        ]),
        spec: z.string().min(1).max(4096).optional(),
      })
      .strict()
      .parse(request.body);
    return serialized(directory, async () => changePackages(directory, input));
  });
  app.get("/api/agents/:id/model", async (request) => {
    if (!runtimes) throw new Problem(503, "运行时未启用");
    const state = await runtimes.model(agentParams(request));
    return { ...state, options: await displayModels(state.options) };
  });
  // 模型不走 preferences：那份 schema 与 MCP 的 update_config 共用，加进去等于对 Agent 开放。
  app.put("/api/agents/:id/model", async (request) => {
    if (!runtimes) throw new Problem(503, "运行时未启用");
    const input = z.object({ model: modelSpec }).strict().parse(request.body);
    const state = await runtimes.setModel(agentParams(request), input.model);
    return { ...state, options: await displayModels(state.options) };
  });
  app.patch("/api/agents/:id/config", (request) => {
    const result = store.configure(
      agentParams(request),
      preferencePatch.parse(request.body),
    );
    changed();
    return result;
  });
  app.post("/api/agents/:id/start", async (request) => {
    if (!runtimes) throw new Problem(503, "运行时未启用");
    await runtimes.start(agentParams(request));
    return { connected: true };
  });
  app.post("/api/agents/:id/new-session", async (request) => {
    if (!runtimes) throw new Problem(503, "运行时未启用");
    const { timeout } = z
      .object({ timeout: z.number().int().min(1).max(3600).default(300) })
      .strict()
      .parse(request.body);
    return runtimes.newSession(agentParams(request), timeout);
  });
  app.post("/api/agents/:id/retry", async (request) => {
    if (!runtimes) throw new Problem(503, "运行时未启用");
    await runtimes.retry(agentParams(request));
    return { retried: true };
  });
  app.post("/api/agents/:id/stop", async (request) => {
    if (!runtimes) throw new Problem(503, "运行时未启用");
    await runtimes.stop(agentParams(request));
    return { stopped: true };
  });
  // 与某位 Agent 的私聊：用户名义是它与用户的私聊，身份名义是两位同伴之间的私聊。
  app.post("/api/agents/:id/direct", (request) => {
    const target = agentParams(request);
    const { as } = z
      .object({ as: actor.optional() })
      .strict()
      .parse(request.body ?? {});
    const sender = resolveActor(store, as);
    const chat = isUserRef(sender)
      ? store.createChat(store.agent(target).name, [target], target)
      : store.openDirect(sender, target);
    if (isUserRef(sender)) void runtimes?.pump(target, true);
    changed();
    return chat;
  });
  app.get("/api/agents/:id/trace", (request) => {
    const agent = agentParams(request);
    const { before } = z
      .object({ before: z.coerce.number().int().positive().optional() })
      .strict()
      .parse(request.query);
    return {
      ...traces.page(agent, before),
      error: runtimes?.traceErrors.get(agent) ?? null,
    };
  });
  app.get("/api/agents/:id/trace/:action", (request) => {
    const params = z
      .object({ id, action: z.coerce.number().int().positive() })
      .parse(request.params);
    return traces.detail(params.id, params.action);
  });
  app.get("/api/agents/:id/box", (request) => {
    const q = z
      .object({
        after: z.coerce.number().int().min(0).default(0),
        pending_only: z.enum(["true", "false"]).default("false"),
      })
      .parse(request.query);
    return store.box(
      agentParams(request),
      q.after,
      q.pending_only === "true",
      false,
      30,
    );
  });
  app.post("/api/agents/:id/box", (request) => {
    const input = z
      .object({ title: z.string().trim().min(1).max(200), body: text })
      .strict()
      .parse(request.body);
    const noticeId = store.addNotice(
      agentParams(request),
      "system",
      input.title,
      input.body,
    );
    changed();
    return { id: noticeId };
  });
  app.post("/api/agents/:ref/inbox", async (request) => {
    const { ref } = request.params as { ref: string };
    const agent = store.agent(store.resolveAgentId(ref));
    const result = await receiveInbox(store, agent, {
      headers: request.headers,
      query: request.query,
      body: request.body,
    });
    if (result.stored) changed();
    return result;
  });
  app.post("/hooks/:ref/:token", async (request, reply) => {
    const params = z
      .object({ ref: z.string().regex(/^a[1-9][0-9]*$/), token: z.string() })
      .parse(request.params);
    let agentId: string;
    try {
      agentId = store.resolveAgentId(params.ref);
    } catch {
      return reply.code(404).send({ error: "推送地址无效" });
    }
    if (!auth.validHook(agentId, params.token))
      return reply.code(404).send({ error: "推送地址无效" });
    const result = await receiveInbox(store, store.agent(agentId), {
      headers: request.headers,
      query: request.query,
      body: request.body,
    });
    if (result.stored) changed();
    return result;
  });
  app.get("/api/agents/:ref/adapters/url", (request) => {
    const agentId = store.resolveAgentId(accountRef(request));
    return {
      agent: store.agentRef(agentId),
      tokenHash: auth.hookHash(agentId),
    };
  });
  app.put("/api/agents/:ref/adapters/url", (request) => {
    const agentId = store.resolveAgentId(accountRef(request));
    const { tokenHash } = z
      .object({
        tokenHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
      })
      .parse(request.body);
    auth.setHook(agentId, tokenHash);
    return {
      agent: store.agentRef(agentId),
      tokenHash: auth.hookHash(agentId),
    };
  });
  app.get("/api/agents/:ref/adapters", (request) => {
    const { ref } = request.params as { ref: string };
    return listAdapters(store.agent(store.resolveAgentId(ref)));
  });
  app.post("/api/agents/:ref/adapters/github", (request) => {
    const { ref } = request.params as { ref: string };
    return writeGithubTemplate(store.agent(store.resolveAgentId(ref)));
  });
  app.post("/api/chats", (request) => {
    const a = z
      .object({
        name: groupName,
        members: z.array(id).max(30),
        direct_agent: id.optional(),
        as: actor.optional(),
        note: inviteNote,
      })
      .strict()
      .parse(request.body);
    const creator = resolveActor(store, a.as);
    if (a.direct_agent && !isUserRef(creator))
      throw new Problem(
        400,
        "以身份名义只能建群；同伴私聊用 POST /api/agents/:id/direct",
      );
    if (
      a.direct_agent &&
      (a.members.length !== 1 || a.members[0] !== a.direct_agent)
    )
      throw new Problem(400, "私聊必须且只能包含目标 Agent");
    // 以身份名义建群走 MCP create_group 同一条路：它自己入群，其他成员收到邀请通知。
    // 来意只随邀请通知送出，用户建群不发邀请通知，所以不收下一个没人会看到的 note。
    if (a.note && isUserRef(creator))
      throw new Problem(
        400,
        "来意随邀请通知送出；用户建群不发邀请通知，请以身份名义建群，或建群后直接发一条消息",
      );
    const result = isUserRef(creator)
      ? store.createChat(a.name, a.members, a.direct_agent)
      : store.createChat(
          a.name,
          [...new Set([creator, ...a.members])],
          undefined,
          {
            by: creator,
            note: a.note,
          },
        );
    if (isUserRef(creator) && !a.direct_agent)
      store.markUserParticipated(result.id);
    if (a.direct_agent) void runtimes?.pump(a.direct_agent, true);
    changed();
    return result;
  });
  // 群共享目录：列文件、读单个文件。路径校验只在 GroupSpaces.file 一处。
  app.get("/api/chats/:id/space", (request) =>
    store.spaces.list(store.chat(agentParams(request))),
  );
  app.get("/api/chats/:id/space/file", (request, reply) => {
    const { path } = z
      .object({ path: z.string().min(1).max(500) })
      .parse(request.query);
    const file = store.spaces.file(store.chat(agentParams(request)), path);
    const { kind, mime } = spaceFileKind(path);
    // 文件是 Agent 写的，内容不受信：只按扩展名给安全的类型，直接打开也不跑脚本、不嗅探类型。
    return reply
      .type(mime)
      .header(
        "Content-Disposition",
        `${kind === "other" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(basename(path))}`,
      )
      .header("Content-Security-Policy", "sandbox")
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "no-store")
      .send(createReadStream(file));
  });
  app.get("/api/chats/:id", (request) => {
    const chatId = agentParams(request);
    return { ...store.chat(chatId), members: store.members(chatId) };
  });
  app.post("/api/chats/:id/members", (request) => {
    const input = z
      .object({ agent_id: id, as: actor.optional(), note: inviteNote })
      .strict()
      .parse(request.body);
    const chatId = agentParams(request);
    const inviter = resolveActor(store, input.as);
    if (input.note && isUserRef(inviter))
      throw new Problem(
        400,
        "来意随邀请通知送出；用户拉人不发邀请通知，请以群内某个身份的名义邀请",
      );
    // 以身份名义邀请走 MCP invite_agent 同一条路：邀请人须在群内，新成员收到通知。
    const members = isUserRef(inviter)
      ? store.addMember(chatId, input.agent_id)
      : store.invite(inviter, chatId, input.agent_id, input.note);
    changed();
    return { members };
  });
  app.delete("/api/chats/:id/members/:agentId", (request) => {
    const params = request.params as { agentId: string };
    const members = removeMember(store, agentParams(request), params.agentId);
    changed();
    return { members };
  });
  // 群名与公告一起给当前值；隐藏、置顶这类开关走 PATCH /api/chats/:id。
  app.patch("/api/chats/:id/profile", (request) => {
    const chat = updateGroup(store, agentParams(request), request.body);
    changed();
    return chat;
  });
  // 删群是危险操作：先给预览，确认群名一致后才在同一个事务里删掉全部历史。
  app.get("/api/chats/:id/deletion", (request) =>
    deletionPreview(store, agentParams(request)),
  );
  app.delete("/api/chats/:id", (request) => {
    const { confirm } = z
      .object({ confirm: z.string() })
      .strict()
      .parse(request.body);
    const result = disbandGroup(store, agentParams(request), confirm);
    changed();
    return result;
  });
  // 聊天记录：会话、发送者、时间范围三个筛选两边共用，内容形状不同所以分两条。
  app.get("/api/records/messages", (request) =>
    messageRecords(store, recordQuery.parse(request.query)),
  );
  app.get("/api/records/files", (request) =>
    fileRecords(store, recordQuery.parse(request.query)),
  );
  app.get("/api/chats/:id/messages", (request) => {
    const q = z
      .object({
        before: z.coerce.number().int().positive().optional(),
        after: z.coerce.number().int().nonnegative().optional(),
        read_from: z.coerce.number().int().positive().optional(),
        around: z.coerce.number().int().positive().optional(),
      })
      .parse(request.query);
    if (
      q.after !== undefined &&
      (q.before !== undefined ||
        q.around !== undefined ||
        q.read_from !== undefined)
    )
      throw new Problem(
        400,
        "--after 不能与 --before、around 或 read_from 同时使用",
      );
    const chatId = agentParams(request);
    const page =
      q.after === undefined
        ? store.timeline(chatId, q.before, q.read_from, q.around)
        : store.timelineAfter(chatId, q.after);
    const chat = store.chat(chatId);
    if (chat.kind !== "direct" || !chat.direct_agent) return page;
    const triggers = traces.triggers(chat.direct_agent, chatId, page.items);
    return {
      ...page,
      items: page.items.map((message) => ({
        ...message,
        ...(triggers[message.id] ? { trigger: triggers[message.id] } : {}),
      })),
    };
  });
  // 等待注册与首次读取在同一同步调用栈中完成；不会漏掉检查与订阅之间的消息。
  const waitQuery = z.object({
    after: z.coerce.number().int().nonnegative().optional(),
    timeout: z.coerce.number().int().min(1).max(3600).default(300),
  });
  function longWait<T>(
    reply: import("fastify").FastifyReply,
    timeout: number,
    check: () => T | null,
    onTimeout: () => T,
  ) {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
    });
    reply.raw.flushHeaders();
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (value?: T) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      waiters.delete(waiter);
      reply.raw.off("close", disconnected);
      if (value !== undefined && !reply.raw.destroyed)
        reply.raw.end(JSON.stringify(value));
    };
    const disconnected = () => finish();
    const wake = () => {
      try {
        const result = check();
        if (result !== null) finish(result);
      } catch (error) {
        app.log.error(error, "wait check failed");
        finish();
        reply.raw.destroy();
      }
    };
    const waiter = { wake, cancel: () => finish(onTimeout()) };
    reply.raw.on("close", disconnected);
    waiters.add(waiter);
    timer = setTimeout(() => finish(onTimeout()), timeout * 1000);
    wake();
  }
  app.get("/api/chats/:id/wait", (request, reply) => {
    const q = waitQuery.parse(request.query);
    const chatId = agentParams(request);
    const after = q.after ?? store.latestMessageId(chatId);
    // 即使指定 after，也在挂等待之前核对会话存在。
    store.chat(chatId);
    longWait(
      reply,
      q.timeout,
      () => {
        const page = store.timelineAfter(chatId, after);
        return page.items.length ? { ...page, after, timed_out: false } : null;
      },
      () => ({ items: [], has_more: false, after, timed_out: true }),
    );
  });
  app.get("/api/agents/:agent/wait", (request, reply) => {
    const q = waitQuery.pick({ timeout: true }).parse(request.query);
    const agentId = identityRef(request);
    store.agent(agentId);
    const state = () => {
      const info = runtimes?.connections.get(agentId)?.info;
      return info ? (info.busy ? "busy" : "idle") : "offline";
    };
    const initial = state();
    const startedAt = Date.now();
    const info = runtimes?.connections.get(agentId)?.info;
    longWait(
      reply,
      q.timeout,
      () => {
        const status = state();
        if (status === "busy") return null;
        const ended =
          initial === "busy"
            ? (info &&
                store.one<{ at: number }>(
                  "SELECT at FROM trace_actions WHERE agent_id=? AND runtime_id=? AND generation=? AND kind='run_end' AND at>=? ORDER BY id DESC LIMIT 1",
                  agentId,
                  info.runtimeId,
                  info.generation,
                  startedAt,
                )?.at) ||
              Date.now()
            : null;
        return { status, finished_at: ended, timed_out: false };
      },
      () => ({ status: state(), finished_at: null, timed_out: true }),
    );
  });
  app.patch("/api/chats/:id", (request) => {
    const input = z
      .object({
        hidden: z.boolean().optional(),
        pinned: z.boolean().optional(),
      })
      .strict()
      .parse(request.body);
    const id = store.resolveChatId((request.params as { id: string }).id);
    if (input.hidden !== undefined) store.setChatHidden(id, input.hidden);
    if (input.pinned !== undefined) store.setChatPinned(id, input.pinned);
    changed();
    return store.chat(id);
  });
  app.get("/api/search", (request) => {
    const q = String((request.query as { q?: string }).q ?? "").trim();
    if (!q) throw new Problem(400, "缺少搜索词");
    return store.search(q);
  });
  app.post("/api/chats/:id/read", (request) => {
    const input = z
      .object({ through: z.number().int().nonnegative() })
      .strict()
      .parse(request.body);
    const result = store.markUserRead(
      store.resolveChatId((request.params as { id: string }).id),
      input.through,
    );
    if (result.changed) changed();
    return { last_read: result.last_read };
  });
  app.post("/api/attachments", (request) => {
    if (!Buffer.isBuffer(request.body))
      throw new Problem(400, "请以二进制上传");
    const raw = String(request.headers["x-filename"] ?? "file");
    let name = raw;
    try {
      name = decodeURIComponent(raw);
    } catch {
      /* keep raw */
    }
    const mime = String(
      request.headers["x-mime"] ??
        request.headers["content-type"] ??
        "application/octet-stream",
    );
    return store.stage(
      LOCAL_USER,
      name,
      mime.split(";")[0]!.trim(),
      request.body,
    );
  });
  app.get("/api/attachments/:id", (request, reply) => {
    const { attachment, bytes } = store.readBytes(
      (request.params as { id: string }).id,
    );
    const filename = encodeURIComponent(attachment.name);
    return reply
      .type(attachment.mime)
      .header(
        "Content-Disposition",
        `${attachment.kind === "image" ? "inline" : "attachment"}; filename*=UTF-8''${filename}`,
      )
      .header("Cache-Control", "private, max-age=3600")
      .send(bytes);
  });
  app.delete("/api/attachments/:id", (request) => {
    store.discardAttachment((request.params as { id: string }).id, LOCAL_USER);
    return { ok: true };
  });
  app.post("/api/messages", (request) => {
    // 默认是用户发言；`as` 以某个身份的名义，成员资格、@ 全体等限制与 MCP send_message 一致。
    const { as, ...input } = z
      .looseObject({ as: actor.optional() })
      .parse(request.body);
    const result = store.send(resolveActor(store, as), sendInput.parse(input));
    changed();
    return result;
  });
  app.post("/mcp/:id", async (request, reply) => {
    const agentId = requireAgent(request),
      server = createMcp(
        store,
        agentId,
        changed,
        (id) => {
          const info = runtimes?.connections.get(id)?.info;
          return {
            online:
              !!info ||
              !!runtimes
                ?.directory()
                .runtimes.some((r) => r.bound_agent === id),
            busy: info?.busy ?? null,
          };
        },
        { data: options.data, desktops, piHome },
      );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });
  if (options.webRoot && existsSync(options.webRoot)) {
    await app.register(staticFiles, { root: options.webRoot });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && !protectedNamespace(request.url))
        return reply.sendFile("index.html");
      return reply.code(404).send({ error: "接口不存在" });
    });
  }
  app.addHook("preClose", async () => {
    revokeSubscriptions();
    await runtimes?.close();
  });
  app.addHook("onClose", async () => {
    await accounts.close();
    store.close();
  });
  return { app, store, runnerAuth, runtimes, pendingWaits: () => waiters.size };
}
