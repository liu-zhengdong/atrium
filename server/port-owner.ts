import { localFetch } from "./local-http.ts";

/**
 * 端口被占时说清楚是谁占着（t71）：先问该端口是不是 Atrium（`GET /api/service/info`，
 * 免认证、只回服务身份与数据目录），是就报它的数据目录，让用户改 ATRIUM_DATA 连过去；
 * 不是就报被其他程序占用。启动前查一次，不让第二个服务在错的数据目录上建表后才撞端口。
 */
export type PortOwner =
  | { kind: "free" }
  | { kind: "atrium"; data: string | null }
  | { kind: "other" };

/** 服务信息接口的回包判定（纯函数）：状态码与正文 → 占用者。 */
export function classifyPortReply(status: number, body: string): PortOwner {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { kind: "other" };
  }
  const value = parsed as { service?: unknown; data?: unknown; code?: unknown };
  if (status === 200 && value?.service === "atrium")
    return {
      kind: "atrium",
      data: typeof value.data === "string" && value.data ? value.data : null,
    };
  // 没有信息接口的旧版 Atrium：未知路由一律要求用户凭据，回 auth_required。
  if (status === 401 && value?.code === "auth_required")
    return { kind: "atrium", data: null };
  return { kind: "other" };
}

export async function probePort(
  port: number,
  timeoutMs = 1500,
): Promise<PortOwner> {
  try {
    const response = await localFetch(
      `http://127.0.0.1:${port}/api/service/info`,
      { signal: AbortSignal.timeout(timeoutMs) },
    );
    return classifyPortReply(response.status, await response.text());
  } catch (error) {
    const code = (error as { cause?: { code?: unknown } }).cause?.code;
    return code === "ECONNREFUSED" ? { kind: "free" } : { kind: "other" };
  }
}

/** 占用者 → 给人看的一句话；空闲或就是本数据目录时返回 null。 */
export function portTakenMessage(
  port: number,
  owner: PortOwner,
  data: string,
): string | null {
  if (owner.kind === "free") return null;
  if (owner.kind === "other")
    return `端口 ${port} 已被其他程序占用；换端口请设 ATRIUM_PORT=<端口>`;
  if (owner.data === data) return null;
  if (owner.data === null)
    return `端口 ${port} 已被另一个 Atrium 占用（版本较旧，查不到它的数据目录）；本次数据在 ${data}。要连它请把 ATRIUM_DATA 设成它的数据目录，要另起一份请设 ATRIUM_PORT=<端口>`;
  return `端口 ${port} 已被另一份数据的 Atrium 占用：数据在 ${owner.data}；要用它请设 ATRIUM_DATA=${owner.data}`;
}
