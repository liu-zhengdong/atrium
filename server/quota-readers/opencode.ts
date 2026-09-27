import { accountKey, firstCredential } from "./credentials.ts";
import {
  getJson,
  isFailure,
  isObject,
  numberOf,
  timeOf,
  transportReason,
} from "./http.ts";
import { opencodeSources } from "./paths.ts";
import type { QuotaWindow, ReadResult, Reader, ReaderDeps } from "./types.ts";

/**
 * OpenCode Go 订阅额度：读 OpenCode 数据目录的 auth.json 里 `opencode-go` 的 key，
 * 调 `GET https://opencode.ai/zen/go/v1/usage`（跨设备、以服务端为准的滚动 / 周 / 月用量）。
 */

export const OPENCODE_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

/** auth.json 里 opencode-go 的 key；没有这一项为 null，文件不是 JSON 对象为 undefined。 */
export function parseOpencodeKey(text: string): string | null | undefined {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(document)) return undefined;
  const entry = document["opencode-go"];
  const key = isObject(entry) && typeof entry.key === "string" ? entry.key : "";
  return key.trim() || null;
}

const WINDOWS = [
  ["rolling", "session", "Session", 5 * 60 * 60],
  ["weekly", "weekly", "Weekly", 7 * 24 * 60 * 60],
  ["monthly", "monthly", "Monthly", 0],
] as const;

/** 用量响应 → 窗口；三个窗口缺任何一个都当结构变了。 */
export function mapOpencodeUsage(body: unknown): QuotaWindow[] | undefined {
  const usage = isObject(body) && isObject(body.usage) ? body.usage : undefined;
  if (!usage) return undefined;
  const windows: QuotaWindow[] = [];
  for (const [key, id, label, periodSeconds] of WINDOWS) {
    const value = usage[key];
    const percent = isObject(value) ? numberOf(value.percent) : undefined;
    if (!isObject(value) || percent === undefined) return undefined;
    windows.push({
      id,
      label,
      usedPercent: Math.min(100, Math.max(0, percent)),
      resetsAt: timeOf(value.resetsAt),
      periodSeconds,
    });
  }
  return windows;
}

export async function readOpencode(deps: ReaderDeps): Promise<ReadResult> {
  let noGoEntry = false;
  const found = await firstCredential(
    opencodeSources(deps.platform, deps.home, deps.env),
    deps,
    (text) => {
      const key = parseOpencodeKey(text);
      if (key === null) noGoEntry = true;
      return key ?? undefined;
    },
  );
  if (!found.ok)
    return {
      ok: false,
      reason: noGoEntry
        ? "OpenCode 没有登录 OpenCode Go"
        : found.unreadable
          ? "OpenCode 登录数据读不出，重新登录 OpenCode Go"
          : "没有找到 OpenCode 登录，登录 OpenCode Go",
    };
  const reply = await getJson(
    OPENCODE_USAGE_URL,
    {
      Authorization: `Bearer ${found.value}`,
      Accept: "application/json",
      "User-Agent": "Atrium",
    },
    deps,
  );
  if (isFailure(reply))
    return { ok: false, reason: transportReason(reply, "OpenCode Go") };
  if (reply.status === 401)
    return {
      ok: false,
      reason: "OpenCode Go 登录失效或过期，重新登录 OpenCode Go",
    };
  if (reply.status === 403) {
    const error =
      isObject(reply.body) && isObject(reply.body.error)
        ? reply.body.error
        : {};
    return {
      ok: false,
      reason:
        error.type === "EntitlementError"
          ? "没有 OpenCode Go 订阅"
          : "OpenCode Go 用量接口返回 HTTP 403",
    };
  }
  if (reply.status < 200 || reply.status >= 300)
    return {
      ok: false,
      reason: `OpenCode Go 用量接口返回 HTTP ${reply.status}`,
    };
  const windows = mapOpencodeUsage(reply.body);
  if (!windows)
    return { ok: false, reason: "OpenCode Go 用量接口返回的结构认不出" };
  // OpenCode Go 的 key 就是账号：同一个 key 拷到几台算一份（只传指纹）。
  return {
    ok: true,
    plan: "Go",
    windows,
    refreshedAt: deps.now(),
    account: accountKey("opencode", found.value),
  };
}

export const opencodeReader: Reader = {
  provider: "opencode",
  read: readOpencode,
};
