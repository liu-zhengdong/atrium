import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as InputKeyEvent,
} from "react";
import { Search, X, MessageSquare, Hash, Bot } from "lucide-react";
import type { Chat, Overview, SearchResults } from "../../shared/schema.ts";
import { patchChat, searchAll } from "../api.ts";
import { ChatAvatar } from "../components/ChatAvatar.tsx";
import {
  agentPresence,
  Avatar,
  runtimeLabel,
  type Agent,
} from "../components/AgentAvatar.tsx";
import { isImeKey } from "../keys.ts";
import { convTime } from "../time.ts";
import { subjectAgentId } from "../chat/messages.ts";

type Hit =
  | { type: "agent"; id: string; agent: SearchResults["agents"][number] }
  | { type: "chat"; id: string; chat: Chat }
  | { type: "message"; id: string; message: SearchResults["messages"][number] };

function flatten(results: SearchResults): Hit[] {
  return [
    ...results.agents.map((agent) => ({
      type: "agent" as const,
      id: `agent:${agent.id}`,
      agent,
    })),
    ...results.chats.map((chat) => ({
      type: "chat" as const,
      id: `chat:${chat.id}`,
      chat,
    })),
    ...results.messages.map((message) => ({
      type: "message" as const,
      id: `msg:${message.chat_id}:${message.id}`,
      message,
    })),
  ];
}

