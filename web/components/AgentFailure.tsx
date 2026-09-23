import type { Agent } from "./AgentAvatar.tsx";
import { time } from "../time.ts";

export function AgentFailure({
  agent,
  retry,
  compact = false,
}: {
  agent: Agent;
  retry?: () => void;
  compact?: boolean;
}) {
  if (!agent.failure) return null;
  const { text, at, count } = agent.failure;
  const summary = text.replace(/\s+/g, " ").slice(0, 110);
  return (
    <div className="min-w-0 text-xs text-[#9c3f2d]">
      <details className="min-w-0">
        <summary
          className="cursor-pointer truncate leading-relaxed"
          title="展开错误原文"
        >
          {summary}
          {text.length > 110 ? "…" : ""}
        </summary>
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[#fcf2ee] p-2 text-[11px] leading-relaxed">
          {text}
        </pre>
      </details>
      <div className="mt-1 flex items-center justify-between gap-3 text-[11px] text-muted">
        <span>
          {new Date(at).toLocaleDateString("zh-CN")} {time(at)} · 连续 {count}{" "}
          次
        </span>
        {retry && !compact && (
          <button
            className="text-accent-strong hover:underline"
            onClick={retry}
          >
            重试
          </button>
        )}
      </div>
    </div>
  );
}
