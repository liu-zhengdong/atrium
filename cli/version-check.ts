import {
  currentVersion,
  readService,
  serviceUrl,
  type ServiceRecord,
} from "../server/service-state.ts";
import { compareSemver } from "../server/releases.ts";
import { Problem } from "../server/problem.ts";
import { localFetch } from "../server/local-http.ts";

/**
 * 新命令行调旧服务的新接口时，旧服务要么回 404「接口不存在」，
 * 要么因路由没登记而落到用户认证、回 401（服务控制接口就是这样）。
 * 这时比对服务自报的版本：服务确实旧于命令行，就如实报版本不匹配，不再让人去查认证。
 * 版本相同或拿不到版本时返回 null，调用方按原错误处理。
 */
async function outdatedService(
  record: ServiceRecord | null,
): Promise<Problem | null> {
  if (!record) return null;
  let version: unknown;
  try {
    const response = await localFetch(`${serviceUrl(record)}/api/service`, {
      headers: { authorization: `Bearer ${record.token}` },
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    version = ((await response.json()) as { version?: unknown }).version;
  } catch {
    return null;
  }
  const cli = currentVersion();
  const service = typeof version === "string" ? version : "未知版本";
  if (typeof version === "string" && compareSemver(version, cli) >= 0)
    return null;
  return new Problem(
    409,
    `服务版本 ${service} 旧于命令行 ${cli}，不支持此操作；先 atrium restart 到新版`,
    "service_outdated",
    undefined,
    "atrium restart",
  );
}

/**
 * 旧服务缺接口时的回应：未知路由 404（Atrium 自己的「接口不存在」或 Fastify 默认的 Not Found）；
 * 用服务控制凭据调未登记的 /api/service/* 时则落到用户认证，回 401。
 */
export function missingRoute(
  status: number,
  body: { error?: unknown; code?: unknown },
  serviceCredential = false,
) {
  if (status === 404)
    return (
      body.code === "unknown_route" ||
      body.error === "接口不存在" ||
      body.error === "Not Found"
    );
  return serviceCredential && status === 401;
}

export async function outdatedServiceAt(data: string) {
  try {
    return await outdatedService(readService(data));
  } catch {
    return null;
  }
}
