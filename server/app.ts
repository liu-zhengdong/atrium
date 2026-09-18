import Fastify, { type FastifyRequest } from "fastify";
import staticFiles from "@fastify/static";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  id,
  text,
  displayName,
  preferences,
  sendInput,
  subscriptionInput,
  type Overview,
} from "../shared/schema.ts";
import { Store, Problem } from "./store.ts";
import { Runtimes } from "./runtime.ts";
import { createMcp } from "./mcp.ts";
import { createAgent, defaultDesktops, displayDesktops } from "./agents.ts";
import { TraceStore } from "./trace.ts";

export async function createApp(options: {
  data: string;
  githubSecret?: string;
  webRoot?: string;
  runtime?: boolean;
  desktops?: string;
}) {
  const desktops = options.desktops ?? defaultDesktops();
  mkdirSync(options.data, { recursive: true, mode: 0o700 });
  mkdirSync(join(options.data, "credentials"), {
    recursive: true,
    mode: 0o700,
  });
  const store = new Store(join(options.data, "atrium.sqlite"));
  const app = Fastify({ logger: { level: "warn" }, bodyLimit: 1_048_576 });
  const streams = new Set<import("node:http").ServerResponse>();
  const changed = () => {
    for (const stream of streams)
      if (!stream.write("event: change\ndata: {}\n\n")) stream.destroy();
  };
  const runtimes =
    options.runtime === false
      ? null
      : new Runtimes(store, options.data, changed, () => {
          const address = app.server.address();
          if (!address || typeof address === "string")
            throw new Problem(503, "Atrium HTTP 入口尚未就绪");
          return `http://127.0.0.1:${address.port}`;
        });
  const traces = runtimes?.traces ?? new TraceStore(store);
  const raw = new WeakMap<FastifyRequest, Buffer>();
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (request, body, done) => {
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
      raw.set(request, buffer);
      try {
        done(null, JSON.parse(buffer.toString("utf8")));
      } catch {
        done(new Problem(400, "JSON 格式错误"));
      }
    },
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
    if (request.url.split("?")[0] === "/webhooks/github") return;
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
      discovery,
      desktops_root: displayDesktops(desktops),
      github_enabled: !!options.githubSecret,
    } satisfies Overview;
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
      })
      .strict()
      .parse(request.body);
    if (input.start && !runtimes) throw new Problem(503, "运行时未启用");
    const agent = createAgent(store, options.data, input.name, desktops, input);
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
  app.patch("/api/agents/:id/config", (request) => {
    const result = store.configure(
      agentParams(request),
      preferences.partial().parse(request.body),
    );
    changed();
    return result;
  });
  app.post("/api/agents/:id/start", async (request) => {
    if (!runtimes) throw new Problem(503, "运行时未启用");
    await runtimes.start(agentParams(request));
    return { connected: true };
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
        unread_only: z.enum(["true", "false"]).default("false"),
      })
      .parse(request.query);
    return store.box(
      agentParams(request),
      q.after,
      q.unread_only === "true",
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
  app.get("/api/subscriptions", () => store.subscriptions());
  app.post("/api/agents/:id/subscriptions", (request) => {
    const a = subscriptionInput.parse(request.body);
    const result = store.subscribe(agentParams(request), a.repository, a.event);
    changed();
    return result;
  });
  app.delete("/api/agents/:id/subscriptions/:subscription", (request) => {
    const a = z
      .object({ id, subscription: z.coerce.number().int().positive() })
      .parse(request.params);
    store.unsubscribe(a.id, a.subscription);
    changed();
    return { removed: true };
  });
  app.post("/api/chats", (request) => {
    const a = z
      .object({
        name: displayName,
        members: z.array(id).max(30),
        direct_agent: id.optional(),
      })
      .strict()
      .parse(request.body);
    if (
      a.direct_agent &&
      (a.members.length !== 1 || a.members[0] !== a.direct_agent)
    )
      throw new Problem(400, "私聊必须且只能包含目标 Agent");
    const result = store.createChat(a.name, a.members, a.direct_agent);
    if (a.direct_agent) void runtimes?.pump(a.direct_agent);
    changed();
    return result;
  });
  app.get("/api/chats/:id", (request) => {
    const chatId = agentParams(request);
    return { ...store.chat(chatId), members: store.members(chatId) };
  });
  app.post("/api/chats/:id/members", (request) => {
    const input = z.object({ agent_id: id }).strict().parse(request.body);
    const members = store.addMember(agentParams(request), input.agent_id);
    changed();
    return { members };
  });
  app.get("/api/chats/:id/messages", (request) => {
    const q = z
      .object({
        before: z.coerce.number().int().positive().optional(),
        read_from: z.coerce.number().int().positive().optional(),
      })
      .parse(request.query);
    return store.timeline(agentParams(request), q.before, q.read_from);
  });
  app.post("/api/messages", (request) => {
    const result = store.send("user", sendInput.parse(request.body));
    changed();
    return result;
  });
  app.post("/mcp/:id", async (request, reply) => {
    const agentId = requireAgent(request),
      server = createMcp(store, agentId, changed, (id) => {
        const info = runtimes?.connections.get(id)?.info;
        return {
          online:
            !!info ||
            !!runtimes?.directory().runtimes.some((r) => r.bound_agent === id),
          busy: info?.busy ?? null,
        };
      });
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
  app.post("/webhooks/github", (request) => {
    if (!options.githubSecret) throw new Problem(503, "GitHub 接入未配置");
    const signature = request.headers["x-hub-signature-256"];
    if (
      typeof signature !== "string" ||
      !/^sha256=[a-f0-9]{64}$/.test(signature)
    )
      throw new Problem(401, "Webhook 签名无效");
    const expected = createHmac("sha256", options.githubSecret)
      .update(raw.get(request) ?? Buffer.alloc(0))
      .digest();
    if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex")))
      throw new Problem(401, "Webhook 签名无效");
    const deliveryId = id.parse(request.headers["x-github-delivery"]);
    if (request.headers["x-github-event"] !== "pull_request")
      return { accepted: true, ignored: true };
    const payload = z
      .object({
        action: z.string().max(80),
        number: z.number().int().positive(),
        repository: z.object({ full_name: subscriptionInput.shape.repository }),
        pull_request: z.object({
          title: z.string().max(2048),
          user: z.object({ login: z.string().max(100) }),
        }),
      })
      .parse(request.body);
    return store.transaction(() => {
      if (store.one("SELECT 1 FROM webhooks WHERE delivery_id=?", deliveryId))
        return { accepted: true, duplicate: true };
      store.run("INSERT INTO webhooks VALUES(?,?)", deliveryId, Date.now());
      const repository = payload.repository.full_name.toLowerCase(),
        event = `pull_request.${payload.action}`;
      const subscriptions = store
        .subscriptions()
        .filter((s) => s.repository === repository && s.event === event);
      for (const subscription of subscriptions)
        store.addNotice(
          subscription.agent_id,
          "github",
          `${payload.repository.full_name} #${payload.number} · ${payload.pull_request.title}`,
          JSON.stringify({
            event,
            repository,
            number: payload.number,
            author: payload.pull_request.user.login,
            title: payload.pull_request.title,
            external_content: true,
          }),
          null,
          `https://github.com/${payload.repository.full_name}/pull/${payload.number}`,
        );
      changed();
      return { accepted: true, matched: subscriptions.length };
    });
  });
  if (options.webRoot && existsSync(options.webRoot)) {
    await app.register(staticFiles, { root: options.webRoot });
    app.setNotFoundHandler((request, reply) => {
      if (
        request.method === "GET" &&
        !/^\/(api|mcp|webhooks)(\/|$)/.test(request.url)
      )
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
