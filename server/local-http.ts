// 不用 `import … from "node:http"`：ESM 包装会逐个读出全部导出，连带加载 undici（约 13 毫秒），
// 命令行每次启动都要付（t117）。getBuiltinModule 直接取模块对象，不碰那些惰性导出。
const { request } = process.getBuiltinModule(
  "node:http",
) as typeof import("node:http");

/**
 * 访问本机 Atrium 服务用的最小请求：替代全局 fetch（#262 重启窗口）。
 *
 * 原因：Node 24 自带的 undici 在写请求前无条件调用 socket.setTypeOfService；
 * 连接刚建立就被对端重置（旧服务正在关闭）时，macOS 上它同步抛 EINVAL，
 * 而调用点在 socket 的 connect 事件回调里，fetch 的 Promise 接不住，整个进程直接崩溃。
 * node:http 不调用它，同样的断开以 ECONNRESET / EPIPE 从 error 事件交回，可以按重启窗口重试。
 *
 * 响应头按需才构造 Headers：全局 Headers 同样来自 undici，大多数调用方用不到。
 *
 * 每个请求单独建连接（agent: false）：不复用被旧服务当作空闲关掉的连接。
 * 连接层错误包成 `Error(message, { cause })`，与 fetch 的形状一致，调用方按 cause.code 判断。
 */
export type LocalResponse = {
  ok: boolean;
  status: number;
  headers: Headers;
  text(): Promise<string>;
  json(): Promise<unknown>;
};

export function localFetch(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  } = {},
): Promise<LocalResponse> {
  return new Promise((resolvePromise, reject) => {
    const headers: Record<string, string | number> = { ...init.headers };
    if (init.body !== undefined)
      headers["content-length"] = Buffer.byteLength(init.body);
    const failed = (error: Error) =>
      reject(new Error(`连接服务失败：${error.message}`, { cause: error }));
    let req: ReturnType<typeof request>;
    try {
      req = request(
        url,
        {
          method: init.method ?? "GET",
          headers,
          agent: false,
          signal: init.signal,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          let responseHeaders: Headers | undefined;
          const headersOf = () => {
            if (responseHeaders) return responseHeaders;
            responseHeaders = new Headers();
            for (const [name, value] of Object.entries(res.headers)) {
              if (value === undefined) continue;
              for (const item of Array.isArray(value) ? value : [value])
                responseHeaders.append(name, item);
            }
            return responseHeaders;
          };
          // body 在头到达时就开始收；读的时候再交出结果或中途断开的错误。
          const body = new Promise<string>((resolveBody, rejectBody) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () =>
              resolveBody(Buffer.concat(chunks).toString("utf8")),
            );
            res.on("error", rejectBody);
            res.on("aborted", () =>
              rejectBody(
                Object.assign(new Error("响应中途被断开"), {
                  code: "ECONNRESET",
                }),
              ),
            );
            res.on("close", () => {
              if (!res.complete)
                rejectBody(
                  Object.assign(new Error("响应中途被断开"), {
                    code: "ECONNRESET",
                  }),
                );
            });
          });
          body.catch(() => {});
          resolvePromise({
            ok: status >= 200 && status < 300,
            status,
            get headers() {
              return headersOf();
            },
            text: () => body,
            json: async () => JSON.parse(await body) as unknown,
          });
        },
      );
    } catch (error) {
      failed(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    req.on("error", failed);
    req.end(init.body);
  });
}
