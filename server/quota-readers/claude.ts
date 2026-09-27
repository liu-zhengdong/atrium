import {
  describeSource,
  firstCredential,
  parseJsonDocument,
} from "./credentials.ts";
import {
  getJson,
  isFailure,
  isObject,
  numberOf,
  retryAfter,
  timeOf,
  transportReason,
} from "./http.ts";
import { claudeSources } from "./paths.ts";
import type { QuotaWindow, ReadResult, Reader, ReaderDeps } from "./types.ts";

/**
 * Claude Code 订阅额度：读 Claude Code 登录（macOS 钥匙串 / 凭据文件的 claudeAiOauth），
 * 调 `GET https://api.anthropic.com/api/oauth/usage`。令牌过期不替它刷新，只报「登录已过期」——
 * Claude Code 下次运行会自己续期。接口常限流（429），缓存按 Retry-After 推迟下次请求。
 */

export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
/** 没给 Retry-After 的限流按 5 分钟算（同 OpenQuota）。 */
const DEFAULT_RATE_LIMIT_MS = 5 * 60_000;

const HOUR = 3600;
const WEEK = 7 * 24 * HOUR;

export type ClaudeLogin = {
  accessToken: string;
  expiresAt: number | null;
  subscriptionType: string | null;
  rateLimitTier: string | null;
};

export function parseClaudeLogin(text: string): ClaudeLogin | undefined {
  const document = parseJsonDocument(text);
  if (!isObject(document) || !isObject(document.claudeAiOauth))
    return undefined;
  const oauth = document.claudeAiOauth;
  const token =
    typeof oauth.accessToken === "string" ? oauth.accessToken.trim() : "";
  if (!token) return undefined;
  const stringOf = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : null;
  return {
    accessToken: token,
    expiresAt: numberOf(oauth.expiresAt) ?? null,
    subscriptionType: stringOf(oauth.subscriptionType),
    rateLimitTier: stringOf(oauth.rateLimitTier),
  };
}

/** 「max」+「default_claude_max_5x」→「Max 5x」。 */
export function claudePlan(
  subscription: string | null,
  tier: string | null,
): string | null {
  if (!subscription) return null;
  const plan = subscription
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
  const multiplier = tier
    ?.split(/[^a-z0-9]+/i)
    .find((part) => /^\d+x$/.test(part));
  return multiplier ? `${plan} ${multiplier}` : plan;
}

function percentWindow(
  id: string,
  label: string,
  percent: unknown,
  resets: unknown,
  periodSeconds: number,
): QuotaWindow | undefined {
  const used = numberOf(percent);
  if (used === undefined) return undefined;
  return {
    id,
    label,
    usedPercent: used,
    resetsAt: timeOf(resets),
    periodSeconds,
  };
}

const SCOPED_PERIOD: Record<string, number> = {
  weekly_scoped: WEEK,
  daily_scoped: 24 * HOUR,
  session_scoped: 5 * HOUR,
  five_hour_scoped: 5 * HOUR,
};

/** 用量响应 → 窗口；结构不对返回 undefined。 */
export function mapClaudeUsage(body: unknown): QuotaWindow[] | undefined {
  if (!isObject(body)) return undefined;
  const windows: QuotaWindow[] = [];
  const push = (window: QuotaWindow | undefined) => {
    if (window) windows.push(window);
  };
  for (const [key, id, label, period] of [
    ["five_hour", "session", "Session", 5 * HOUR],
    ["seven_day", "weekly", "Weekly", WEEK],
    ["seven_day_sonnet", "sonnet", "Sonnet", WEEK],
  ] as const) {
    const value = body[key];
    if (isObject(value))
      push(
        percentWindow(id, label, value.utilization, value.resets_at, period),
      );
  }
  if (Array.isArray(body.limits))
    for (const limit of body.limits) {
      if (!isObject(limit)) continue;
      const kind = typeof limit.kind === "string" ? limit.kind : "";
      if (!kind.endsWith("_scoped")) continue;
      const scope = isObject(limit.scope) ? limit.scope : {};
      const model = isObject(scope.model) ? scope.model : {};
      const label =
        typeof model.display_name === "string" ? model.display_name.trim() : "";
      if (!label) continue;
      const slug = label
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean)
        .join("-");
      if (!slug) continue;
      const id =
        label === "Fable" && kind === "weekly_scoped"
          ? "fable"
          : kind === "weekly_scoped"
            ? `scoped-${slug}`
            : `scoped-${kind.replace(/_scoped$/, "")}-${slug}`;
      const period = numberOf(limit.period_seconds);
      push(
        percentWindow(
          id,
          label,
          limit.percent,
          limit.resets_at,
          period !== undefined && period >= 0
            ? Math.trunc(period)
            : (SCOPED_PERIOD[kind] ?? 0),
        ),
      );
    }
  // 一个窗口都没有说明返回结构变了（有订阅的账号至少有会话与周窗口）。
  return windows.length ? windows : undefined;
}

export async function readClaude(deps: ReaderDeps): Promise<ReadResult> {
  const found = await firstCredential(
    claudeSources(deps.platform, deps.home, deps.env),
    deps,
    parseClaudeLogin,
  );
  if (!found.ok)
    return {
      ok: false,
      reason: found.unreadable
        ? "Claude Code 登录数据读不出，运行 claude 重新登录"
        : "没有找到 Claude Code 登录，运行 claude 登录",
    };
  const login = found.value;
  const now = deps.now();
  if (login.expiresAt !== null && login.expiresAt <= now)
    return {
      ok: false,
      reason: `Claude Code 登录已过期（${describeSource(found.source)}），运行一次 claude 会自动续期`,
    };
  const reply = await getJson(
    CLAUDE_USAGE_URL,
    {
      Authorization: `Bearer ${login.accessToken}`,
      Accept: "application/json",
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "claude-code/2.1.69",
    },
    deps,
  );
  if (isFailure(reply))
    return { ok: false, reason: transportReason(reply, "Claude") };
  if (reply.status === 401 || reply.status === 403)
    return {
      ok: false,
      reason: "Claude 用量接口拒绝了登录（令牌失效），运行 claude 重新登录",
    };
  if (reply.status === 429)
    return {
      ok: false,
      reason: "Claude 用量接口限流",
      retryAt:
        retryAfter(reply.headers.get("retry-after"), now) ??
        now + DEFAULT_RATE_LIMIT_MS,
    };
  if (reply.status < 200 || reply.status >= 300)
    return { ok: false, reason: `Claude 用量接口返回 HTTP ${reply.status}` };
  const windows = mapClaudeUsage(reply.body);
  if (!windows) return { ok: false, reason: "Claude 用量接口返回的结构认不出" };
  return {
    ok: true,
    plan: claudePlan(login.subscriptionType, login.rateLimitTier),
    windows,
    refreshedAt: now,
  };
}

export const claudeReader: Reader = { provider: "claude", read: readClaude };
