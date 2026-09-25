import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { once } from "node:events";
import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientConnection,
} from "@agentclientprotocol/sdk";
import WebSocket from "ws";
import { identityEnvironment } from "./runtime.ts";
import { RunnerLink } from "./runner-link.ts";
import { RunnerEvents } from "./runner-events.ts";
import { RunnerMcp } from "./runner-mcp.ts";
import { RunnerJournal } from "./runner-process.ts";
import { runtimeEvents } from "../shared/trace.ts";
import { liveRuntimeSchema } from "../shared/schema.ts";
import { z } from "zod";

const require = createRequire(import.meta.url);
type Gateway = {
  connection: ClientConnection;
  child: ChildProcessWithoutNullStreams;
};

/** Long-lived Pi owner. The WebSocket is replaceable; the ACP child is not. */
export class RunnerDaemon {
  readonly generation = randomUUID();
  private gateway?: Gateway;
  private socket?: WebSocket;
  private link?: RunnerLink;
  private stopped = false;
  private opening?: Promise<Gateway>;
  private events = new RunnerEvents();
  private eventTimer?: NodeJS.Timeout;
  private polling = false;
  private eventError: string | null = null;
  private mcp: RunnerMcp;
  private journal?: RunnerJournal;
  constructor(
    private url: string,
    private token: string,
    private environment: NodeJS.ProcessEnv = process.env,
    stateFile?: string,
  ) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "ws:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
      parsed.pathname !== "/runner/v1"
    )
      throw new Error("首期运行器只允许本机 ws:// 连接");
    if (stateFile) this.journal = new RunnerJournal(stateFile, this.generation);
    this.mcp = new RunnerMcp(
      url.replace(/^ws:/, "http:"),
      () => !!this.link?.connected,
      token,
    );
  }
  private async open(): Promise<Gateway> {
    if (this.gateway) return this.gateway;
    if (this.opening) return this.opening;
    const opening = (async () => {
      const entry =
        this.environment.ATRIUM_PI_ACP_ENTRY ||
        require.resolve("@liuser/pi-atrium/dist/index.js");
      const child = spawn(process.execPath, [entry], {
        env: {
          ...identityEnvironment(this.environment),
          PI_MCP_TOOL_EXPOSURE: "proxy-only",
          PI_ACP_PI_COMMAND:
            this.environment.PI_ACP_PI_COMMAND ||
            this.environment.ATRIUM_PI_BIN ||
            "pi",
        },
        stdio: "pipe",
      });
      child.stderr.on("data", (data: Buffer) => process.stderr.write(data));
      const connection = client({ name: "atrium-runner" })
        .onRequest("session/request_permission", () => ({
          outcome: { outcome: "cancelled" },
        }))
        .onNotification("session/update", () => undefined)
        .connect(
          ndJsonStream(
            Writable.toWeb(child.stdin),
            Readable.toWeb(
              child.stdout,
            ) as unknown as ReadableStream<Uint8Array>,
          ),
        );
      child.once("error", (error) => connection.close(error));
      const gateway = { connection, child };
      const timeout = setTimeout(
        () => connection.close(new Error("pi-atrium 初始化超时")),
        15_000,
      ).unref();
      try {
        const result = await connection.agent.request<{
          _meta?: Record<string, unknown>;
        }>("initialize", {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: "atrium-runner" },
        });
        if (
          !result._meta?.["pi-acp/runtime/v1"] ||
          !result._meta?.["pi-acp/identity/v1"]
        )
          throw new Error("pi-atrium 缺少 runtime/v1 或 identity/v1");
        if (this.stopped) throw new Error("运行器正在关闭");
        this.gateway = gateway;
        this.journal?.acp(child.pid!);
        void connection.closed
          .catch(() => undefined)
          .then(() => {
            if (this.gateway !== gateway) return;
            this.gateway = undefined;
            // The Web handshake reports this ACP PID. Reconnect before
            // accepting commands from a replacement child.
            if (!this.stopped) this.socket?.close(1011, "ACP restarted");
          });
        return gateway;
      } catch (error) {
        connection.close(
          error instanceof Error ? error : new Error(String(error)),
        );
        child.kill();
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    })();
    this.opening = opening;
    try {
      return await opening;
    } finally {
      this.opening = undefined;
    }
  }
  private async pollOne(runtime: {
    runtimeId: string;
    generation: string;
    sessionId: string;
  }) {
    const gateway = this.gateway;
    if (!gateway) return;
    for (let page = 0; page < 8; page++) {
      const events = runtimeEvents.parse(
        await gateway.connection.agent.request("_pi/runtime/events", {
          runtimeId: runtime.runtimeId,
          generation: runtime.generation,
          sessionId: runtime.sessionId,
          after: this.events.cursor(runtime.runtimeId, runtime.generation),
          limit: 100,
        }),
      );
      this.events.add(events);
      if (!events.hasMore) break;
    }
  }
  private async pollEvents() {
    if (this.polling || this.stopped || !this.gateway) return;
    this.polling = true;
    try {
      const result = await this.gateway.connection.agent.request(
        "_pi/runtime/list",
        {},
      );
      const { runtimes } = z
        .object({ runtimes: z.array(liveRuntimeSchema).max(256) })
        .parse(result);
      for (const runtime of runtimes) await this.pollOne(runtime);
      this.eventError = null;
    } catch {
      this.eventError = "运行器轨迹采集失败，可能存在缺口";
    } finally {
      this.polling = false;
    }
  }
  private async handle(method: string, payload: unknown) {
    if (method === "runner.heartbeat")
      return { generation: this.generation, eventError: this.eventError };
    if (method === "mcp.url") {
      const input = z
        .object({ agentId: z.string().regex(/^[a-zA-Z0-9-]+$/) })
        .parse(payload);
      return { url: this.mcp.url(input.agentId) };
    }
    if (method === "runner.reclaim") {
      const input = z
        .object({ agentId: z.string().uuid(), confirmStopped: z.boolean() })
        .strict()
        .parse(payload);
      return {
        status:
          (await this.journal?.reclaim(input.agentId, input.confirmStopped)) ??
          "unknown",
      };
    }
    if (method !== "acp.request") throw new Error("unsupported runner method");
    const input = payload as {
      agentId?: string;
      params?: { method?: string; params?: unknown };
    };
    const remoteMethod = input?.params?.method;
    if (
      !input?.agentId ||
      !remoteMethod ||
      !/^(?:_pi\/|session\/(?:new|load|close)$)/.test(remoteMethod)
    )
      throw new Error("invalid acp request");
    const gateway = await this.open();
    if (remoteMethod === "_pi/runtime/events") {
      const target = input.params?.params as {
        runtimeId: string;
        generation: string;
        sessionId: string;
        after: number;
        limit: number;
      };
      await this.pollOne(target);
      return this.events.page(
        target.runtimeId,
        target.generation,
        target.sessionId,
        target.after,
        target.limit,
      );
    }
    const params = input.params?.params ?? {};
    if (
      ["_pi/identity/start", "session/new", "session/load"].includes(
        remoteMethod,
      )
    )
      this.journal?.starting(input.agentId);
    const result = await gateway.connection.agent.request(remoteMethod, params);
    if (
      remoteMethod === "_pi/identity/stop" ||
      remoteMethod === "session/close"
    )
      this.journal?.stopped(input.agentId);
    if (["_pi/runtime/attach", "_pi/runtime/status"].includes(remoteMethod)) {
      const pid = (result as { pid?: unknown })?.pid;
      if (typeof pid === "number" && pid > 0)
        this.journal?.running(input.agentId, pid);
    }
    return result;
  }
  async run() {
    await this.open();
    await this.mcp.start(Number(this.environment.ATRIUM_RUNNER_MCP_PORT ?? 0));
    this.eventTimer = setInterval(() => void this.pollEvents(), 250);
    while (!this.stopped) {
      // The ACP child can die independently while the service is disconnected.
      // Reopen it before handshaking; pid=0 would otherwise be misread as 401.
      try {
        await this.open();
      } catch {
        if (!this.stopped)
          await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      if (this.stopped) break;
      const socket = new WebSocket(this.url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          "X-Atrium-Generation": this.generation,
          "X-Atrium-Acp-Pid": String(this.gateway?.child.pid ?? 0),
          "X-Atrium-Mcp-Port": new URL(this.mcp.url("a1")).port,
        },
      });
      this.socket = socket;
      try {
        await once(socket, "open");
        if (this.stopped) break;
        this.link = new RunnerLink(socket, (method, params) =>
          this.handle(method, params),
        );
        const statuses = Object.fromEntries(
          (this.journal?.priorAgents() ?? []).map((agentId) => [
            agentId,
            this.journal!.verdict(agentId),
          ]),
        );
        const recovered = await this.link.request<{ allRecovered: boolean }>(
          "runner.reconcile",
          {
            oldGeneration: this.journal?.oldGeneration() ?? null,
            defaultStatus: this.journal?.verdict("__unrecorded__") ?? "unknown",
            statuses,
          },
        );
        if (recovered.allRecovered) this.journal?.clearPrevious();
        await once(socket, "close");
      } catch (error) {
        if (
          error instanceof Error &&
          /Unexpected server response: (401|403)/.test(error.message)
        )
          throw new Error("运行器认证失败：请检查凭据文件与撤销状态");
        // The service may be upgrading. Keep the ACP child alive and reconnect.
      } finally {
        this.link?.close();
        this.link = undefined;
        socket.terminate();
        if (this.socket === socket) this.socket = undefined;
      }
      if (!this.stopped)
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  close() {
    this.stopped = true;
    if (this.eventTimer) clearInterval(this.eventTimer);
    this.link?.close();
    this.socket?.terminate();
    void this.mcp.close();
    this.gateway?.connection.close();
    this.gateway?.child.kill();
    this.journal?.close();
  }
}
