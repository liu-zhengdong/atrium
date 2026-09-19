import { useEffect, useRef, useState } from "react";
import {
  EyeOff,
  MessageSquare,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Search,
  Users,
  X,
} from "lucide-react";
import type { Chat, Overview, SearchResults } from "../../shared/schema.ts";
import { patchChat, searchAll } from "../api.ts";
import { ChatAvatar } from "../components/ChatAvatar.tsx";
import { Mark } from "../components/Mark.tsx";
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
  refresh,
  openMessage,
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
  refresh: () => void;
  openMessage: (chatId: string, messageId: number) => void;
}) {
  const agents = overview?.agents ?? [];
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    const id = ++seq.current;
    const timer = setTimeout(() => {
      searchAll(q)
        .then((found) => {
          if (seq.current === id) setResults(found);
        })
        .catch(() => {
          if (seq.current === id)
            setResults({ chats: [], messages: [], agents: [] });
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  async function setState(id: string, body: { hidden?: boolean; pinned?: boolean }) {
    setMenu(null);
    await patchChat(id, body).catch(() => {});
    refresh();
  }
  async function openSearchedChat(chat: Chat) {
    if (chat.hidden) {
      await patchChat(chat.id, { hidden: false }).catch(() => {});
      refresh();
    }
    setQuery("");
    selectChat(chat.id);
  }

  const searching = query.trim().length > 0;
  return (
    <aside className="sidebar">
      <div className="brand">
        <Mark />
        <span>Atrium</span>
        <span className="brand-caption">中庭</span>
      </div>
      <div className="mx-[2px] mb-[10px] flex h-[31px] flex-none items-center gap-[7px] rounded-[7px] border border-line bg-white px-[9px] text-placeholder focus-within:border-line-strong">
        <Search size={14} />
        <input
          className="plain-field min-w-0 flex-1 border-0 bg-transparent text-xs text-ink outline-none"
          value={query}
          placeholder="搜索会话、消息、Agent"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setQuery("");
          }}
        />
        {query && (
          <button
            className="icon-button p-[2px]"
            aria-label="清空搜索"
            onClick={() => setQuery("")}
          >
            <X size={13} />
          </button>
        )}
      </div>
      <nav aria-label="主导航">
        <button
          className={section === "chat" ? "selected" : ""}
          onClick={() => setSection("chat")}
        >
          <MessageSquare size={17} />
          会话
        </button>
        <button
          className={section === "agents" ? "selected" : ""}
          onClick={() => setSection("agents")}
        >
          <Users size={17} />
          Agents
        </button>
      </nav>
      {searching ? (
        <div className="search-results">
          {!results ? (
            <p className="sidebar-hint">搜索中…</p>
          ) : (
            <>
              {results.agents.length > 0 && (
                <div className="search-group">
                  <div className="section-label">Agents</div>
                  {results.agents.map((agent) => {
                    const full = agents.find((a) => a.id === agent.id);
                    return (
                      <div className="agent-row" key={agent.id}>
                        <Avatar
                          name={agent.name}
                          online={full?.available ?? false}
                          small
                          onClick={() => details(agent.id)}
                        />
                        <button
                          className="agent-row-open"
                          onClick={() => {
                            setQuery("");
                            if (full) openAgent(full);
                            else details(agent.id);
                          }}
                          disabled={openingAgent !== null}
                        >
                          <span>
                            <strong>{agent.name}</strong>
                            <small>
                              {agent.description ||
                                (full ? runtimeLabel(full) : "")}
                            </small>
                          </span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
              {results.chats.length > 0 && (
                <div className="search-group">
                  <div className="section-label">会话</div>
                  {results.chats.map((chat) => (
                    <button
                      key={chat.id}
                      className="chat-row"
                      onClick={() => void openSearchedChat(chat)}
                    >
                      <ChatAvatar chat={chat} agents={agents} />
                      <span className="chat-row-main">
                        <span className="chat-row-top">
                          <strong>{chat.name}</strong>
                          {chat.hidden && <em className="hidden-tag">已隐藏</em>}
                          <time>{convTime(chat.updated_at)}</time>
                        </span>
                        <span className="chat-row-bottom">
                          <small>{chat.preview ?? ""}</small>
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {results.messages.length > 0 && (
                <div className="search-group">
                  <div className="section-label">消息</div>
                  {results.messages.map((message) => (
                    <button
                      key={`${message.chat_id}-${message.id}`}
                      className="chat-row"
                      onClick={() => {
                        setQuery("");
                        openMessage(message.chat_id, message.id);
                      }}
                    >
                      <span className="chat-row-main">
                        <span className="chat-row-top">
                          <strong>{message.chat_name}</strong>
                          <time>{convTime(message.created_at)}</time>
                        </span>
                        <span className="chat-row-bottom">
                          <small>
                            {message.sender_name}：{message.text}
                          </small>
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {!results.agents.length &&
                !results.chats.length &&
                !results.messages.length && (
                  <p className="sidebar-hint">
                    没有匹配「{query.trim()}」的内容
                  </p>
                )}
            </>
          )}
        </div>
      ) : section === "chat" ? (
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
              <div
                key={chat.id}
                className={`chat-row-wrap ${chat.id === chatId ? "selected" : ""}`}
              >
                <button
                  className="chat-row"
                  onClick={() => selectChat(chat.id)}
                >
                  <ChatAvatar chat={chat} agents={agents} />
                  <span className="chat-row-main">
                    <span className="chat-row-top">
                      <strong>{chat.name}</strong>
                      {chat.pinned && <Pin size={11} className="pin-mark" />}
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
                <button
                  className="row-menu-button icon-button"
                  aria-label="会话操作"
                  onClick={() => setMenu(menu === chat.id ? null : chat.id)}
                >
                  <MoreHorizontal size={15} />
                </button>
                {menu === chat.id && (
                  <>
                    <div
                      className="menu-overlay"
                      onClick={() => setMenu(null)}
                    />
                    <div className="row-menu" role="menu">
                      <button
                        onClick={() =>
                          void setState(chat.id, { pinned: !chat.pinned })
                        }
                      >
                        {chat.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                        {chat.pinned ? "取消置顶" : "置顶"}
                      </button>
                      <button
                        onClick={() => void setState(chat.id, { hidden: true })}
                      >
                        <EyeOff size={14} />
                        隐藏
                      </button>
                    </div>
                  </>
                )}
              </div>
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
