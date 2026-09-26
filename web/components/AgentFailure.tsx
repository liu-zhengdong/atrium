import { ChevronRight } from "lucide-react";
import type { Agent } from "./AgentAvatar.tsx";
import { pastTime } from "../time.ts";
import { failureSummary } from "./failure-summary.ts";
import { retryOf, retryStateText } from "../agents/retry-state.ts";

export function AgentFailure({
  agent,
  retry,
}: {
  agent: Agent;
  retry?: () => void;
}) {
  if (!agent.failure) return null;
  const { text, at, count } = agent.failure;
  const snapshot = retryOf(agent);
  const state = retryStateText(snapshot);
  const running = snapshot?.state === "running";
  return (
    <div className="min-w-0 text-xs text-[#9c3f2d]">
      <details className="group min-w-0">
        <summary
          className="flex cursor-pointer list-none items-start gap-1.5 leading-relaxed [&::-webkit-details-marker]:hidden"
          title="展开错误原文"
        >
          <ChevronRight
            size={14}
            className="mt-0.5 flex-none transition-transform group-open:rotate-90"
            aria-hidden="true"
          />
          <span className="min-w-0 truncate">{failureSummary(text)}</span>
        </summary>
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[#fcf2ee] p-2 text-[11px] leading-relaxed">
          {text}
        </pre>
      </details>
      {state && (
        <p
          className={`mt-1 leading-relaxed ${running ? "text-[#8a6a12]" : ""}`}
        >
          {state}
        </p>
      )}
      <div className="mt-1 flex items-center justify-between gap-3 text-[11px] text-muted">
        <span title={new Date(at).toLocaleString("zh-CN")}>
          {pastTime(at)} · 连续 {count} 次
        </span>
        {retry && (
          <button
            className="button secondary h-6 min-h-6 px-2 text-[11px]"
            onClick={retry}
          >
            重试
          </button>
        )}
      </div>
    </div>
  );
}
