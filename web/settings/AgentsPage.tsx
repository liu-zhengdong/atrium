import { useState } from "react";
import { Search } from "lucide-react";
import type { Agent } from "../components/AgentAvatar.tsx";
import { Avatar, agentPresence } from "../components/AgentAvatar.tsx";
export function AgentsPage({
  agents,
  open,
}: {
  agents: Agent[];
  open: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  return (
    <div className="space-y-5">
      <h1 className="text-xl font-medium">全部 Agent</h1>
      <label className="flex items-center gap-2 rounded-lg bg-soft px-3">
        <Search size={16} className="text-muted" />
        <input
          className="plain-field min-h-9 flex-1 border-0 bg-transparent text-xs outline-none"
          aria-label="搜索 Agent"
          placeholder="搜索 Agent"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className="space-y-1">
        {agents
          .filter((a) =>
            `${a.name} ${a.ref}`.toLowerCase().includes(query.toLowerCase()),
          )
          .map((agent) => (
            <button
              key={agent.id}
              className="-mx-2 flex w-[calc(100%+16px)] items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-soft"
              onClick={() => open(agent.id)}
            >
              <Avatar name={agent.name} presence={agentPresence(agent)} small />
              <span className="min-w-0 flex-1 truncate text-xs">
                {agent.name}
              </span>
            </button>
          ))}
      </div>
    </div>
  );
}
