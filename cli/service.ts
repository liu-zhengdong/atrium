import {
  dataDirectory,
  readService,
  serviceUrl,
} from "../server/service-state.ts";
import { startService } from "../server/service.ts";

export type Client = ReturnType<typeof client>;

/**
 * 连上 Atrium 服务；没在跑就在后台拉起，不开浏览器。
 * 能力定义只在服务这一份，命令行不直接开数据库，改动才会经过投递与唤醒。
 */
export async function connect(): Promise<Client> {
  const data = dataDirectory();
  const before = readService(data);
  const record = await startService(data);
  if (!before || before.pid !== record.pid)
    console.error(
      `Atrium 服务已在后台启动 · PID ${record.pid} · ${serviceUrl(record)} · 停止：atrium stop`,
    );
  return client(serviceUrl(record));
}

function client(base: string) {
  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
    raw?: { bytes: Uint8Array; headers: Record<string, string> },
  ): Promise<T> {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: raw
        ? raw.headers
        : body === undefined
          ? {}
          : { "content-type": "application/json" },
      // Node 的 fetch 接受 Uint8Array 做请求体，DOM 的类型声明没跟上。
      body: raw
        ? (raw.bytes as unknown as BodyInit)
        : body === undefined
          ? undefined
          : JSON.stringify(body),
    });
    const value: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = (value as { error?: unknown }).error;
      throw new Error(
        typeof error === "string"
          ? error
          : `请求失败（HTTP ${response.status}）`,
      );
    }
    return value as T;
  }
  return {
    get: <T>(path: string) => call<T>("GET", path),
    post: <T>(path: string, body: unknown = {}) => call<T>("POST", path, body),
    put: <T>(path: string, body: unknown) => call<T>("PUT", path, body),
    patch: <T>(path: string, body: unknown) => call<T>("PATCH", path, body),
    delete: <T>(path: string, body?: unknown) => call<T>("DELETE", path, body),
    upload: <T>(
      path: string,
      bytes: Uint8Array,
      headers: Record<string, string>,
    ) => call<T>("POST", path, undefined, { bytes, headers }),
  };
}
