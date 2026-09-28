import http from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { proxyFor, scrub, type SendFailure } from "./model.ts";

/**
 * Telegram Bot API 的请求层：直连，或经 HTTP CONNECT 代理（Atrium 配置里单独配的优先，其次系统代理）。
 * 请求 URL 里带着 /bot<token>/，任何报错在交出去之前都抹掉 token。
 */

export const TELEGRAM_API = "https://api.telegram.org";

export type TelegramOptions = {
  /** 接口地址；测试给本地假服务器。 */
  api: string;
  token: string;
  /** Atrium 配置里单独配的代理。 */
  proxy: string | null;
  /** 取系统代理的环境（HTTPS_PROXY 等）；测试显式给，不读本机设置。 */
  env: Record<string, string | undefined>;
  timeoutMs?: number;
  /** 服务关闭时断开还在等的长轮询。 */
  signal?: AbortSignal;
};

export class TelegramError extends Error {
  constructor(readonly failure: SendFailure) {
    super(failure.message);
  }
}

type Reply = { status: number; body: string };

/** 调一个接口方法；ok:false 或 HTTP 出错抛 TelegramError（信息已脱敏）。 */
export async function callTelegram<T>(
  options: TelegramOptions,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  const target = new URL(
    `${options.api.replace(/\/+$/, "")}/bot${options.token}/${method}`,
  );
  const payload = JSON.stringify(body);
  let reply: Reply;
  try {
    reply = await request(target, payload, options);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TelegramError({
      status: null,
      message: scrub(`连不上 Telegram：${reason}`, options.token),
    });
  }
  let parsed: {
    ok?: boolean;
    result?: T;
    description?: string;
    parameters?: { retry_after?: number };
  } = {};
  try {
    parsed = JSON.parse(reply.body);
  } catch {
    parsed = {};
  }
  if (reply.status >= 200 && reply.status < 300 && parsed.ok === true)
    return parsed.result as T;
  const description =
    typeof parsed.description === "string"
      ? parsed.description.slice(0, 200)
      : `HTTP ${reply.status}`;
  throw new TelegramError({
    status: reply.status,
    retryAfter: parsed.parameters?.retry_after,
    message: scrub(`Telegram 拒绝了 ${method}：${description}`, options.token),
  });
}

function request(
  target: URL,
  payload: string,
  options: TelegramOptions,
): Promise<Reply> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const proxy = proxyFor(target, options.proxy, options.env);
  const secure = target.protocol === "https:";
  const port = Number(target.port) || (secure ? 443 : 80);
  return new Promise<Reply>((resolve, reject) => {
    let settled = false;
    /** 超时或出错时要断掉的连接（代理隧道、请求）。 */
    const open: { destroy(): unknown }[] = [];
    const finish = (error: Error | null, reply?: Reply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const item of open) item.destroy();
      if (error) reject(error);
      else resolve(reply!);
    };
    const timer = setTimeout(
      () => finish(new Error(`${Math.round(timeoutMs / 1000)} 秒没有响应`)),
      timeoutMs,
    );
    if (options.signal?.aborted) return finish(new Error("服务正在关闭"));
    options.signal?.addEventListener(
      "abort",
      () => finish(new Error("服务正在关闭")),
      { once: true },
    );
    const send = (socket?: Duplex) => {
      const common = {
        host: target.hostname,
        port,
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
        agent: false as const,
      };
      const req = !socket
        ? (secure ? https : http).request(common)
        : secure
          ? https.request({
              ...common,
              createConnection: () =>
                tls.connect({ socket, servername: target.hostname }),
            })
          : http.request({ ...common, createConnection: () => socket });
      open.push(req);
      req.on("response", (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          // 正常回执都很短；过大的不收进内存。
          if (size <= 1024 * 1024) chunks.push(chunk);
        });
        res.on("end", () =>
          finish(null, {
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", (error) => finish(error));
      });
      req.on("error", (error) => finish(error));
      req.end(payload);
    };
    if (!proxy) return send();
    const auth = proxy.username
      ? {
          "proxy-authorization": `Basic ${Buffer.from(
            `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
          ).toString("base64")}`,
        }
      : {};
    const connect = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: "CONNECT",
      path: `${target.hostname}:${port}`,
      headers: { host: `${target.hostname}:${port}`, ...auth },
      agent: false,
    });
    open.push(connect);
    connect.on("connect", (res, socket) => {
      open.push(socket);
      if (res.statusCode !== 200)
        return finish(new Error(`代理拒绝建立隧道（HTTP ${res.statusCode}）`));
      send(socket);
    });
    connect.on("error", (error) =>
      finish(new Error(`代理连不上：${error.message}`)),
    );
    connect.end();
  });
}
