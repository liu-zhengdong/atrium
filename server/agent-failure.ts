export type AgentFailure = { text: string; at: number; count: number } | null;
export type AgentEvent =
  | { kind: "failure"; text: string; at: number }
  | { kind: "success" }
  | { kind: "heartbeat" | "direct" | "retry" };

/** A failed turn blocks only periodic wakes; a direct contact or explicit retry may try again. */
export function agentTransition(state: AgentFailure, event: AgentEvent) {
  switch (event.kind) {
    case "failure":
      return {
        failure: {
          text: event.text.slice(0, 8192),
          at: event.at,
          count: (state?.count ?? 0) + 1,
        },
        wake: false,
        read: false,
      };
    case "success":
      return { failure: null, wake: false, read: true };
    case "heartbeat":
      return { failure: state, wake: state === null, read: false };
    case "direct":
    case "retry":
      return { failure: state, wake: true, read: false };
  }
}
