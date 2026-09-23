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
    <section className="min-h-0 flex-1 overflow-auto bg-white px-8 py-6 max-[560px]:px-4 max-[560px]:py-4">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        {count > 0 ? (
          <label className="flex h-7 w-72 items-center gap-2 rounded-lg border border-transparent bg-[#f0f4f1] px-2.5 text-muted transition-all hover:bg-[#ebf0ec] focus-within:border-black/[0.06] focus-within:bg-white focus-within:shadow-[0_1px_4px_rgba(24,32,25,0.06)]">
            <Search size={13} className="text-[#6e7d72]" />
            <input
              className="plain-field min-w-0 flex-1 border-0 bg-transparent text-xs text-ink placeholder:text-muted/70 outline-none"
              aria-label="搜索 Agent"
              placeholder="搜索名字、短号或目录..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        ) : (
          <div />
        )}
        <button
          className="button primary flex-none gap-1.5 h-7"
          onClick={create}
        >
          <Plus size={14} />
          新建 Agent
        </button>
      </header>
      {overview.discovery.error && (
        <p role="alert" className="error mb-5 text-xs">
          {overview.discovery.error} 已有会话仍可查看，正在后台重试。
        </p>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(290px,100%),1fr))] gap-4">
        {agents.map((a) => (
          <article
            className="group relative flex flex-col justify-between rounded-xl border border-black/[0.05] bg-white p-4 shadow-[0_1px_3px_rgba(24,32,25,0.02)] transition-all duration-150 hover:-translate-y-0.5 hover:border-black/[0.09] hover:shadow-[0_4px_16px_rgba(24,32,25,0.06)]"
            key={a.id}
          >
            <div className="flex items-start gap-3">
              <Avatar
                name={a.name}
                presence={agentPresence(a)}
                onClick={() => details(a.id)}
              />
              <button
                className="flex min-w-0 flex-1 flex-col text-left"
                aria-label={`与 ${a.name} 聊天`}
                disabled={opening !== null}
                onClick={() => openAgent(a)}
              >
                <div className="flex items-center justify-between gap-2">
                  <strong className="truncate text-sm font-semibold text-ink group-hover:text-accent-strong">
                    {a.name}
                  </strong>
                  <span className="flex-none rounded-full bg-[#edf5f1] px-2 py-0.5 text-[10px] font-medium text-accent">
                    {runtimeLabel(a)}
                  </span>
                </div>
                <span className="mt-0.5 font-mono text-[11px] text-muted">
                  {a.ref}
                  {a.unread > 0 && (
                    <span className="ml-1 text-accent font-sans">
                      · {a.unread} 条未读
                    </span>
                  )}
                </span>
                <p
                  className="mt-2.5 line-clamp-2 text-xs leading-relaxed text-ink/70"
                  title={a.work || a.description || a.cwd}
                >
                  {a.work || a.description || a.cwd || "暂无工作描述"}
                </p>
              </button>
            </div>
            <div className="mt-4 flex items-center justify-between border-t border-black/[0.04] pt-3">
              <button
                type="button"
                className="button secondary h-7 px-2.5 text-xs text-muted hover:text-ink"
                onClick={() => details(a.id)}
              >
                运行详情
              </button>
              <button
                type="button"
                className="button primary h-7 gap-1.5 px-3 text-xs"
                disabled={opening !== null}
                onClick={() => openAgent(a)}
              >
                {opening === a.id ? (
                  <LoaderCircle className="spin" size={13} />
                ) : (
                  <MessageSquare size={13} />
                )}
                进入对话
              </button>
            </div>
          </article>
        ))}
      </div>
      {!count ? (
        <div className="grid justify-items-center gap-3 px-5 py-16 text-center text-muted [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-ink [&_p]:text-xs [&_p]:leading-relaxed">
          {overview.discovery.scanning ? (
            <LoaderCircle className="spin text-accent" size={24} />
          ) : (
            <Users size={24} className="text-muted" />
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
          <div className="grid justify-items-center gap-3 px-5 py-16 text-center text-muted [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-ink [&_p]:text-xs [&_p]:leading-relaxed">
            <Search size={22} className="text-muted" />
            <h2>没有匹配的 Agent</h2>
            <button
              className="button secondary h-7 text-xs"
              onClick={() => setQuery("")}
            >
              清除搜索
            </button>
          </div>
        )
      )}
      {fresh.length > 0 && (
        <details className="settings-section temporary-runtimes mt-6 rounded-xl border border-black/[0.05] bg-white p-4">
          <summary className="cursor-pointer font-medium text-xs text-muted hover:text-ink">
            临时 Pi · {fresh.length}
          </summary>
          <p className="muted small-text mt-2 text-xs">
            这些实例不属于长期身份，不会自动创建账号。要使用长期身份，请新建
            Agent，再通过具名入口启动。
          </p>
          <div className="mt-2 space-y-1">
            {fresh.map((r) => (
              <p className="font-mono text-xs text-muted" key={r.runtimeId}>
                {agentName(r.cwd)} · PID {r.pid}
              </p>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
