import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  existsSync,
  renameSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";
import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientConnection,
} from "@agentclientprotocol/sdk";
import { z } from "zod";
import {
  runtimeSchema,
  type RuntimeInfo,
  type LiveRuntime,
} from "../shared/schema.ts";
import { Store, Problem } from "./store.ts";
import { atriumGuide } from "./mcp.ts";

const require = createRequire(import.meta.url);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};
type Binding = {
  runtime_id: string | null;
  runtime_pid: number | null;
  acp_session_id: string | null;
  session_file: string | null;
};
type Gateway = {
  connection: ClientConnection;
  child: ChildProcessWithoutNullStreams;
  closed: Promise<void>;
  stopping?: Promise<void>;
};
const target = (r: RuntimeInfo) => ({
  runtimeId: r.runtimeId,
  generation: r.generation,
  sessionId: r.sessionId,
});
const guideId = (agent: string, session: string) => {
  const h = createHash("sha256")
    .update(`${agent}:${session}:guide:v1`)
    .digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

/** Business-side ACP client. Pi processes, IPC discovery and native context belong to pi-acp. */
export class Runtimes {
  readonly connections = new Map<
    string,
    { connection: ClientConnection; info: RuntimeInfo }
  >();
  readonly errors = new Map<string, string>();
  private gateway?: Gateway;
  private gateways = new Set<Gateway>();
  private opening?: Promise<Gateway>;
  private connecting = new Map<string, Promise<void>>();
  private bindingOwners = new Map<string, string>();
  private pumping = new Map<string, Promise<void>>();
  private starts = new Map<string, { at: number; failures: number }>();
  private stopped = false;
  private interval: NodeJS.Timeout;
  constructor(
    private store: Store,
    private data: string,
    private changed: () => void,
    private baseUrl: () => string,
  ) {
    mkdirSync(join(data, "credentials"), { recursive: true, mode: 0o700 });
    this.interval = setInterval(() => {
      void this.tick();
    }, 3000).unref();
  }
  private binding(id: string) {
    this.store.agent(id);
    return this.store.one<Binding>(
      "SELECT runtime_id,runtime_pid,acp_session_id,session_file FROM agents WHERE id=?",
      id,
    )!;
  }
  private assertOpen() {
    if (this.stopped) throw new Error("Atrium 正在关闭");
  }
  private async open(): Promise<Gateway> {
    this.assertOpen();
    if (this.gateway) return this.gateway;
    if (this.opening) return this.opening;
    const opening = (async () => {
      const entry =
        process.env.ATRIUM_PI_ACP_ENTRY ||
        require.resolve("@liuser/pi-acp/dist/index.js");
      const child = spawn(process.execPath, [entry], {
        env: {
          ...process.env,
          PI_MCP_TOOL_EXPOSURE: "proxy-only",
          PI_ACP_PI_COMMAND:
            process.env.PI_ACP_PI_COMMAND || process.env.ATRIUM_PI_BIN || "pi",
        },
        stdio: "pipe",
      });
      // Keep provider/adapter diagnostics local; never forward credentials or RPC payloads to the UI.
      child.stderr.on("data", (data: Buffer) => process.stderr.write(data));
      const connection = client({ name: "atrium" })
        .onRequest("session/request_permission", () => ({
          outcome: { outcome: "cancelled" },
        }))
        .onNotification("session/update", () => undefined)
        .connect(
          ndJsonStream(
            Writable.toWeb(child.stdin),
            // Node/DOM BYOB declarations differ; this is the native byte Web Stream.
            Readable.toWeb(
              child.stdout,
            ) as unknown as ReadableStream<Uint8Array>,
          ),
        );
      child.once("error", (error) => connection.close(error));
      const closed = new Promise<void>((resolve) => {
        child.once("close", () => resolve());
      });
      const gateway: Gateway = { connection, child, closed };
      this.gateways.add(gateway);
      void closed.then(() => this.gateways.delete(gateway));
      void connection.closed
        .catch(() => undefined)
        .then(() => this.stopGateway(gateway));
      const timeout = setTimeout(
        () => connection.close(new Error("pi-acp 初始化超时")),
        15000,
      ).unref();
      try {
        const result = await connection.agent.request<{
          _meta?: Record<string, unknown>;
        }>("initialize", {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: "atrium" },
        });
        if (!result._meta?.["pi-acp/runtime/v1"])
          throw new Error(
            "pi-acp 缺少 runtime/v1 能力，请更新到本项目要求的版本",
          );
        this.assertOpen();
        this.gateway = gateway;
        void connection.closed
          .catch(() => undefined)
          .then(() => {
            if (this.gateway !== gateway) return;
            this.gateway = undefined;
            for (const [id, entry] of this.connections)
              if (entry.connection === connection) {
                this.connections.delete(id);
                if (!this.stopped)
                  this.errors.set(id, "pi-acp 连接断开，正在等待重连");
              }
            this.changed();
          });
        return gateway;
      } catch (error) {
        await this.stopGateway(gateway);
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    })();
    this.opening = opening;
    try {
      return await opening;
    } finally {
      if (this.opening === opening) this.opening = undefined;
    }
  }
  private async rpc<T = Record<string, unknown>>(
    method: string,
    params: unknown,
  ): Promise<T> {
    const { connection } = await this.open();
    return connection.agent.request<T>(method, params);
  }
  async available(): Promise<LiveRuntime[]> {
    const { runtimes } = await this.rpc<{ runtimes: LiveRuntime[] }>(
      "_pi/runtime/list",
      {},
    );
    const rows = this.store.all<{ id: string; runtime_id: string | null }>(
      "SELECT id,runtime_id FROM agents",
    );
    return runtimes
      .filter((r) => r.mode === "tui")
      .map((r) => ({
        ...r,
        bound_agent: rows.find((a) => a.runtime_id === r.runtimeId)?.id ?? null,
      }));
  }
  private services(id: string) {
    const path = join(this.data, "credentials", `${id}.json`);
    if (!existsSync(path)) {
      // Existing installation: keep the credential, move its old transport file out of the retired links directory.
      const legacy = join(this.data, "links", `${id}.json`);
      const value = z
        .object({ agent_id: z.literal(id), token: z.string().min(32).max(128) })
        .parse(JSON.parse(readFileSync(legacy, "utf8")));
      if (!this.store.authenticate(id, value.token))
        throw new Error("旧凭据与 Agent 不一致");
      renameSync(legacy, path);
    }
    const { token } = z
      .object({ token: z.string().min(32).max(128) })
      .parse(JSON.parse(readFileSync(path, "utf8")));
    if (!this.store.authenticate(id, token)) throw new Error("Agent 凭据无效");
    return [
      {
        name: "atrium",
        type: "http",
        url: `${this.baseUrl()}/mcp/${id}`,
        headers: [{ name: "Authorization", value: `Bearer ${token}` }],
      },
    ];
  }
  private remember(id: string, info: RuntimeInfo) {
    const previous = this.binding(id);
    if (
      previous.runtime_id === info.runtimeId &&
      previous.runtime_pid === info.pid &&
      previous.acp_session_id === info.sessionId &&
      previous.session_file === info.sessionFile
    )
      return;
    this.store.run(
      "UPDATE agents SET runtime_id=?,runtime_pid=?,acp_session_id=?,session_file=? WHERE id=?",
      info.runtimeId,
      info.pid,
      info.sessionId,
      info.sessionFile,
      id,
    );
  }
  private async bind(
    id: string,
    selector: { runtimeId: string } | { sessionId: string },
  ) {
    const selected = "runtimeId" in selector ? selector.runtimeId : undefined;
    if (selected) {
      if (
        (this.bindingOwners.has(selected) &&
          this.bindingOwners.get(selected) !== id) ||
        this.store.one(
          "SELECT id FROM agents WHERE runtime_id=? AND id<>?",
          selected,
          id,
        )
      )
        throw new Problem(409, "这个 Pi 已绑定或正在接入另一个 Agent");
      this.bindingOwners.set(selected, id);
    }
    let info: RuntimeInfo | undefined;
    try {
      info = runtimeSchema.parse(
        await this.rpc("_pi/runtime/attach", selector),
      );
      if (realpathSync(info.cwd) !== realpathSync(this.store.agent(id).cwd))
        throw new Problem(409, "Pi 工作目录与 Agent 配置不一致");
      if (
        this.store.one(
          "SELECT id FROM agents WHERE runtime_id=? AND id<>?",
          info.runtimeId,
          id,
        )
      )
        throw new Problem(409, "这个 Pi 已绑定另一个 Agent");
      await this.rpc("_pi/runtime/mcp", {
        ...target(info),
        mcpServers: this.services(id),
      });
      await this.rpc("_pi/runtime/deliver", {
        ...target(info),
        id: guideId(id, info.sessionId),
        source: "Atrium 接入说明",
        text: atriumGuide,
        delivery: "steer",
        triggerTurn: false,
      });
      this.assertOpen();
      this.remember(id, info);
      this.connections.set(id, { connection: this.gateway!.connection, info });
      this.errors.delete(id);
      this.changed();
    } catch (error) {
      if (info)
        await this.rpc("_pi/runtime/detach", target(info)).catch(
          () => undefined,
        );
      throw error;
    } finally {
      if (selected && this.bindingOwners.get(selected) === id)
        this.bindingOwners.delete(selected);
    }
  }
  private async operation(id: string, run: () => Promise<void>) {
    this.assertOpen();
    if (this.connecting.has(id))
      throw new Problem(409, "Agent 正在接入，请稍候");
    const promise = run().catch((error) => {
      if (!this.stopped) {
        this.errors.set(id, String(error));
        this.changed();
      }
      throw error;
    });
    this.connecting.set(id, promise);
    try {
      await promise;
    } finally {
      this.connecting.delete(id);
    }
  }
  async attach(id: string, runtimeId: string) {
    this.store.agent(id);
    if (this.connections.has(id)) throw new Problem(409, "Agent 已连接");
    await this.operation(id, () => this.bind(id, { runtimeId }));
    await this.pump(id);
  }
  async start(id: string, automatic = false) {
    const agent = this.store.agent(id),
      binding = this.binding(id);
    if (this.connections.has(id)) throw new Problem(409, "Agent 已在运行");
    if (binding.runtime_pid && alive(binding.runtime_pid))
      throw new Problem(409, "原 Pi 进程仍存在，等待重连；不会另开同一会话");
    const last = this.starts.get(id);
    if (
      automatic &&
      last &&
      (Date.now() - last.at < 60000 || last.failures >= 3)
    )
      return;
    this.starts.set(id, {
      at: Date.now(),
      failures: automatic ? (last?.failures ?? 0) + 1 : 1,
    });
    await this.operation(id, async () => {
      let sessionId = binding.acp_session_id;
      if (!sessionId && binding.session_file) {
        ({ sessionId } = await this.rpc<{ sessionId: string }>(
          "_pi/session/import",
          { cwd: agent.cwd, sessionFile: binding.session_file },
        ));
        this.store.run(
          "UPDATE agents SET acp_session_id=? WHERE id=?",
          sessionId,
          id,
        );
      }
      if (sessionId)
        await this.rpc("session/load", {
          sessionId,
          cwd: agent.cwd,
          mcpServers: this.services(id),
        });
      else
        ({ sessionId } = await this.rpc<{ sessionId: string }>("session/new", {
          cwd: agent.cwd,
          mcpServers: this.services(id),
        }));
      try {
        await this.bind(id, { sessionId });
      } catch (error) {
        await this.rpc("session/close", { sessionId }).catch(() => undefined);
        throw error;
      }
    });
    if (!this.pumping.has(id)) await this.pump(id);
  }
  pump(id: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const existing = this.pumping.get(id);
    if (existing) return existing;
    const promise = this.doPump(id).finally(() => this.pumping.delete(id));
    this.pumping.set(id, promise);
    return promise;
  }
  private async doPump(id: string) {
    try {
      if (this.connecting.has(id)) return;
      let runtime = this.connections.get(id);
      if (!runtime) {
        const binding = this.binding(id);
        if (
          binding.runtime_id &&
          binding.runtime_pid &&
          alive(binding.runtime_pid)
        ) {
          await this.operation(id, () =>
            this.bind(id, { runtimeId: binding.runtime_id! }),
          );
          runtime = this.connections.get(id);
        } else {
          if (
            this.store.pending(id).length &&
            this.store.agent(id).config.auto_start
          )
            await this.start(id, true);
          runtime = this.connections.get(id);
        }
      }
      if (!runtime) return;
      try {
        runtime.info = runtimeSchema.parse(
          await this.rpc("_pi/runtime/status", target(runtime.info)),
        );
        this.assertOpen();
        this.remember(id, runtime.info);
      } catch (error) {
        await this.rpc("_pi/runtime/detach", target(runtime.info)).catch(
          () => undefined,
        );
        this.connections.delete(id);
        throw error;
      }
      for (const pending of this.store.pending(id)) {
        if (pending.kind === "summary" && runtime.info.busy) continue;
        try {
          const result = await this.rpc<{ accepted: boolean }>(
            "_pi/runtime/deliver",
            {
              ...target(runtime.info),
              id: pending.id,
              source: "Atrium",
              text: pending.text,
              delivery: pending.kind === "direct" ? "steer" : "followUp",
            },
          );
          this.assertOpen();
          if (!result.accepted) throw new Error("Pi 未确认接收");
          this.store.accepted(pending.id);
          this.changed();
        } catch (error) {
          if (!this.stopped)
            this.store.deliveryError(pending.id, String(error));
          break;
        }
      }
    } catch (error) {
      if (!this.stopped) {
        this.errors.set(id, String(error));
        this.changed();
      }
    }
  }
  private async tick() {
    if (this.stopped) return;
    if (this.store.schedule().length) this.changed();
    await Promise.all(
      this.store.agents().map(async (agent) => {
        const before = JSON.stringify(this.connections.get(agent.id)?.info);
        await this.pump(agent.id);
        if (before !== JSON.stringify(this.connections.get(agent.id)?.info))
          this.changed();
      }),
    );
  }
  private stopGateway(gateway: Gateway): Promise<void> {
    if (gateway.stopping) return gateway.stopping;
    gateway.stopping = (async () => {
      gateway.connection.close();
      gateway.child.stdin.end();
      const terminate = setTimeout(
        () => gateway.child.kill("SIGTERM"),
        14000,
      ).unref();
      const force = setTimeout(
        () => gateway.child.kill("SIGKILL"),
        17000,
      ).unref();
      try {
        await gateway.closed;
      } finally {
        clearTimeout(terminate);
        clearTimeout(force);
      }
    })();
    return gateway.stopping;
  }
  async close() {
    this.stopped = true;
    clearInterval(this.interval);
    await Promise.allSettled([
      ...this.pumping.values(),
      ...this.connecting.values(),
      ...(this.opening ? [this.opening] : []),
      ...[...this.gateways].map((gateway) => this.stopGateway(gateway)),
    ]);
  }
}
