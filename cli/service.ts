import {
  alive,
  dataDirectory,
  readService,
  serviceUrl,
  type ServiceRecord,
} from "../server/service-state.ts";
import { startService } from "../server/service.ts";
import { restartInProgress } from "../server/supervisor.ts";
import { Problem } from "../server/problem.ts";
import { localFetch, type LocalResponse } from "../server/local-http.ts";
import { recordResult } from "./contract.ts";
import { leaderSession, WORKER_FLAG, workerGuard } from "./worker-guard.ts";
import { requireUserAuthService, userBearer } from "./auth.ts";
import { missingRoute, outdatedServiceAt } from "./version-check.ts";

export type Client = ReturnType<typeof client>;

/**
 * 连上 Atrium 服务；没在跑就在后台拉起，不开浏览器。
 * 能力定义只在服务这一份，命令行不直接开数据库，改动才会经过投递与唤醒。
 */
export async function connect(quietStart = false): Promise<Client> {
  workerGuard();
  // leader 进程：以本次唤醒的令牌直连服务，不拉起、不读用户令牌，服务重启时不重发。
  const leader = leaderSession();
  if (leader) return client(leader.url, "", undefined, leader.bearer);
  const data = dataDirectory();
  const before = readService(data);
  const restarting = restartInProgress(data);
  const record = await startService(data).catch((error: unknown) => {
    // 端口被别的数据目录或程序占着（t71）：原样报，不附本数据目录的日志与 status 修正。
    if (error instanceof Problem) throw error;
    throw new Problem(
      503,
      error instanceof Error ? error.message : String(error),
      "service_unavailable",
    );
  });
  await requireUserAuthService(record);
  if (!quietStart && restarting)
    console.error(`Atrium 已重启，命令发往新服务 · PID ${record.pid}`);
  else if (!quietStart && (!before || before.pid !== record.pid))
    console.error(
      `Atrium 服务已在后台启动 · PID ${record.pid} · ${serviceUrl(record)} · 停止：atrium stop`,
    );
  let current = record;
  return client(serviceUrl(record), data, async (error) => {
    if (!resendable(error, data, current)) return null;
    current = await startService(data);
    return serviceUrl(current);
  });
}

/** 服务在跑才连上，不在跑返回 null、不拉起（状态栏这类随手刷新的读命令用）。 */
export function connectRunning(): Client | null {
  workerGuard();
  const leader = leaderSession();
  if (leader) return client(leader.url, "", undefined, leader.bearer);
  const data = dataDirectory();
  const record = readService(data);
  if (!record || !alive(record.pid)) return null;
  return client(serviceUrl(record), data);
}

/**
 * 取资料（material get）用：执行者环境里没有隔离实例时，连用户正在跑的服务（只读、不拉起）；
 * 其余照常 connect。见 worker-guard.ts 的 workerReadable。
 */
export async function connectForRead(): Promise<Client> {
  try {
    workerGuard();
  } catch (error) {
    if (process.env[WORKER_FLAG] !== "1") throw error;
    const data = dataDirectory();
    const record = readService(data);
    if (!record || !alive(record.pid))
      throw new Problem(
        503,
        "Atrium 服务没在跑，取不到资料；这台机器上没有 Atrium 服务时请在任务汇报里说明缺这份资料",
        "service_unavailable",
      );
    return client(serviceUrl(record), data);
  }
  return connect();
}

const causeCode = (error: unknown) =>
  (error as { cause?: { code?: unknown } } | undefined)?.cause?.code;

// 连接被断开的底层套接字错误：对端重置、写到已关的连接、套接字已失效（socket hang up 的 code 也是 ECONNRESET）。
const DISCONNECTED = new Set([
  "ECONNRESET",
  "EPIPE",
  "EINVAL",
  "ENOTCONN",
  "UND_ERR_SOCKET",
]);

