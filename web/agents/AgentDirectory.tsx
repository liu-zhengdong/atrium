import { useState } from "react";
import { LoaderCircle, MessageSquare, Plus, Search, Users } from "lucide-react";
import type { Overview } from "../../shared/schema.ts";
import { agentName } from "../../shared/agent-name.ts";
import {
  agentPresence,
  Avatar,
  runtimeLabel,
  type Agent,
} from "../components/AgentAvatar.tsx";

export function AgentDirectory({
  overview,
  opening,
  openAgent,
  details,
  create,
}: {
  overview: Overview;
  opening: string | null;
  openAgent: (a: Agent) => void;
  details: (id: string) => void;
  create: () => void;
}) {
  const [query, setQuery] = useState("");
  const discovered = overview.discovery.runtimes.filter((r) => !r.bound_agent);
  const count = overview.agents.length;
  const matches = (name: string, cwd: string) =>
    `${name} ${cwd}`.toLowerCase().includes(query.trim().toLowerCase());
  const agents = overview.agents.filter((a) =>
    matches(`${a.ref} ${a.name}`, a.cwd),
  );
  const fresh = discovered.filter((r) => matches(agentName(r.cwd), r.cwd));
  return (
    <section className="min-h-0 flex-1 overflow-auto px-9 py-[34px]">
      <header className="mb-[26px] flex items-center justify-between gap-5">
        <div>
          <h1 className="text-2xl tracking-[-0.04em]">
            Agents{" "}
            <span className="ml-[7px] text-[13px] font-normal text-muted">
              {count}
            </span>
          </h1>
          <p className="mt-1.5 text-[13px] text-muted">
            选择一位 Agent，开始对话。
          </p>
        </div>
        <button className="button secondary flex-none" onClick={create}>
          <Plus size={16} />
          新建 Agent
        </button>
      </header>
      {count > 0 && (
        <label className="mb-[26px] flex max-w-[400px] items-center gap-2.5 rounded-lg border border-line px-3 text-muted focus-within:border-[#aea18b]">
          <Search size={16} />
          <input
            className="plain-field min-w-0 flex-1 border-0 bg-transparent py-2.5 outline-none"
            aria-label="搜索 Agent"
            placeholder="搜索名字或工作目录"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      )}
      {overview.discovery.error && (
        <p role="alert" className="error mb-5">
          {overview.discovery.error} 已有会话仍可查看，正在后台重试。
        </p>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(280px,100%),1fr))] gap-4">
        {agents.map((a) => (
          <article
            className="group relative min-w-0 rounded-xl border border-line transition-[border-color,background] duration-150 hover:border-[#c9c3b8] hover:bg-[#fcfbf9]"
            key={a.id}
          >
            <div className="flex w-full items-start gap-3.5 rounded-xl px-5 pb-[19px] pt-[22px] text-left">
              <Avatar
                name={a.name}
                presence={agentPresence(a)}
                onClick={() => details(a.id)}
              />
              <button
                className="flex min-w-0 flex-1 items-start text-left"
                aria-label={`与 ${a.name} 聊天`}
                disabled={opening !== null}
                onClick={() => openAgent(a)}
              >
                <span className="grid min-w-0 flex-1 gap-[5px]">
                  <strong className="truncate pr-[18px] text-[15px] font-[560]">
                    {a.name}
                  </strong>
                  <span className="text-xs text-muted">
                    {a.ref} · {runtimeLabel(a)}
                    {a.unread > 0 && <> · {a.unread} 条未读</>}
                  </span>
                  <span
                    className="mt-3 truncate text-xs text-muted"
                    title={a.work || a.description || a.cwd}
                  >
                    {a.work || a.description || a.cwd}
                  </span>
                </span>
                <span className="self-end text-[#9a9283]">
                  {opening === a.id ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    <MessageSquare size={16} />
                  )}
                </span>
              </button>
            </div>
          </article>
        ))}
      </div>
      {!count ? (
        <div className="grid justify-items-center gap-3.5 px-5 py-20 text-center text-muted [&_h2]:text-lg [&_h2]:font-medium [&_h2]:text-ink [&_p]:text-[13px] [&_p]:leading-[1.8]">
          {overview.discovery.scanning ? (
            <LoaderCircle className="spin" size={28} />
          ) : (
            <Users size={28} />
          )}
          <h2>
            {overview.discovery.scanning
              ? "正在发现本机 Agent"
              : "还没有 Agent"}
          </h2>
          <p>
            创建一位长期 Agent，身份与聊天会一直保留。
            <br />
            普通 Pi 临时实例不会自动成为长期身份。
          </p>
        </div>
      ) : (
        !agents.length && (
          <div className="grid justify-items-center gap-3.5 px-5 py-20 text-center text-muted [&_h2]:text-lg [&_h2]:font-medium [&_h2]:text-ink [&_p]:text-[13px] [&_p]:leading-[1.8]">
            <Search size={24} />
            <h2>没有匹配的 Agent</h2>
            <button className="button secondary" onClick={() => setQuery("")}>
              清除搜索
            </button>
          </div>
        )
      )}
      {fresh.length > 0 && (
        <details className="settings-section temporary-runtimes">
          <summary>临时 Pi · {fresh.length}</summary>
          <p className="muted small-text">
            这些实例不属于长期身份，不会自动创建账号。要使用长期身份，请新建
            Agent，再通过具名入口启动。
          </p>
          {fresh.map((r) => (
            <p className="muted small-text" key={r.runtimeId}>
              {agentName(r.cwd)} · PID {r.pid}
            </p>
          ))}
        </details>
      )}
    </section>
  );
}
