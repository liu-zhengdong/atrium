import type { FailureRetry } from "../shared/schema.ts";

export type FailureCategory = "transient" | "needsHuman";
export type FailureSource = "provider" | "delivery" | "startup";
export const RETRY_DELAYS = [2, 10, 30].map((minutes) => minutes * 60_000);

/** Retry only recognizable temporary failures; unknown errors need a person.
 * Otherwise an intentional cancellation or a new configuration error could
 * replay a user's work without authorization.
 */
export function classifyFailure(
  error: string,
  _source: FailureSource,
  code?: string,
): FailureCategory {
  if (code === "launch_secret_unsupported") return "needsHuman";
  if (
    /(?:^|\s|\[)(?:400|401|402|403)(?=\b|\])|not logged in|authentication required|please run \/login|unauthoriz|forbidden|invalid[ _.-]*(?:api[ _.-]*)?key|api[ _.-]*key[ _.-]*(?:missing|invalid|expired|not configured|not set)|invalid[ _.-]*request|authentication failed|credentials? (?:invalid|expired)|token expired|insufficient_quota|billing|payment required|(?:usage|monthly|daily) limit|no remaining credits|credit balance|no account|not assigned|model not found|not supported|unsupported|capability denied|permission denied|未配置|未分配|模型认证失败|认证失败|余额不足|套餐.*用尽|模型不支持|投递结果未知/i.test(
      error,
    )
  )
    return "needsHuman";
  if (
    /(?:^|\D)(?:429|5\d{2})(?!\d)|fetch failed|network (?:error|request failed)|connection (?:error|reset|closed|refused|timed out|terminated)|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|websocket closed 1012|timeout|timed out|rate limit|overloaded|temporarily unavailable/i.test(
      error,
    )
  )
    return "transient";
  return "needsHuman";
}

export type Incident = {
  started_at: number;
  category: FailureCategory;
  attempts_used: number;
  attempt_running: boolean;
  attempt_claimed_at: number | null;
  notified_at: number | null;
  blocked: boolean;
};

/** Only a new user message (or explicit retry) may wake a terminal incident. */
export function needsUserAttempt(incident: Incident | null): boolean {
  return (
    !!incident &&
    (incident.category === "needsHuman" ||
      incident.blocked ||
      (incident.attempts_used >= RETRY_DELAYS.length &&
        !incident.attempt_running))
  );
}

/** First retry is relative to failure; overdue catch-up runs at most once before preserving spacing. */
export function retryDecision(
  incident: Incident,
  now: number,
  hasRetryablePending: boolean,
  uncertain: boolean,
  delays: readonly number[] = RETRY_DELAYS,
): FailureRetry {
  const max = delays.length;
  if (incident.category === "needsHuman" || incident.blocked || uncertain)
    return { state: "needs_action", attempt: null, max, next_at: null };
  if (incident.attempt_running)
    return {
      state: "running",
      attempt: incident.attempts_used,
      max,
      next_at: null,
    };
  if (!hasRetryablePending)
    return { state: "needs_action", attempt: null, max, next_at: null };
  if (incident.attempts_used >= max)
    return { state: "exhausted", attempt: max, max, next_at: null };
  return {
    state: "waiting",
    attempt: incident.attempts_used + 1,
    max,
    next_at: Math.max(
      incident.started_at + delays[incident.attempts_used]!,
      incident.attempts_used && incident.attempt_claimed_at !== null
        ? incident.attempt_claimed_at +
            delays[incident.attempts_used]! -
            delays[incident.attempts_used - 1]!
        : 0,
    ),
  };
}
