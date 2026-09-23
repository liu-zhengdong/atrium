import { useState } from "react";
import {
  Activity,
  ChevronRight,
  LoaderCircle,
  MessageSquare,
  Plus,
  Search,
  Users,
} from "lucide-react";
import type { Overview } from "../../shared/schema.ts";
import { api } from "../api.ts";
import { AgentFailure } from "../components/AgentFailure.tsx";
import { agentName } from "../../shared/agent-name.ts";
import {
  agentPresence,
  Avatar,
  statusNote,
  type Agent,
} from "../components/AgentAvatar.tsx";

export function AgentDirectory({
  overview,
  opening,
  openAgent,
  details,
  create,
  refresh,
}: {
  overview: Overview;
  opening: string | null;
  openAgent: (a: Agent) => void;
  details: (id: string) => void;
  create: () => void;
  refresh: () => void;
}) {
  const [query, setQuery] = useState("");
  const [retryError, setRetryError] = useState("");
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
      {retryError && (
        <p role="alert" className="error mb-3">
          {retryError}
        </p>
      )}
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        {count > 0 ? (
          <label className="flex h-7 w-64 items-center gap-2 rounded-lg bg-white px-2.5 text-muted shadow-[0_1px_3px_rgba(0,0,0,0.04)] transition-all hover:shadow-[0_2px_6px_rgba(0,0,0,0.06)] focus-within:shadow-[0_2px_8px_rgba(49,110,80,0.12)]">
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
            className="group relative flex flex-col justify-between rounded-xl bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04),0_6px_16px_rgba(0,0,0,0.03)] transition-all duration-150 hover:-translate-y-0.5 hover:shadow-[0_4px_12px_rgba(0,0,0,0.06),0_12px_28px_rgba(0,0,0,0.06)]"
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
                  {statusNote(a) && (
                    <span className="flex-none rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                      {statusNote(a)}
                    </span>
                  )}
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
                  className={`mt-2.5 line-clamp-2 text-xs leading-relaxed ${
                    a.description ? "text-ink/70" : "text-muted/60"
                  }`}
                  title={a.description || undefined}
                >
                  {a.description || "还没有介绍"}
                </p>
                {a.work && (
                  <p
                    className="mt-1.5 flex min-w-0 items-center gap-1.5 text-xs text-accent-strong"
                    title={a.work}
                  >
                    <Activity size={12} className="flex-none" />
                    <span className="truncate">{a.work}</span>
                  </p>
                )}
              </button>
            </div>
            {a.failure && (
              <div className="mt-3">
                <AgentFailure
                  agent={a}
                  retry={() => {
                    setRetryError("");
                    void api(`/agents/${a.id}/retry`, "POST")
                      .then(refresh)
                      .catch((e) => setRetryError(String(e)));
                  }}
                />
              </div>
            )}
            <div className="mt-4 flex items-center justify-between">
              <button
                type="button"
                className="button secondary h-7 px-2.5 text-xs text-muted hover:text-ink hover:bg-[#f0f4f1]"
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
        <details className="group mt-6 rounded-xl bg-white p-4 text-xs shadow-[0_1px_3px_rgba(0,0,0,0.03),0_4px_12px_rgba(0,0,0,0.02)] transition-all hover:shadow-[0_2px_8px_rgba(0,0,0,0.05)]">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 font-medium text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
            <ChevronRight
              size={14}
              className="transition-transform group-open:rotate-90"
              aria-hidden="true"
            />
            临时 Pi · {fresh.length}
          </summary>
          <p className="mt-2 leading-relaxed text-muted">
            这些实例不属于长期身份，不会自动创建账号。要使用长期身份，请新建
            Agent，再通过具名入口启动。
          </p>
          <div className="mt-3 space-y-1.5">
            {fresh.map((r) => (
              <p className="font-mono text-muted" key={r.runtimeId}>
                {agentName(r.cwd)} · PID {r.pid}
              </p>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
