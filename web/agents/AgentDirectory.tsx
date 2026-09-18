import { useState } from "react";
import {
  Inbox,
  LoaderCircle,
  MessageSquare,
  Plus,
  Search,
  Users,
} from "lucide-react";
import type { Overview } from "../../shared/schema.ts";
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
                  {a.ref} · {runtimeLabel(a)}
                  {a.unread > 0 && <> · {a.unread} 条未读</>}
                </span>
                <span
                  className="agent-work"
                  title={a.work || a.description || a.cwd}
                >
                  {a.work || a.description || a.cwd}
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
            创建一位长期 Agent，身份与聊天会一直保留。
            <br />
            普通 Pi 临时实例不会自动成为长期身份。
          </p>
        </div>
      ) : (
        !agents.length && (
          <div className="directory-empty">
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
