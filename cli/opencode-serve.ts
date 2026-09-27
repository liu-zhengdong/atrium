import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
export {
  AUTH_FILES,
  secretaryOpencodeHome,
  userOpencodeData,
  prepareOpencodeHome,
  opencodeEnvironment,
} from "../shared/opencode-home.ts";

/**
 * 秘书的 opencode：`opencode serve` + `opencode attach`。数据目录与凭据筛选
 * 在 shared/opencode-home.ts 中，供界面与后台恢复共用。
 */

export const newPassword = () => randomBytes(24).toString("base64url");

export type OpencodeServe = {
  url: string;
  /** 服务进程退出时带原因兑现。 */
  exited: Promise<string>;
  close(): void;
};

/** 起 `opencode serve`（只听 127.0.0.1、随机端口），等它报出地址。 */
export function startOpencodeServe(options: {
  command?: string;
  args?: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<OpencodeServe> {
  const command = options.command ?? "opencode";
  const args = options.args ?? [
    "serve",
    "--hostname",
    "127.0.0.1",
    "--port",
    "0",
  ];
  // 独立进程组：终端的 Ctrl-C 只给前台界面，退出时整组结束。
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let output = "";
  let tail = "";
  const close = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-child.pid!, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  };
  const exited = new Promise<string>((resolve) => {
    child.on("error", (error) => resolve(error.message));
    // close 在输出读完之后，stderr 最后一行已在 tail 里。
    child.on("close", (code, signal) =>
      resolve(
        `${command} serve 已退出（${signal ?? `退出码 ${code}`}）${
          tail.trim() ? `：${tail.trim().split("\n").at(-1)}` : ""
        }`,
      ),
    );
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    tail = (tail + chunk).slice(-4000);
  });
  child.stdout.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      close();
      reject(
        new Error(
          `等 ${command} serve 报出地址超时${tail.trim() ? `：${tail.trim().split("\n").at(-1)}` : ""}`,
        ),
      );
    }, options.timeoutMs ?? 30_000);
    const onData = (chunk: string) => {
      output = (output + chunk).slice(-4000);
      const found = /listening on (https?:\/\/[^\s]+)/.exec(output);
      if (!found) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      // 之后的输出照样读走，免得管道写满卡住服务。
      child.stdout.resume();
      resolve({ url: found[1]!.replace(/\/$/, ""), exited, close });
    };
    child.stdout.on("data", onData);
    void exited.then((reason) => {
      clearTimeout(timer);
      reject(new Error(reason));
    });
  });
}

export type OpencodeMessage = {
  info: { id: string; role: string; time?: { created?: number } };
  parts: { type: string; text?: string }[];
};

export class OpencodeHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** opencode 服务端接口里秘书会话用到的部分；directory 决定落在哪个项目实例。 */
export class OpencodeClient {
  private readonly auth: string | undefined;

  constructor(
    private readonly url: string,
    private readonly directory: string,
    password?: string,
  ) {
    this.auth = password
      ? `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
      : undefined;
  }

  async getSession(id: string): Promise<{ id: string } | undefined> {
    try {
      return await this.call("GET", `/session/${encodeURIComponent(id)}`);
    } catch (error) {
      if (error instanceof OpencodeHttpError && error.status === 404)
        return undefined;
      throw error;
    }
  }

  createSession(title: string) {
    return this.call<{ id: string }>("POST", "/session", { title });
  }

  /** 会话状态：一轮进行中（含重试等待）为 busy，否则 idle。 */
  async status(id: string): Promise<"idle" | "busy"> {
    const all = await this.call<Record<string, { type?: string }>>(
      "GET",
      "/session/status",
    );
    const type = all?.[id]?.type;
    return type === "busy" || type === "retry" ? "busy" : "idle";
  }

  /** 作为新一轮送入，立即返回；一轮进行中时由 opencode 排在之后。 */
  async prompt(id: string, text: string) {
    await this.call("POST", `/session/${encodeURIComponent(id)}/prompt_async`, {
      parts: [{ type: "text", text }],
    });
  }

  messages(id: string, limit: number) {
    return this.call<OpencodeMessage[]>(
      "GET",
      `/session/${encodeURIComponent(id)}/message`,
      undefined,
      { limit: String(limit) },
    );
  }

  /** 缺省模型（`提供商/模型`）；读不到时 undefined。 */
  async model(): Promise<string | undefined> {
    try {
      const config = await this.call<{ model?: unknown }>("GET", "/config");
      return typeof config?.model === "string" ? config.model : undefined;
    } catch {
      return undefined;
    }
  }

  /** 在 attach 的界面里弹提示；不碰输入框。 */
  async toast(message: string, variant: "info" | "warning" = "info") {
    await this.call("POST", "/tui/show-toast", {
      title: "Atrium",
      message,
      variant,
    });
  }

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
    query: Record<string, string> = {},
  ): Promise<T> {
    const search = new URLSearchParams({
      directory: this.directory,
      ...query,
    });
    const headers: Record<string, string> = {};
    if (this.auth) headers.authorization = this.auth;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${this.url}${path}?${search}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    if (!response.ok)
      throw new OpencodeHttpError(
        response.status,
        `opencode ${method} ${path}：HTTP ${response.status}${text ? ` ${text.slice(0, 200)}` : ""}`,
      );
    return (text ? JSON.parse(text) : undefined) as T;
  }
}