export function GlobalSearch({
  overview,
  selectChat,
  openAgent,
  openingAgent,
  details,
  inspectAgent,
  refresh,
  openMessage,
  isOpen,
  onClose,
}: {
  overview: Overview | null;
  selectChat: (id: string) => void;
  openAgent: (agent: Agent) => void;
  openingAgent: string | null;
  details: (id: string) => void;
  inspectAgent: (id: string) => void;
  refresh: () => void;
  openMessage: (chatId: string, messageId: number) => void;
  isOpen: boolean;
  onClose: () => void;
}) {
  const agents = overview?.agents ?? [];
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults | null>(null);
  const [active, setActive] = useState(0);
  const seq = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const trimmed = query.trim();
  const hits = useMemo(() => (results ? flatten(results) : []), [results]);

  // 打开时自动聚焦输入框
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 30);
    } else {
      setQuery("");
      setResults(null);
      setActive(0);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!trimmed) {
      setResults(null);
      return;
    }
    const id = ++seq.current;
    const timer = setTimeout(() => {
      searchAll(trimmed)
        .then((found) => {
          if (seq.current === id) {
            setResults(found);
            setActive(0);
          }
        })
        .catch(() => {
          if (seq.current === id) {
            setResults({ chats: [], messages: [], agents: [] });
            setActive(0);
          }
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [trimmed]);

  useEffect(() => {
    document
      .getElementById(`search-hit-${hits[active]?.id ?? ""}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, hits]);

  async function openChat(chat: Chat) {
    if (chat.hidden) {
      await patchChat(chat.id, { hidden: false }).catch(() => {});
      refresh();
    }
    onClose();
    selectChat(chat.id);
  }

  function choose(hit: Hit) {
    if (hit.type === "agent") {
      const full = agents.find((agent) => agent.id === hit.agent.id);
      onClose();
      if (full) openAgent(full);
      else details(hit.agent.id);
      return;
    }
    if (hit.type === "chat") {
      void openChat(hit.chat);
      return;
    }
    onClose();
    openMessage(hit.message.chat_id, hit.message.id);
  }

  function onKeyDown(event: InputKeyEvent<HTMLInputElement>) {
    if (isImeKey(event.nativeEvent)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (!hits.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => (current + 1) % hits.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => (current - 1 + hits.length) % hits.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const hit = hits[active] ?? hits[0];
      if (hit) choose(hit);
    }
  }

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/25 p-4 pt-[15vh] backdrop-blur-xs transition-opacity animate-in fade-in duration-150"
      onClick={(e) => {
        if (!panelRef.current?.contains(e.target as Node)) {
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        className="w-full max-w-[560px] overflow-hidden rounded-2xl bg-white shadow-[0_16px_48px_rgba(24,32,25,0.14),0_4px_16px_rgba(24,32,25,0.06)]"
      >
        {/* 顶部搜索输入框 */}
        <div className="flex h-12 items-center gap-3 border-b border-black/[0.05] px-4">
          <Search size={16} className="text-[#6e7d72] flex-none" />
          <input
            ref={inputRef}
            className="plain-field min-w-0 flex-1 border-0 bg-transparent text-sm text-ink placeholder:text-muted/60 outline-none"
            value={query}
            placeholder="搜索会话、消息正文、Agent 名册..."
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {query ? (
            <button
              type="button"
              className="icon-button h-6 w-6 text-muted hover:text-ink"
              onClick={() => {
                setQuery("");
                setResults(null);
                inputRef.current?.focus();
              }}
            >
              <X size={14} />
            </button>
          ) : null}
        </div>

        {/* 搜索结果列表 */}
        <div className="max-h-[380px] overflow-y-auto p-2">
          {!trimmed ? null : results && hits.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted">
              未找到与 “{trimmed}” 匹配的内容
            </div>
          ) : (
            <div className="space-y-1">
              {hits.map((hit, idx) => {
                const isSelected = idx === active;
                const subject =
                  hit.type === "message"
                    ? subjectAgentId(hit.message)
                    : undefined;
                const target = subject
                  ? agents.find((agent) => agent.id === subject)
                  : undefined;
                return (
                  <div
                    key={hit.id}
                    id={`search-hit-${hit.id}`}
                    className={`flex w-full items-center gap-1 rounded-xl px-3 py-2 transition-colors ${
                      isSelected
                        ? "bg-[#edf5f1] text-[#316e50]"
                        : "hover:bg-[#f6f8f6] text-ink"
                    }`}
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                      onClick={() => choose(hit)}
                    >
                      {hit.type === "agent" && (
                        <>
                          <Avatar small name={hit.agent.name} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-xs font-semibold">
                                {hit.agent.name}
                              </span>
                              <span className="rounded bg-black/[0.04] px-1.5 py-0.2 font-mono text-[10px] text-muted">
                                {hit.agent.ref}
                              </span>
                            </div>
                            {hit.agent.description && (
                              <p className="truncate text-[11px] text-muted">
                                {hit.agent.description}
                              </p>
                            )}
                          </div>
                          <span className="text-[10px] text-muted">Agent</span>
                        </>
                      )}

                      {hit.type === "chat" && (
                        <>
                          <ChatAvatar chat={hit.chat} agents={agents} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-xs font-semibold">
                                {hit.chat.name}
                              </span>
                              {hit.chat.ref && (
                                <span className="rounded bg-black/[0.04] px-1.5 py-0.2 font-mono text-[10px] text-muted">
                                  {hit.chat.ref}
                                </span>
                              )}
                            </div>
                            {hit.chat.preview && (
                              <p className="truncate text-[11px] text-muted">
                                {hit.chat.preview}
                              </p>
                            )}
                          </div>
                          <span className="text-[10px] text-muted">会话</span>
                        </>
                      )}

                      {hit.type === "message" && (
                        <>
                          <div className="flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-[#f0f4f1] text-[#6e7d72]">
                            <MessageSquare size={13} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-xs font-medium">
                              {hit.message.text || "附件消息"}
                            </p>
                            <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted">
                              <span className="font-medium text-ink/80">
                                {hit.message.chat_name}
                              </span>
                              <span>·</span>
                              <span>{hit.message.sender_name}</span>
                              <span>·</span>
                              <span>{convTime(hit.message.created_at)}</span>
                            </div>
                          </div>
                          <span className="text-[10px] text-muted">消息</span>
                        </>
                      )}
                    </button>
                    {target && (
                      <button
                        type="button"
                        className="flex-none rounded px-1 text-[10px] text-[#316e50] underline underline-offset-[3px] hover:no-underline"
                        onClick={() => {
                          onClose();
                          inspectAgent(target.id);
                        }}
                      >
                        查看
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
