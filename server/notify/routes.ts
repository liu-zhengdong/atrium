import type { FastifyInstance } from "fastify";
import { Problem } from "../problem.ts";
import { BIND_WAIT_MAX, type TelegramNotifier } from "./runtime.ts";

/**
 * 推送设置（atrium notify …）：只有用户能改（leader 令牌的写接口缺省拒绝）；
 * 读状态不回 token，也不回代理密码。存 token 的请求体只进内存，校验失败不回显。
 */
export function registerNotifyRoutes(
  app: FastifyInstance,
  notifier: TelegramNotifier,
) {
  app.get("/api/notify/telegram", () => notifier.status());
  app.put("/api/notify/telegram/token", { bodyLimit: 4 * 1024 }, (request) =>
    notifier.setToken(request.body),
  );
  app.post("/api/notify/telegram/bind", { bodyLimit: 1024 }, (request) =>
    notifier.bind(bindSeconds(request.body)),
  );
  app.patch("/api/notify/telegram", { bodyLimit: 4 * 1024 }, (request) =>
    notifier.set(request.body),
  );
  app.post("/api/notify/telegram/test", () => notifier.test());
  app.delete("/api/notify/telegram", () => notifier.remove());
}

function bindSeconds(body: unknown) {
  const value =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as { timeout?: unknown }).timeout
      : undefined;
  if (value === undefined) return 120;
  const text = String(value);
  if (!/^(0|[1-9]\d*)$/.test(text) || Number(text) > BIND_WAIT_MAX)
    throw new Problem(
      400,
      `--timeout: 应为 0～${BIND_WAIT_MAX} 的整数秒`,
      "usage",
    );
  return Number(text);
}
