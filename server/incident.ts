import type { FailureRetry } from "../shared/schema.ts";

export type FailureCategory = "transient" | "needsHuman";
export type FailureSource = "provider" | "delivery" | "startup";
export const RETRY_DELAYS = [2, 10, 30].map((minutes) => minutes * 60_000);

/** A local start/configuration error is not evidence of a provider timeout. */
export function classifyFailure(
  error: string,
  source: FailureSource,
): FailureCategory {
  if (source === "startup") return "needsHuman";
  if (
    /\b(?:400|401|403)\b|not logged in|please run \/login|unauthoriz|forbidden|invalid.request|invalid.api.key|no account|未配置|未分配|投递结果未知/i.test(
      error,
    )
  )
    return "needsHuman";
  return /\b(?:connection error|network (?:error|timeout)|provider stream timeout|stream (?:timed out|timeout)|rate.limit|rate limit|overloaded)\b|\b429\b|\[(?:500|502|503|504)\]|\bHTTP 5\d\d\b/i.test(
    error,
  )
    ? "transient"
    : "needsHuman";
}

export type Incident = {
  started_at: number;
  category: FailureCategory;
  attempts_used: number;
  attempt_running: boolean;
  notified_at: number | null;
  blocked: boolean;
};

/** Schedules are relative to the FIRST failure, never to the last retry/restart. */
export function retryDecision(
  incident: Incident,
  now: number,
  hasRetryablePending: boolean,
  uncertain: boolean,
  delays: readonly number[] = RETRY_DELAYS,
): FailureRetry {
  const max = delays.length;
  if (
    incident.category === "needsHuman" ||
    incident.blocked ||
    uncertain ||
    !hasRetryablePending
  )
    return { state: "needs_action", attempt: null, max, next_at: null };
  if (incident.attempt_running)
    return {
      state: "running",
      attempt: incident.attempts_used,
      max,
      next_at: null,
    };
  if (incident.attempts_used >= max)
    return { state: "exhausted", attempt: max, max, next_at: null };
  return {
    state: "waiting",
    attempt: incident.attempts_used + 1,
    max,
    next_at: incident.started_at + delays[incident.attempts_used]!,
  };
}
