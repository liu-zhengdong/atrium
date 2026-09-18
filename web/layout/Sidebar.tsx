import { MessageSquare, Plus, Users } from "lucide-react";
import type { Overview } from "../../shared/schema.ts";
import { Mark } from "../components/Mark.tsx";
import { ChatAvatar } from "../components/ChatAvatar.tsx";
import { convTime } from "../time.ts";
import {
  Avatar,
  runtimeLabel,
  type Agent,
} from "../components/AgentAvatar.tsx";
export type Section = "agents" | "chat";
export function Sidebar({
  overview,
  section,
  setSection,
  chatId,
  selectChat,
  create,
  openAgent,
  openingAgent,
  connected,
  details,
}: {
  overview: Overview | null;
  section: Section;
  setSection: (section: Section) => void;
  chatId: string | null;
  selectChat: (id: string) => void;
  create: (kind: "agent" | "chat") => void;
  openAgent: (agent: Agent) => void;
  openingAgent: string | null;
  connected: boolean;
  details: (id: string) => void;
}) {
  const agents = overview?.agents ?? [];
  return (
    <aside className="sidebar">
      <div className="brand">
        <Mark />
        <span>Atrium</span>
        <span className="brand-caption">中庭</span>
      </div>
      <nav aria-label="主导航">
        <button
          className={section === "chat" ? "selected" : ""}
          onClick={() => {
            setSection("chat");
          }}
        >
          <MessageSquare size={17} />
          会话
        </button>
        <button
          className={section === "agents" ? "selected" : ""}
          onClick={() => {
            setSection("agents");
          }}
        >
          <Users size={17} />
          Agents
        </button>
      </nav>
      {section === "chat" ? (
        <div className="sidebar-section chat-section">
          <div className="section-label">
            会话
            <button
              className="icon-button"
              aria-label="新建会话"
              onClick={() => {
                create("chat");
              }}
            >
              <Plus size={16} />
            </button>
          </div>
          <div className="chat-list">
            {overview?.chats.map((chat) => (
              <button
                key={chat.id}
                className={`chat-row ${chat.id === chatId ? "selected" : ""}`}
                onClick={() => selectChat(chat.id)}
              >
                <ChatAvatar chat={chat} agents={agents} />
                <span className="chat-row-main">
                  <span className="chat-row-top">
                    <strong>{chat.name}</strong>
                    <time>{convTime(chat.updated_at)}</time>
                  </span>
                  <span className="chat-row-bottom">
                    <small>{chat.preview ?? "开始这段对话"}</small>
                    {(chat.unread ?? 0) > 0 &&
                      (chat.mine ? (
                        <span className="badge">{chat.unread}</span>
                      ) : (
                        <span className="dot" title="有新动态" />
                      ))}
                  </span>
                </span>
              </button>
            ))}
            {overview && !overview.chats.length && (
              <p className="sidebar-hint">
                还没有会话，从 Agents 里选一位开始
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="sidebar-section agents-section">
          <div className="section-label">
            Agents
            <button
              className="icon-button"
              aria-label="新建 Agent"
              onClick={() => {
                create("agent");
              }}
            >
              <Plus size={16} />
            </button>
          </div>
          {agents.map((a) => (
            <div className="agent-row" key={a.id}>
              <Avatar
                name={a.name}
                online={a.available}
                small
                onClick={() => details(a.id)}
              />
              <button
                className="agent-row-open"
                onClick={() => void openAgent(a)}
                disabled={openingAgent !== null}
              >
                <span>
                  <strong>{a.name}</strong>
                  <small>{a.work || runtimeLabel(a)}</small>
                </span>
                {a.unread > 0 && <span className="badge">{a.unread}</span>}
              </button>
            </div>
          ))}
          {overview && !agents.length && (
            <p className="sidebar-hint">创建你的第一位 Agent</p>
          )}
        </div>
      )}
      <footer className="workspace">
        <span className={`connection-dot ${connected ? "ready" : ""}`} />
        {connected ? "本机工作区" : "正在重新连接…"}
        <span>v0.1</span>
      </footer>
    </aside>
  );
}
