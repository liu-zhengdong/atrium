import {
  describeSource,
  firstCredential,
  jwtExpiry,
  parseJsonDocument,
} from "./credentials.ts";
import {
  getJson,
  isFailure,
  isObject,
  numberOf,
  timeOf,
  transportReason,
} from "./http.ts";
import { codexSources } from "./paths.ts";
import type { QuotaWindow, ReadResult, Reader, ReaderDeps } from "./types.ts";

/**
 * Codex 订阅额度：读 Codex CLI 的 auth.json（ChatGPT 登录的 tokens），
 * 调 `GET https://chatgpt.com/backend-api/wham/usage`。只有 API key 的登录没有订阅额度；
 * 令牌过期不替它刷新，只报「登录已过期」——codex 下次运行会自己续期。
 */

export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

const SESSION = 5 * 60 * 60;
const WEEK = 7 * 24 * 60 * 60;

export type CodexLogin =
  | { apiKeyOnly: false; accessToken: string; accountId: string | null }
  | { apiKeyOnly: true };

export function parseCodexLogin(text: string): CodexLogin | undefined {
  const document = parseJsonDocument(text);
  if (!isObject(document)) return undefined;
  const tokens = isObject(document.tokens) ? document.tokens : {};
  const token =
    typeof tokens.access_token === "string" ? tokens.access_token.trim() : "";
  if (token)
    return {
      apiKeyOnly: false,
      accessToken: token,
      accountId:
        typeof tokens.account_id === "string" && tokens.account_id.trim()
          ? tokens.account_id.trim()
          : null,
    };
  return typeof document.OPENAI_API_KEY === "string" &&
    document.OPENAI_API_KEY.trim()
    ? { apiKeyOnly: true }
    : undefined;
}

/** plan_type → 套餐名：prolite 是 Pro 5x，pro 是 Pro 20x，其余按下划线分词首字母大写。 */
export function codexPlan(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim();
  const lower = raw.toLowerCase();
  if (lower === "prolite") return "Pro 5x";
  if (lower === "pro") return "Pro 20x";
  return raw
    .split("_")
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : ""))
    .join(" ");
}

type Kind = "session" | "weekly";
type Candidate = {
  window: Record<string, unknown> | undefined;
  used: number | undefined;
  fallback: Kind;
};

function exactKind(window: Record<string, unknown> | undefined): Kind | null {
  const seconds = numberOf(window?.limit_window_seconds);
  if (seconds === SESSION) return "session";
  if (seconds === WEEK) return "weekly";
  return null;
}

function classified(
  rateLimit: unknown,
  ids: { session: [string, string]; weekly: [string, string] },
  headers: { primary?: number; secondary?: number },
  now: number,
): QuotaWindow[] {
  const limit = isObject(rateLimit) ? rateLimit : {};
  const candidates: Candidate[] = [];
  for (const [key, header, fallback] of [
    ["primary_window", headers.primary, "session"],
    ["secondary_window", headers.secondary, "weekly"],
  ] as const) {
    const window = isObject(limit[key]) ? limit[key] : undefined;
    if (!window && header === undefined) continue;
    candidates.push({
      window,
      used: numberOf(window?.used_percent) ?? header,
      fallback,
    });
  }
  const windows: QuotaWindow[] = [];
  for (const kind of ["session", "weekly"] as const) {
    // 服务通常把 5 小时窗口放 primary、周窗口放 secondary，但只剩周限额时它会出现在 primary。
    const candidate =
      candidates.find((c) => exactKind(c.window) === kind) ??
      candidates.find(
        (c) => exactKind(c.window) === null && c.fallback === kind,
      );
    if (!candidate || candidate.used === undefined) continue;
    const resetAt = timeOf(candidate.window?.reset_at);
    const after = numberOf(candidate.window?.reset_after_seconds);
    const period = numberOf(candidate.window?.limit_window_seconds);
    const [id, label] = ids[kind];
    windows.push({
      id,
      label,
      usedPercent: candidate.used,
      resetsAt:
        resetAt ??
        (after === undefined ? null : now + Math.round(after * 1000)),
      periodSeconds:
        period === undefined
          ? kind === "session"
            ? SESSION
            : WEEK
          : Math.max(0, Math.trunc(period)),
    });
  }
  return windows;
}

/** 用量响应 → 窗口；body 不是对象返回 undefined。 */
export function mapCodexUsage(
  body: unknown,
  headers: Headers,
  now: number,
): QuotaWindow[] | undefined {
  if (!isObject(body)) return undefined;
  const header = (name: string) => numberOf(headers.get(name));
  const windows = classified(
    body.rate_limit,
    { session: ["session", "Session"], weekly: ["weekly", "Weekly"] },
    {
      primary: header("x-codex-primary-used-percent"),
      secondary: header("x-codex-secondary-used-percent"),
    },
    now,
  );
  const spark = Array.isArray(body.additional_rate_limits)
    ? body.additional_rate_limits.find(
        (entry) =>
          isObject(entry) &&
          ["limit_name", "metered_feature"].some(
            (key) =>
              typeof entry[key] === "string" &&
              (entry[key] as string).toLowerCase().includes("spark"),
          ),
      )
    : undefined;
  if (isObject(spark))
    windows.push(
      ...classified(
        spark.rate_limit,
        {
          session: ["spark", "Spark"],
          weekly: ["sparkWeekly", "Spark Weekly"],
        },
        {},
        now,
      ),
    );
  return windows;
}

export async function readCodex(deps: ReaderDeps): Promise<ReadResult> {
  const found = await firstCredential(
    codexSources(deps.platform, deps.home, deps.env),
    deps,
    parseCodexLogin,
  );
  if (!found.ok)
    return {
      ok: false,
      reason: found.unreadable
        ? "Codex 登录数据读不出，运行 codex 重新登录"
        : "没有找到 Codex 登录，运行 codex 用 ChatGPT 账号登录",
    };
  const login = found.value;
  if (login.apiKeyOnly)
    return {
      ok: false,
      reason: "Codex 只用 API key 登录，没有订阅额度；改用 ChatGPT 账号登录",
    };
  const now = deps.now();
  const expiry = jwtExpiry(login.accessToken);
  if (expiry !== undefined && expiry <= now)
    return {
      ok: false,
      reason: `Codex 登录已过期（${describeSource(found.source)}），运行一次 codex 会自动续期`,
    };
  const reply = await getJson(
    CODEX_USAGE_URL,
    {
      Authorization: `Bearer ${login.accessToken}`,
      Accept: "application/json",
      "User-Agent": "Atrium",
      ...(login.accountId ? { "ChatGPT-Account-Id": login.accountId } : {}),
    },
    deps,
  );
  if (isFailure(reply))
    return { ok: false, reason: transportReason(reply, "Codex") };
  if (reply.status === 401 || reply.status === 403)
    return {
      ok: false,
      reason: "Codex 用量接口拒绝了登录（令牌失效），运行 codex 重新登录",
    };
  if (reply.status < 200 || reply.status >= 300)
    return { ok: false, reason: `Codex 用量接口返回 HTTP ${reply.status}` };
  const windows = mapCodexUsage(reply.body, reply.headers, now);
  if (!windows?.length)
    return { ok: false, reason: "Codex 用量接口返回的结构认不出" };
  return {
    ok: true,
    plan: codexPlan(isObject(reply.body) ? reply.body.plan_type : undefined),
    windows,
    refreshedAt: now,
  };
}

export const codexReader: Reader = { provider: "codex", read: readCodex };
