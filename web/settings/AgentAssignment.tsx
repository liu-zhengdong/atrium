import { useState } from "react";
import { Check, Search } from "lucide-react";
import type { Agent } from "../components/AgentAvatar.tsx";
import { assignedAccountLabel } from "../../shared/providers.ts";

export function AgentAssignment({
  agents,
  selected,
  completed,
  setSelected,
  provider,
  accounts,
}: {
  agents: Agent[];
  selected: string[];
  completed: string[];
  setSelected: (next: string[]) => void;
  provider: { id: string; name: string };
  accounts: {
    id: string;
    name: string;
    provider: string;
    assigned: string[];
  }[];
}) {
  const [search, setSearch] = useState("");
  const visible = agents.filter((agent) =>
    `${agent.name} ${agent.ref}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div>
      {agents.length > 8 && (
        <div className="relative mb-2">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted"
          />
          <input
            className="field !border-transparent !bg-[#f1f5f2] !pl-9"
            aria-label="搜索 Agent"
            placeholder="搜索 Agent"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      )}
      <div
        className="max-h-[320px] space-y-1 overflow-y-auto"
        aria-label="分配给 Agent"
      >
        {agents.length === 0 && (
          <p className="text-xs text-muted">还没有 Agent，可以稍后分配。</p>
        )}
        {agents.length > 0 && visible.length === 0 && (
          <p className="px-3 py-4 text-xs text-muted">没有匹配的 Agent</p>
        )}
        {visible.map((agent) => (
          <button
            type="button"
            key={agent.id}
            aria-pressed={selected.includes(agent.id)}
            disabled={completed.includes(agent.id)}
            onClick={() =>
              setSelected(
                selected.includes(agent.id)
                  ? selected.filter((id) => id !== agent.id)
                  : [...selected, agent.id],
              )
            }
            className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm hover:bg-[#f1f5f2] disabled:opacity-60"
          >
            <span className="min-w-0 truncate">
              {agent.name}{" "}
              <span className="text-xs text-muted">({agent.ref})</span>
              {assignedAccountLabel(agent.ref, provider.id, accounts) && (
                <span className="ml-2 text-xs text-muted">
                  · 当前{" "}
                  {assignedAccountLabel(agent.ref, provider.id, accounts)}
                </span>
              )}
            </span>
            {completed.includes(agent.id) ? (
              <span className="text-xs text-accent-strong">已分配</span>
            ) : (
              selected.includes(agent.id) && (
                <Check size={16} className="text-accent-strong" />
              )
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
