import { Hash, MessageSquare, Plus, Radio, Users } from "lucide-react";
import type { Overview } from "../../shared/schema.ts";
import { Mark } from "../components/Mark.tsx";
import {
  Avatar,
  runtimeLabel,
  type Agent,
} from "../components/AgentAvatar.tsx";
export type Section = "agents" | "chat" | "events";
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
  return (
    <aside className="sidebar">
      <div className="brand">
        <Mark />
        <span>Atrium</span>
        <span className="brand-caption">中庭</span>
      </div>
      <nav aria-label="主导航">
        <button
          className={section === "agents" ? "selected" : ""}
          onClick={() => {
            setSection("agents");
          }}
        >
          <Users size={17} />
          Agents
        </button>
        <button
          className={section === "chat" ? "selected" : ""}
          onClick={() => {
            setSection("chat");
          }}
        >
          <MessageSquare size={17} />
          聊天
        </button>
        <button
          className={section === "events" ? "selected" : ""}
          onClick={() => {
            setSection("events");
          }}
        >
          <Radio size={17} />
          事件订阅
        </button>
      </nav>
      <div className="sidebar-section">
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
              className={`chat-row ${chat.id === chatId && section === "chat" ? "selected" : ""}`}
              onClick={() => selectChat(chat.id)}
            >
              <span className="chat-symbol">
                {chat.kind === "group" ? (
                  <Hash size={18} />
                ) : (
                  <MessageSquare size={17} />
                )}
              </span>
              <span>
                <strong>{chat.name}</strong>
                <small>{chat.preview ?? "开始这段对话"}</small>
              </span>
            </button>
          ))}
          {overview && !overview.chats.length && (
            <p className="sidebar-hint">还没有会话</p>
          )}
        </div>
      </div>
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
        {overview?.agents.map((a) => (
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
        {overview && !overview.agents.length && (
          <p className="sidebar-hint">从名册选择一位 Agent</p>
        )}
      </div>
      <footer className="workspace">
        <span className={`connection-dot ${connected ? "ready" : ""}`} />
        {connected ? "本机工作区" : "正在重新连接…"}
        <span>v0.1</span>
      </footer>
    </aside>
  );
}