/**
 * 请求没被服务处理、可以重发（#262 重启窗口）：
 * - 连接被拒：旧服务已关、新服务还没起来，请求根本没送到；
 * - 连接被断开且服务正在重启或已换人：服务关闭时会等在处理的请求回完再关，
 *   没拿到响应就被断开的是刚建立就被关掉的连接，请求没被处理。
 *   请求走 node:http（server/local-http.ts），这类断开以错误交回而不是让进程崩溃。
 */
export function resendable(
  error: unknown,
  data: string,
  record: ServiceRecord,
) {
  const code = causeCode(error);
  if (code === "ECONNREFUSED") return true;
  if (typeof code !== "string" || !DISCONNECTED.has(code)) return false;
  const now = readService(data);
  return (
    !!restartInProgress(data) ||
    !alive(record.pid) ||
    now?.instance !== record.instance
  );
}

// 导出供测试直连内存服务（connect 会拉起独立服务进程）。
// reconnect：请求没被处理就断开时（重启窗口）等服务就绪，返回新地址，请求重发一次；返回 null 不重发。
export function client(
  base: string,
  data: string,
  reconnect?: (error: unknown) => Promise<string | null>,
  bearer?: string,
) {
  // 不是 async：令牌缺失（auth_required）同步抛出，不被下面当成连接失败包成 503。
  function send(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<LocalResponse> {
    return localFetch(`${base}/api${path}`, {
      method,
      signal,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        authorization: bearer ?? userBearer(data),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
    observe?: (headers: Headers) => void,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await send(method, path, body, signal)
      .catch(async (error: unknown) => {
        // 调用方主动取消（如秘书界面收回等待）不算断连，不重发。
        if (signal?.aborted) throw error;
        const next = reconnect ? await reconnect(error) : null;
        if (!next) throw error;
        base = next;
        return send(method, path, body, signal);
      })
      .catch((error: unknown) => {
        if (error instanceof Problem) throw error;
        throw new Problem(
          503,
          error instanceof Error ? error.message : String(error),
          "service_unavailable",
        );
      });
    // 头一到就回调：等待接口把游标放在头里，body 中途断开也拿得到。
    observe?.(response.headers);
    // 200 头已发出后进程死掉、body 读不出来或不是 JSON：当服务不可用，
    // 否则会被吞成 {} 当成正常结果（--idle 误报空闲、会话等待直接 TypeError）。
    const text = await response.text().catch((error: unknown) => {
      throw new Problem(
        503,
        `读取服务响应失败：${error instanceof Error ? error.message : String(error)}`,
        "service_unavailable",
      );
    });
    let value: unknown = {};
    try {
      value = JSON.parse(text);
    } catch {
      if (response.ok && text.length > 0)
        throw new Problem(
          503,
          `服务返回了无法解析的响应（HTTP ${response.status}）`,
          "service_unavailable",
        );
    }
    if (!response.ok) {
      if (
        !bearer &&
        missingRoute(response.status, value as { error?: unknown })
      ) {
        const outdated = await outdatedServiceAt(data);
        if (outdated) throw outdated;
      }
      const body = value as {
        error?: unknown;
        code?: string;
        candidates?: { ref: string; name: string }[];
        nextCommand?: string;
      };
      throw new Problem(
        response.status,
        typeof body.error === "string"
          ? body.error
          : `请求失败（HTTP ${response.status}）`,
        body.code,
        body.candidates,
        body.nextCommand,
      );
    }
    recordResult(value);
    return value as T;
  }
  return {
    get: <T>(
      path: string,
      observe?: (headers: Headers) => void,
      signal?: AbortSignal,
    ) => call<T>("GET", path, undefined, observe, signal),
    post: <T>(path: string, body: unknown = {}) => call<T>("POST", path, body),
    put: <T>(path: string, body: unknown) => call<T>("PUT", path, body),
    patch: <T>(path: string, body: unknown) => call<T>("PATCH", path, body),
    delete: <T>(path: string, body?: unknown) => call<T>("DELETE", path, body),
  };
}
