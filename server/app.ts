import Fastify, { type FastifyRequest } from "fastify";
import staticFiles from "@fastify/static";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
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
import { modelSpec } from "../shared/model.ts";
import { Store, Problem } from "./store.ts";
import { Runtimes } from "./runtime.ts";
import { createMcp } from "./mcp.ts";
import {
  createAgent,
  defaultDesktops,
  displayDesktops,
  resolvePiHome,
  retargetProfileLink,
} from "./agents.ts";
import { TraceStore } from "./trace.ts";
import { listAdapters, receiveInbox, writeGithubTemplate } from "./adapters.ts";
import { readUser, resolveActor, writeUser } from "./users.ts";
import { removeMember, updateGroup } from "./groups.ts";
import { fileRecords, messageRecords, recordQuery } from "./records.ts";
import { groupName } from "../shared/group.ts";
import { isUserRef, LOCAL_USER } from "../shared/user.ts";

/** 以谁的名义：用户短号，或身份的短号、名称、ID；不给就是本机用户。 */
const actor = z.string().trim().min(1).max(60);

export async function createApp(options: {
  data: string;
  webRoot?: string;
  runtime?: boolean;
  desktops?: string;
  piHome?: string;
}) {
  const desktops = options.desktops ?? defaultDesktops();
  const piHome = options.piHome;
  mkdirSync(options.data, { recursive: true, mode: 0o700 });
  mkdirSync(join(options.data, "credentials"), {
    recursive: true,
    mode: 0o700,
  });
  const store = new Store(join(options.data, "atrium.sqlite"));
  const app = Fastify({
    logger: { level: "warn" },
    bodyLimit: 11 * 1024 * 1024,
  });
  const streams = new Set<import("node:http").ServerResponse>();
  const changed = () => {
    for (const stream of streams)
      if (!stream.write("event: change\ndata: {}\n\n")) stream.destroy();
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
        );
  const traces = runtimes?.traces ?? new TraceStore(store);
  // 统一接收口接受任意内容类型；JSON 走默认解析器，其余保留原始文本。
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) =>
    done(null, body),
  );
  app.setErrorHandler((error, _, reply) => {
    const status =
      error instanceof z.ZodError
        ? 400
        : error instanceof Problem
          ? error.statusCode
          : ((error as { statusCode?: number }).statusCode ?? 500);
    void reply.code(status).send({
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
    if (status >= 500) app.log.error(error);
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
    if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname))
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
  const agentParams = (request: FastifyRequest) =>
    z.object({ id }).parse(request.params).id;
  const requireAgent = (request: FastifyRequest) => {
    const agentId = agentParams(request),
      token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (!store.authenticate(agentId, token))
      throw new Problem(401, "Agent 凭据无效");
    return agentId;
  };
  app.get("/api/overview", () => {
    const discovery = runtimes?.directory() ?? {
      runtimes: [],
      scanning: false,
      error: null,
    };
    const available = new Set(discovery.runtimes.map((r) => r.bound_agent));
    return {
      agents: store.agents().map((a) => ({
        ...a,
        runtime: runtimes?.connections.get(a.id)?.info ?? null,
        available: available.has(a.id) || !!runtimes?.connections.has(a.id),
        error: runtimes?.errors.get(a.id) ?? null,
        unread: store.boxCount(a.id),
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
    if (input.start && !runtimes) throw new Problem(503, "运行时未启用");
    const agent = createAgent(store, options.data, input.name, desktops, {
      ...input,
      piHome,
    });
    let start_error: string | undefined;
    if (input.start) {
      try {
        await runtimes!.start(agent.id);
      } catch {
        start_error = "Agent 已创建，但启动失败。可在详情中重试。";
      }
    }
    changed();
    void reply.code(201);
    return { agent, start_error };
  });
  app.post("/api/runtimes/:id/chat", async (request) => {
    if (!runtimes) throw new Problem(503, "运行时未启用");
    const agent = await runtimes.agentForRuntime(agentParams(request));
    const chat = store.createChat(agent.name, [agent.id], agent.id);
    // A conversation is usable immediately; connecting does not hold the HTTP UI open.
    void runtimes.pump(agent.id);
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
  app.get("/api/agents/:id/model", async (request) => {
    if (!runtimes) throw new Problem(503, "运行时未启用");
    return runtimes.model(agentParams(request));
  });
  // 模型不走 preferences：那份 schema 与 MCP 的 update_config 共用，加进去等于对 Agent 开放。
  app.put("/api/agents/:id/model", async (request) => {
    if (!runtimes) throw new Problem(503, "运行时未启用");
    const input = z.object({ model: modelSpec }).strict().parse(request.body);
    return runtimes.setModel(agentParams(request), input.model);
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
    if (isUserRef(sender)) void runtimes?.pump(target);
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
    if (a.direct_agent) void runtimes?.pump(a.direct_agent);
    changed();
    return result;
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
        read_from: z.coerce.number().int().positive().optional(),
        around: z.coerce.number().int().positive().optional(),
      })
      .parse(request.query);
    return store.timeline(
      agentParams(request),
      q.before,
      q.read_from,
      q.around,
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
      if (request.method === "GET" && !/^\/(api|mcp)(\/|$)/.test(request.url))
        return reply.sendFile("index.html");
      return reply.code(404).send({ error: "接口不存在" });
    });
  }
  app.addHook("preClose", async () => {
    for (const stream of streams) stream.end();
    await runtimes?.close();
  });
  app.addHook("onClose", async () => {
    store.close();
  });
  return { app, store, runtimes };
}
