import { useEffect, useRef } from "react";
import { ArrowLeft, X } from "lucide-react";
import type { Agent } from "../components/AgentAvatar.tsx";
import { isImeKey } from "../keys.ts";
import { AgentTrace } from "./AgentTrace.tsx";

/** Separate workspace card: the chat column yields space instead of being covered. */
export function AgentTracePanel({
  agent,
  revision,
  target,
  close,
}: {
  agent: Agent;
  revision: number;
  target: { id: number; serial: number } | null;
  close: () => void;
}) {
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (window.matchMedia("(max-width: 1023px)").matches) back.current?.focus();
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isImeKey(event)) return;
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  return (
    <aside
      className="fixed inset-0 z-50 flex min-h-0 flex-col bg-white min-[1024px]:relative min-[1024px]:inset-auto min-[1024px]:z-auto min-[1024px]:my-2.5 min-[1024px]:mr-2.5 min-[1024px]:w-[420px] min-[1024px]:max-w-[35vw] min-[1024px]:flex-none min-[1024px]:overflow-hidden min-[1024px]:rounded-2xl min-[1024px]:border min-[1024px]:border-black/[0.04] min-[1024px]:shadow-[0_1px_3px_rgba(0,0,0,0.02),0_8px_24px_rgba(0,0,0,0.03)]"
      aria-label={`${agent.name} 的运行轨迹`}
    >
      <header className="flex h-12 flex-none items-center gap-3 border-b border-black/[0.04] px-5">
        <span className="min-[1024px]:hidden">
          <button
            ref={back}
            className="icon-button"
            aria-label="返回"
            onClick={close}
          >
            <ArrowLeft size={18} />
          </button>
        </span>
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
          {agent.name}
          <span className="ml-2 text-xs font-normal text-muted">运行轨迹</span>
        </h2>
        <span className="max-[1023px]:hidden">
          <button
            className="icon-button"
            aria-label="关闭轨迹"
            title="关闭轨迹 (Esc)"
            onClick={close}
          >
            <X size={16} />
          </button>
        </span>
      </header>
      <AgentTrace agent={agent} revision={revision} target={target} />
    </aside>
  );
}
