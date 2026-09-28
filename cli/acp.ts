import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { killTree, spawnCommand } from "../server/platform/index.ts";

/**
 * 最小 ACP（Agent Client Protocol）客户端：换行分隔的 JSON-RPC 2.0，经 stdio 与 Agent 进程通信。
 * 只实现秘书会话用到的部分：initialize、session/new、session/load、session/prompt、session/cancel，
 * 接收 session/update 通知与 session/request_permission 请求。客户端不声明 fs、terminal 能力，
 * 读写文件与跑命令由 Agent 用自己的工具完成。
 */

export type AcpUpdate = { sessionUpdate: string; [key: string]: unknown };
export type PermissionOption = {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
};
export type PermissionRequest = {
  sessionId: string;
  toolCall: { toolCallId?: string; title?: string; [key: string]: unknown };
  options: PermissionOption[];
};
export type PermissionOutcome =
  { outcome: "selected"; optionId: string } | { outcome: "cancelled" };
export type StopReason =
  "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

export type AcpHandlers = {
  update(sessionId: string, update: AcpUpdate): void;
  permission(request: PermissionRequest): Promise<PermissionOutcome>;
  /** Agent 进程退出（含启动失败）。 */
  exit(reason: string): void;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

class AcpError extends Error {}

/** 非交互拉起：去掉 HERDR_*（opencode 的 herdr 插件会连继承来的窗格、卡在 init）与嵌套会话标记。 */
export function agentEnvironment(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base))
    if (
      value !== undefined &&
      !key.startsWith("HERDR_") &&
      !key.startsWith("CLAUDE_CODE_") &&
      key !== "CLAUDECODE" &&
      !key.startsWith("PI_") &&
      !/_(API_KEY|TOKEN)$/.test(key) &&
      !/^(ANTHROPIC|OPENAI|CLAUDE|GH|GITHUB)_/.test(key) &&
      key !== "NODE_TEST_CONTEXT"
    )
      env[key] = value;
  return env;
}

export class AcpConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = "";
  private stderr = "";
  private exited: string | null = null;

  constructor(
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
    private readonly handlers: AcpHandlers,
  ) {
    // 独立进程组：终端的 Ctrl-C 由聊天界面处理（取消本轮），退出时整组结束。
    this.child = spawnCommand(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    }) as ChildProcessWithoutNullStreams;
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.read(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
    });
    this.child.stdin.on("error", () => {});
    this.child.on("error", (error) => this.finish(error.message));
    this.child.on("exit", (code, signal) =>
      this.finish(
        `${command} 已退出（${signal ?? `退出码 ${code}`}）${
          this.stderr.trim() ? `：${this.stderr.trim().split("\n").at(-1)}` : ""
        }`,
      ),
    );
  }

  get alive() {
    return this.exited === null;
  }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.exited) return Promise.reject(new AcpError(this.exited));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown) {
    if (!this.exited) this.write({ jsonrpc: "2.0", method, params });
  }

  close() {
    if (this.exited) return;
    if (this.child.pid) killTree(this.child.pid, "SIGTERM");
    else this.child.kill("SIGTERM");
  }

  private write(message: unknown) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private finish(reason: string) {
    if (this.exited) return;
    this.exited = reason;
    for (const { reject } of this.pending.values())
      reject(new AcpError(reason));
    this.pending.clear();
    this.handlers.exit(reason);
  }

  private read(chunk: string) {
    this.buffer += chunk;
    for (;;) {
      const end = this.buffer.indexOf("\n");
      if (end < 0) return;
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      let message: {
        id?: number | string;
        method?: string;
        params?: unknown;
        result?: unknown;
        error?: { message?: string };
      };
      try {
        message = JSON.parse(line);
      } catch {
        continue; // 非协议输出（日志等）忽略
      }
      if (message.method !== undefined) this.incoming(message);
      else if (typeof message.id === "number") {
        const waiter = this.pending.get(message.id);
        if (!waiter) continue;
        this.pending.delete(message.id);
        if (message.error)
          waiter.reject(new AcpError(message.error.message ?? "ACP 请求失败"));
        else waiter.resolve(message.result);
      }
    }
  }

  private incoming(message: {
    id?: number | string;
    method?: string;
    params?: unknown;
  }) {
    const { id, method, params } = message;
    if (method === "session/update") {
      const value = params as { sessionId: string; update: AcpUpdate };
      if (value?.update) this.handlers.update(value.sessionId, value.update);
      return;
    }
    if (id === undefined) return;
    if (method === "session/request_permission") {
      this.handlers
        .permission(params as PermissionRequest)
        .catch((): PermissionOutcome => ({ outcome: "cancelled" }))
        .then((outcome) =>
          this.write({ jsonrpc: "2.0", id, result: { outcome } }),
        );
      return;
    }
    // 未声明的客户端能力（fs、terminal 等）一律回「方法不存在」。
    this.write({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `不支持：${method}` },
    });
  }
}
