import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { oauthOnly, planAuthFile, type Skipped } from "./opencode-auth.ts";

/**
 * 秘书的 opencode（#307 第 3 步）：`opencode serve` + `opencode attach`，Atrium 经服务端接口往同一会话送事件。
 *
 * 数据目录：秘书用独立的 `XDG_DATA_HOME`（`<ATRIUM_DATA>/secretary/opencode-home`），只从用户的
 * opencode 数据目录同步 API key 类凭据（auth.json、mcp-auth.json 里的非 OAuth 条目，见 opencode-auth.ts），
 * 不改用户原目录。opencode 执行者用用户
 * 原目录；同一数据目录的并发会死锁或 SQLITE_BUSY（上游 anomalyco/opencode#29395、#21215），
 * 分开后秘书常开也不挡执行者。不选互斥：秘书会话一开就是几个小时，互斥等于期间 opencode 执行者全停。
 * 配置（`~/.config/opencode`）与状态目录不变，用户的模型、权限、插件设置照常生效。
 */

/** 从用户 opencode 数据目录按条目同步过来的凭据文件（只带 API key 类，见 opencode-auth.ts）。 */
export const AUTH_FILES = ["auth.json", "mcp-auth.json"] as const;

/** 秘书数据目录里记「上次从用户那边同步了哪些条目」的文件。 */
const SYNCED = "atrium-synced.json";

/** 秘书 opencode 的 XDG_DATA_HOME。 */
export function secretaryOpencodeHome(data: string) {
  return join(data, "secretary", "opencode-home");
}

/** 用户自己的 opencode 数据目录（opencode 按 XDG 规范取 `$XDG_DATA_HOME/opencode`）。 */
export function userOpencodeData(env: NodeJS.ProcessEnv = process.env) {
  return join(
    resolve(env.XDG_DATA_HOME || join(homedir(), ".local", "share")),
    "opencode",
  );
}

const real = (path: string) => (existsSync(path) ? realpathSync(path) : path);

const readText = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

function readSynced(path: string): Record<string, string[]> {
  try {
    const value: unknown = JSON.parse(readText(path) ?? "{}");
    if (typeof value !== "object" || value === null) return {};
    const result: Record<string, string[]> = {};
    for (const [file, names] of Object.entries(value))
      if (Array.isArray(names))
        result[file] = names.filter((name) => typeof name === "string");
    return result;
  } catch {
    return {};
  }
}

export type HomeReport = {
  /** 内容有变、重写了的文件。 */
  written: string[];
  /** 秘书用不上的提供商（用户那边只有 OAuth）。 */
  oauthOnly: string[];
  /** 没带过来的 MCP 登录。 */
  mcpSkipped: Skipped[];
  problems: string[];
};

/**
 * 备好秘书的数据目录：按条目从用户那边同步 API key 类凭据，OAuth 不带（opencode-auth.ts）。
 * 用户目录只读；秘书那份坏了挪到 `.bad-<时间>` 再重建。两边指向同一目录时什么都不做。
 */
export function prepareOpencodeHome(home: string, source: string): HomeReport {
  const report: HomeReport = {
    written: [],
    oauthOnly: [],
    mcpSkipped: [],
    problems: [],
  };
  const target = join(home, "opencode");
  mkdirSync(target, { recursive: true, mode: 0o700 });
  if (real(target) === real(source)) return report;
  const syncedPath = join(home, SYNCED);
  const synced = readSynced(syncedPath);
  const next: Record<string, string[]> = {};
  for (const name of AUTH_FILES) {
    const to = join(target, name);
    let from: string | undefined;
    try {
      from = readText(join(source, name));
    } catch (error) {
      report.problems.push(
        `读不了用户的 opencode ${name}（${(error as NodeJS.ErrnoException).code ?? "未知错误"}），这次不同步`,
      );
      next[name] = synced[name] ?? [];
      continue;
    }
    const current = readText(to);
    const plan = planAuthFile(name, from, current, synced[name]);
    report.problems.push(...plan.problems);
    next[name] = plan.synced;
    if (name === "auth.json") report.oauthOnly = oauthOnly(plan);
    else report.mcpSkipped = plan.skipped;
    if (plan.content === undefined || plan.content === current) continue;
    if (current !== undefined && plan.problems.length)
      renameSync(to, `${to}.bad-${Date.now()}`);
    writeFileSync(`${to}.tmp`, plan.content, { mode: 0o600 });
    chmodSync(`${to}.tmp`, 0o600);
    renameSync(`${to}.tmp`, to);
    report.written.push(name);
  }
  writeFileSync(syncedPath, `${JSON.stringify(next)}\n`, { mode: 0o600 });
  return report;
}

/**
 * 拉起 serve 与 attach 的环境：在去掉 HERDR_* 等的基础上（见 acp.ts agentEnvironment）
 * 换成秘书的数据目录；有密码时服务端要求 basic 认证，attach 从同名环境变量读，不进命令行参数。
 */
export function opencodeEnvironment(
  base: NodeJS.ProcessEnv,
  options: { home: string; password?: string },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, XDG_DATA_HOME: options.home };
  delete env.OPENCODE_SERVER_USERNAME;
  delete env.OPENCODE_SERVER_PASSWORD;
  if (options.password) env.OPENCODE_SERVER_PASSWORD = options.password;
  return env;
}

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
