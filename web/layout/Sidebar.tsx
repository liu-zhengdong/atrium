import { useEffect, useRef, useState } from "react";
import {
  EyeOff,
  MessageSquare,
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

/** 侧栏列表行共享样式（会话列表与搜索结果行一致）。 */
const rowMain = "flex min-w-0 flex-1 flex-col gap-px";
const rowTop = "flex min-w-0 items-center justify-between gap-2";
const rowName = "truncate text-[13px] font-medium";
const rowTime = "flex-none text-[10px] text-[#a8a394]";
const rowPreview =
  "mt-0.5 min-w-0 flex-1 truncate text-[11px] leading-[1.6] text-[#858278]";
const chatRow =
  "flex w-full min-w-0 flex-1 items-center gap-2.5 rounded-[7px] p-2.5 text-left";
const chatRowHover = `${chatRow} hover:bg-[#efeee9]`;
const slotAction =
  "relative flex h-[22px] w-[22px] items-center justify-center rounded-md text-[#6d6a5e] hover:bg-[#e4e2db] hover:text-[#3c3b34]";
const agentRow =
  "agent-row flex w-full items-center gap-2.5 rounded-[7px] px-2.5 py-[9px] text-left hover:bg-[#efeee9]";
const sectionLabel =
  "mb-1.5 flex items-center justify-between px-2.5 text-[11px] tracking-[0.025em] text-[#848176]";
const hint = "px-[11px] py-[9px] text-xs text-[#969185]";
const navButton = (active: boolean) =>
  `flex items-center gap-[11px] rounded-[7px] px-3 py-[9px] text-left text-[13px] text-[#77766e] hover:bg-[#efeee9] ${
    active ? "bg-[#eeede7] font-[550] text-ink" : ""
  }`;
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

  async function setState(
    id: string,
    body: { hidden?: boolean; pinned?: boolean },
  ) {
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
    <aside className="sidebar flex w-[258px] flex-none flex-col border-r border-line bg-surface px-3.5 max-[720px]:w-[220px] max-[720px]:px-[9px]">
      <div className="flex h-[83px] items-center gap-2.5 px-[11px] max-[720px]:h-[72px] max-[560px]:h-[74px]">
        <Mark className="h-[29px] w-[29px] text-[#72634a]" />
        <span className="text-[21px] font-[620] tracking-[-0.05em]">
          Atrium
        </span>
        <span className="ml-[3px] mt-1 text-xs text-[#8e897d]">中庭</span>
      </div>
      <div className="mx-[2px] mb-[10px] flex h-[31px] flex-none items-center gap-[7px] rounded-[7px] border border-line bg-white px-[9px] text-placeholder focus-within:border-line-strong">
        <Search size={14} />
        <input
          className="min-w-0 flex-1 border-0 bg-transparent text-xs text-ink outline-none"
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
      <nav aria-label="主导航" className="mb-[29px] grid gap-[3px]">
        <button
          className={navButton(section === "chat")}
          onClick={() => setSection("chat")}
        >
          <MessageSquare size={17} />
          会话
        </button>
        <button
          className={navButton(section === "agents")}
          onClick={() => setSection("agents")}
        >
          <Users size={17} />
          Agents
        </button>
      </nav>
      {searching ? (
        <div className="min-h-0 flex-1 overflow-auto">
          {!results ? (
            <p className={hint}>搜索中…</p>
          ) : (
            <>
              {results.agents.length > 0 && (
                <div className="mb-[18px]">
                  <div className={sectionLabel}>Agents</div>
                  {results.agents.map((agent) => {
                    const full = agents.find((a) => a.id === agent.id);
                    return (
                      <div className={agentRow} key={agent.id}>
                        <Avatar
                          name={agent.name}
                          online={full?.available ?? false}
                          small
                          onClick={() => details(agent.id)}
                        />
                        <button
                          className="agent-row-open flex min-w-0 flex-1 items-center gap-2 text-left"
                          onClick={() => {
                            setQuery("");
                            if (full) openAgent(full);
                            else details(agent.id);
                          }}
                          disabled={openingAgent !== null}
                        >
                          <span className="flex min-w-0 flex-1 flex-col">
                            <strong className={rowName}>{agent.name}</strong>
                            <small className={rowPreview}>
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
                <div className="mb-[18px]">
                  <div className={sectionLabel}>会话</div>
                  {results.chats.map((chat) => (
                    <button
                      key={chat.id}
                      className={chatRowHover}
                      onClick={() => void openSearchedChat(chat)}
                    >
                      <ChatAvatar chat={chat} agents={agents} />
                      <span className={rowMain}>
                        <span className={rowTop}>
                          <strong className={rowName}>{chat.name}</strong>
                          {chat.hidden && (
                            <em className="flex-none rounded bg-[#eae4d7] px-[5px] text-[10px] not-italic text-[#8a7150]">
                              已隐藏
                            </em>
                          )}
                          <time className={rowTime}>
                            {convTime(chat.updated_at)}
                          </time>
                        </span>
                        <span className={rowTop}>
                          <small className={rowPreview}>
                            {chat.preview ?? ""}
                          </small>
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {results.messages.length > 0 && (
                <div className="mb-[18px]">
                  <div className={sectionLabel}>消息</div>
                  {results.messages.map((message) => (
                    <button
                      key={`${message.chat_id}-${message.id}`}
                      className={chatRowHover}
                      onClick={() => {
                        setQuery("");
                        openMessage(message.chat_id, message.id);
                      }}
                    >
                      <span className={rowMain}>
                        <span className={rowTop}>
                          <strong className={rowName}>
                            {message.chat_name}
                          </strong>
                          <time className={rowTime}>
                            {convTime(message.created_at)}
                          </time>
                        </span>
                        <span className={rowTop}>
                          <small className={rowPreview}>
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
                  <p className={hint}>没有匹配「{query.trim()}」的内容</p>
                )}
            </>
          )}
        </div>
      ) : section === "chat" ? (
        <div className="mb-6 flex min-h-0 flex-1 flex-col">
          <div className={sectionLabel}>
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
          <div className="min-h-0 flex-1 overflow-auto">
            {overview?.chats.map((chat) => (
              <div
                key={chat.id}
                className={`group/row relative rounded-[7px] ${
                  chat.id === chatId ? "bg-[#eeede7]" : "hover:bg-[#efeee9]"
                }`}
              >
                <button
                  className="absolute inset-0 rounded-[7px]"
                  onClick={() => selectChat(chat.id)}
                  aria-label={chat.name}
                />
                <div className="pointer-events-none relative flex items-center gap-2.5 p-2.5">
                  <ChatAvatar chat={chat} agents={agents} />
                  <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <strong className={rowName}>{chat.name}</strong>
                      {chat.pinned && (
                        <Pin size={11} className="flex-none text-[#a09b8d]" />
                      )}
                    </span>
                    <span className="col-start-2 row-start-1 grid justify-items-end">
                      <time
                        className={`${rowTime} col-start-1 row-start-1 group-hover/row:invisible group-focus-within/row:invisible`}
                      >
                        {convTime(chat.updated_at)}
                      </time>
                      <span className="pointer-events-auto col-start-1 row-start-1 flex invisible items-center group-hover/row:visible group-focus-within/row:visible">
                        <button
                          className={slotAction}
                          aria-label={chat.pinned ? "取消置顶" : "置顶"}
                          onClick={() =>
                            void setState(chat.id, { pinned: !chat.pinned })
                          }
                        >
                          {chat.pinned ? (
                            <PinOff size={14} />
                          ) : (
                            <Pin size={14} />
                          )}
                        </button>
                        <button
                          className={slotAction}
                          aria-label="隐藏"
                          onClick={() =>
                            void setState(chat.id, { hidden: true })
                          }
                        >
                          <EyeOff size={14} />
                        </button>
                      </span>
                    </span>
                    <span className="col-span-2 flex min-w-0 items-center gap-2">
                      <small className={rowPreview}>
                        {chat.preview ?? "开始这段对话"}
                      </small>
                      {(chat.unread ?? 0) > 0 &&
                        (chat.mine ? (
                          <span className="badge">{chat.unread}</span>
                        ) : (
                          <span
                            className="h-[7px] w-[7px] flex-none rounded-full bg-[#b6ac99]"
                            title="有新动态"
                          />
                        ))}
                    </span>
                  </span>
                </div>
              </div>
            ))}
            {overview && !overview.chats.length && (
              <p className={hint}>还没有会话，从 Agents 里选一位开始</p>
            )}
          </div>
        </div>
      ) : (
        <div className="mb-6 min-h-0 flex-1 overflow-auto">
          <div className={sectionLabel}>
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
            <div className={agentRow} key={a.id}>
              <Avatar
                name={a.name}
                online={a.available}
                small
                onClick={() => details(a.id)}
              />
              <button
                className="agent-row-open flex min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() => void openAgent(a)}
                disabled={openingAgent !== null}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <strong className={rowName}>{a.name}</strong>
                  <small className={rowPreview}>
                    {a.work || runtimeLabel(a)}
                  </small>
                </span>
                {a.unread > 0 && <span className="badge">{a.unread}</span>}
              </button>
            </div>
          ))}
          {overview && !agents.length && (
            <p className={hint}>创建你的第一位 Agent</p>
          )}
        </div>
      )}
      <footer className="workspace flex items-center gap-[7px] border-t border-line px-2.5 py-[18px] text-[11px] text-[#898579]">
        <span
          className={`h-[5px] w-[5px] rounded-full ${connected ? "bg-[#7b906f]" : "bg-[#c29758]"}`}
        />
        {connected ? "本机工作区" : "正在重新连接…"}
        <span className="ml-auto text-[#a5a093]">v0.1</span>
      </footer>
    </aside>
  );
}
