import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mcpConnectionProblem, prepareMcpCall } from "./mcp-retry.ts";

type Call = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
};
const tool = (call: Call) =>
  call.method === "tools/call"
    ? call.params?.name?.replace(/^atrium_/, "")
    : null;

/** Loopback MCP endpoint; Web service is the sole authority for tool execution. */
export class RunnerMcp {
  private server = createServer(
    (request, response) => void this.handle(request, response),
  );
  private port = 0;
  private capabilities = new Map<string, Buffer>();
  constructor(
    private webUrl: string,
    private connected: () => boolean,
    private machineToken: string,
    private waitMs = 60_000,
  ) {}
  async start(port = 0) {
    this.server.listen(port, "127.0.0.1");
    await once(this.server, "listening");
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw new Error("MCP 代理端口未就绪");
    this.port = address.port;
  }
  url(id: string) {
    if (!this.port) throw new Error("MCP 代理尚未启动");
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("无效身份编号");
    let capability = this.capabilities.get(id);
    if (!capability) {
      capability = randomBytes(32);
      this.capabilities.set(id, capability);
    }
    return `http://127.0.0.1:${this.port}/mcp/${id}/${capability.toString("hex")}`;
  }
  async close() {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.capabilities.clear();
  }
  private error(
    reply: ServerResponse,
    call: Call,
    problem: ReturnType<typeof mcpConnectionProblem>,
  ) {
    reply.writeHead(200, { "content-type": "application/json" });
    reply.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: call.id ?? null,
        result: {
          isError: true,
          content: [{ type: "text", text: problem.message }],
          structuredContent: problem,
        },
      }),
    );
  }
  private async handle(request: IncomingMessage, reply: ServerResponse) {
    const match = /^\/mcp\/([a-zA-Z0-9-]+)\/([0-9a-f]{64})$/.exec(
      request.url ?? "",
    );
    if (request.method !== "POST" || !match) {
      reply.writeHead(404).end();
      return;
    }
    const capability = this.capabilities.get(match[1]);
    if (
      !capability ||
      !timingSafeEqual(capability, Buffer.from(match[2], "hex"))
    ) {
      reply.writeHead(403).end();
      return;
    }
    let body = "";
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 16 * 1024 * 1024) {
        reply.writeHead(413).end();
        return;
      }
    }
    let call: Call;
    try {
      call = JSON.parse(body) as Call;
    } catch {
      reply.writeHead(400).end();
      return;
    }
    const name = tool(call);
    const prepared = prepareMcpCall(name ?? "", call.params?.arguments ?? {});
    if (name === "send_message" && call.params) {
      call.params.arguments = prepared.args;
      body = JSON.stringify(call);
    }
    const safe = !name || prepared.retryAfterSend;
    const target = new URL(`/mcp/${match[1]}`, this.webUrl);
    const send = async () =>
      fetch(target, {
        method: "POST",
        headers: {
          "content-type": request.headers["content-type"] ?? "application/json",
          accept:
            request.headers.accept ?? "application/json, text/event-stream",
          ...(request.headers.authorization
            ? { authorization: request.headers.authorization }
            : {}),
          "x-atrium-runner-credential": `Bearer ${this.machineToken}`,
          ...(request.headers["mcp-protocol-version"]
            ? {
                "mcp-protocol-version": String(
                  request.headers["mcp-protocol-version"],
                ),
              }
            : {}),
        },
        body,
        signal: AbortSignal.timeout(15_000),
      });
    const deadline = Date.now() + this.waitMs;
    let outcomeUnknown = false;
    while (true) {
      if (this.connected()) {
        try {
          const result = await send();
          const buffer = Buffer.from(await result.arrayBuffer());
          reply.writeHead(result.status, {
            "content-type":
              result.headers.get("content-type") ?? "application/json",
            ...(result.headers.get("mcp-session-id")
              ? { "mcp-session-id": result.headers.get("mcp-session-id")! }
              : {}),
          });
          reply.end(buffer);
          return;
        } catch (error) {
          const code = (error as { cause?: { code?: string } }).cause?.code;
          const definitelyUnsent =
            code === "ECONNREFUSED" || code === "ENETUNREACH";
          outcomeUnknown ||= !definitelyUnsent;
          if (outcomeUnknown && !safe) {
            this.error(reply, call, mcpConnectionProblem(prepared, true));
            return;
          }
        }
      }
      if (Date.now() >= deadline) {
        this.error(reply, call, mcpConnectionProblem(prepared, outcomeUnknown));
        return;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(400, deadline - Date.now())),
      );
    }
  }
}
