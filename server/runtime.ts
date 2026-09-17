import { spawn, type ChildProcess } from "node:child_process";
import { openSync, closeSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  client,
  PROTOCOL_VERSION,
  type ClientConnection,
} from "@agentclientprotocol/sdk";
import { z } from "zod";
import type { WebSocket } from "ws";
import { acpStream } from "../shared/stream.ts";
import type { RuntimeInfo } from "../shared/schema.ts";
import { Store, Problem } from "./store.ts";

const infoSchema = z
  .object({
    pid: z.number().int().positive(),
    session_id: z.string().min(1),
    session_file: z.string().nullable(),
    cwd: z.string(),
    mode: z.string(),
    busy: z.boolean(),
    model: z.string(),
  })
  .strict();
const root = fileURLToPath(new URL("../", import.meta.url));
async function rpc<T>(
  connection: ClientConnection,
  method: string,
  params: unknown,
): Promise<T> {
  const deadline = setTimeout(
    () => connection.close(new Error(`ACP ${method} 超时`)),
    5000,
  ).unref();
  try {
    return await connection.agent.request<T>(method, params);
  } finally {
    clearTimeout(deadline);
  }
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
export class Runtimes {
  readonly connections = new Map<
    string,
    { connection: ClientConnection; info: RuntimeInfo }
  >();
  readonly errors = new Map<string, string>();
  private children = new Map<string, ChildProcess>();
  private pumping = new Set<string>();
  private connecting = new Set<string>();
  private starts = new Map<string, { at: number; failures: number }>();
  private interval: NodeJS.Timeout;
  constructor(
    private store: Store,
    private data: string,
    private changed: () => void,
  ) {
    this.interval = setInterval(() => {
      void this.tick();
    }, 3000).unref();
  }
  async accept(id: string, socket: WebSocket) {
    if (this.connections.has(id) || this.connecting.has(id)) {
      socket.close(1008, "Agent 已连接");
      return;
    }
    this.connecting.add(id);
    const connection = client({ name: "atrium" })
      .onRequest("session/request_permission", () => ({
        outcome: { outcome: "cancelled" },
      }))
      .onNotification("session/update", () => undefined)
      .connect(acpStream(socket));
    try {
      const result = await rpc<{ _meta?: Record<string, unknown> }>(
        connection,
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: "atrium" },
        },
      );
      if (!result._meta?.["atrium/v1"])
        throw new Error("Pi 缺少 Atrium 原会话桥接能力");
      const info = infoSchema.parse(
        await rpc(connection, "_atrium/status", {}),
      );
      if (resolve(info.cwd) !== resolve(this.store.agent(id).cwd))
        throw new Error("Pi 工作目录与 Agent 配置不一致");
      await rpc(connection, "session/load", {
        sessionId: info.session_id,
        cwd: info.cwd,
        mcpServers: [],
      });
      this.store.run(
        "UPDATE agents SET session_file=?,runtime_pid=? WHERE id=?",
        info.session_file,
        info.pid,
        id,
      );
      this.connections.set(id, { connection, info });
      this.errors.delete(id);
      this.starts.delete(id);
      this.changed();
      void connection.closed
        .catch(() => undefined)
        .then(() => {
          if (this.connections.get(id)?.connection === connection) {
            this.connections.delete(id);
            this.changed();
          }
        });
      await this.pump(id);
    } catch (error) {
      this.errors.set(
        id,
        error instanceof Error ? error.message : String(error),
      );
      connection.close();
      socket.close();
      this.changed();
    } finally {
      this.connecting.delete(id);
    }
  }
  start(id: string, automatic = false) {
    const agent = this.store.agent(id);
    if (this.connections.has(id) || this.children.has(id))
      throw new Problem(409, "Agent 已在运行或正在启动");
    const pid = this.store.one<{ runtime_pid: number | null }>(
      "SELECT runtime_pid FROM agents WHERE id=?",
      id,
    )?.runtime_pid;
    if (pid && alive(pid))
      throw new Problem(409, "原 Pi 进程仍存在，等待重连；不会另开同一会话");
    const last = this.starts.get(id);
    if (
      automatic &&
      last &&
      (Date.now() - last.at < 60000 || last.failures >= 3)
    )
      return;
    const folder = join(this.data, "agents", id);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const link = join(this.data, "links", `${id}.json`);
    if (!existsSync(link))
      throw new Problem(409, "连接文件缺失，请重新创建 Agent");
    const sessionFile = agent.session_file ?? join(folder, "session.jsonl");
    const log = openSync(join(folder, "runtime.log"), "a", 0o600);
    const child = spawn(
      process.env.ATRIUM_PI_BIN || "pi",
      [
        "--mode",
        "rpc",
        "--session",
        sessionFile,
        "--extension",
        join(root, "pi/extension.ts"),
        "--atrium-link",
        link,
      ],
      {
        cwd: agent.cwd,
        env: { ...process.env, PI_MCP_TOOL_EXPOSURE: "proxy-only" },
        stdio: ["pipe", log, log],
        detached: false,
      },
    );
    closeSync(log);
    this.children.set(id, child);
    this.errors.delete(id);
    this.starts.set(id, {
      at: Date.now(),
      failures: automatic ? (last?.failures ?? 0) + 1 : 1,
    });
    if (child.pid)
      this.store.run(
        "UPDATE agents SET runtime_pid=?,session_file=? WHERE id=?",
        child.pid,
        sessionFile,
        id,
      );
    const ended = (message: string) => {
      if (this.children.get(id) === child) this.children.delete(id);
      this.errors.set(id, message);
      this.changed();
    };
    child.once("error", (error) => ended(error.message));
    child.once("exit", (code, signal) =>
      ended(
        `Pi 已退出（${signal ?? code}），日志：${join(folder, "runtime.log")}`,
      ),
    );
    this.changed();
  }
  async pump(id: string) {
    if (this.pumping.has(id)) return;
    this.pumping.add(id);
    try {
      const runtime = this.connections.get(id);
      if (!runtime) {
        if (
          this.store.pending(id).length &&
          this.store.agent(id).config.auto_start
        ) {
          try {
            this.start(id, true);
          } catch (error) {
            this.errors.set(
              id,
              error instanceof Error ? error.message : String(error),
            );
          }
        }
        return;
      }
      runtime.info = infoSchema.parse(
        await rpc(runtime.connection, "_atrium/status", {}),
      );
      for (const pending of this.store.pending(id)) {
        if (pending.kind === "summary" && runtime.info.busy) continue;
        try {
          const result = await rpc<{ accepted: boolean }>(
            runtime.connection,
            "_atrium/deliver",
            {
              id: pending.id,
              session_id: runtime.info.session_id,
              kind: pending.kind,
              text: pending.text,
            },
          );
          if (!result.accepted) throw new Error("Pi 未确认接收");
          this.store.accepted(pending.id);
          this.changed();
        } catch (error) {
          this.store.deliveryError(pending.id, String(error));
          break;
        }
      }
    } catch (error) {
      this.errors.set(id, String(error));
    } finally {
      this.pumping.delete(id);
    }
  }
  private async tick() {
    const scheduled = this.store.schedule();
    if (scheduled.length) this.changed();
    await Promise.all(
      this.store.agents().map(async (agent) => {
        const before = JSON.stringify(this.connections.get(agent.id)?.info);
        await this.pump(agent.id);
        if (before !== JSON.stringify(this.connections.get(agent.id)?.info))
          this.changed();
      }),
    );
  }
  close() {
    clearInterval(this.interval);
    for (const runtime of this.connections.values()) runtime.connection.close();
    for (const child of this.children.values()) child.kill("SIGTERM");
  }
}
