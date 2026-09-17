import { useState } from "react";
import {
  Inbox,
  LoaderCircle,
  MessageSquare,
  Plus,
  Search,
  Users,
} from "lucide-react";
import type { LiveRuntime, Overview } from "../../shared/schema.ts";
import { agentName } from "../../shared/agent-name.ts";
import {
  Avatar,
  runtimeLabel,
  type Agent,
} from "../components/AgentAvatar.tsx";

export function AgentDirectory({
  overview,
  opening,
  openAgent,
  openRuntime,
  details,
  create,
}: {
  overview: Overview;
  opening: string | null;
  openAgent: (a: Agent) => void;
  openRuntime: (r: LiveRuntime) => void;
  details: (id: string) => void;
  create: () => void;
}) {
  const [query, setQuery] = useState("");
  const discovered = overview.discovery.runtimes.filter((r) => !r.bound_agent);
  const count = overview.agents.length + discovered.length;
  const matches = (name: string, cwd: string) =>
    `${name} ${cwd}`.toLowerCase().includes(query.trim().toLowerCase());
  const agents = overview.agents.filter((a) => matches(a.name, a.cwd));
  const fresh = discovered.filter((r) => matches(agentName(r.cwd), r.cwd));
  return (
    <section className="directory">
      <header className="directory-header">
        <div>
          <h1>
            Agents <span>{count}</span>
          </h1>
          <p>选择一位 Agent，开始对话。</p>
        </div>
        <button className="button secondary" onClick={create}>
          <Plus size={16} />
          新建 Agent
        </button>
      </header>
      {count > 0 && (
        <label className="directory-search">
          <Search size={16} />
          <input
            aria-label="搜索 Agent"
            placeholder="搜索名字或工作目录"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      )}
      {overview.discovery.error && (
        <p role="alert" className="error directory-alert">
          {overview.discovery.error} 已有会话仍可查看，正在后台重试。
        </p>
      )}
      <div className="agent-grid">
        {agents.map((a) => (
          <article className="agent-card" key={a.id}>
            <button
              className="agent-open"
              aria-label={`与 ${a.name} 聊天`}
              disabled={opening !== null}
              onClick={() => openAgent(a)}
            >
              <Avatar name={a.name} online={a.available} />
              <span className="agent-card-copy">
                <strong>{a.name}</strong>
                <span className="agent-state">
                  {runtimeLabel(a)}
                  {a.unread > 0 && <> · {a.unread} 条未读</>}
                </span>
                <span className="agent-work" title={a.work || a.cwd}>
                  {a.work || a.cwd}
                </span>
              </span>
              <span className="agent-card-action">
                {opening === a.id ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <MessageSquare size={16} />
                )}
              </span>
            </button>
            <button
              className="icon-button agent-details"
              aria-label={`查看 ${a.name} 的详情`}
              onClick={() => details(a.id)}
            >
              <Inbox size={16} />
            </button>
          </article>
        ))}
        {fresh.map((r) => (
          <article className="agent-card" key={r.runtimeId}>
            <button
              className="agent-open"
              aria-label={`与 ${agentName(r.cwd)} 聊天，进程 ${r.pid}`}
              disabled={opening !== null}
              onClick={() => openRuntime(r)}
            >
              <Avatar name={agentName(r.cwd)} online />
              <span className="agent-card-copy">
                <strong>{agentName(r.cwd)}</strong>
                <span className="agent-state">在线 · Pi · {r.pid}</span>
                <span className="agent-work" title={r.cwd}>
                  {r.cwd}
                </span>
              </span>
              <span className="agent-card-action">
                {opening === r.runtimeId ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <MessageSquare size={16} />
                )}
              </span>
            </button>
          </article>
        ))}
      </div>
      {!count ? (
        <div className="directory-empty">
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
            已启用 pi-acp 的 Pi 会自动出现在这里。
            <br />
            也可以新建一位 Agent。
          </p>
        </div>
      ) : (
        !agents.length &&
        !fresh.length && (
          <div className="directory-empty">
            <Search size={24} />
            <h2>没有匹配的 Agent</h2>
            <button className="button secondary" onClick={() => setQuery("")}>
              清除搜索
            </button>
          </div>
        )
      )}
    </section>
  );
}
