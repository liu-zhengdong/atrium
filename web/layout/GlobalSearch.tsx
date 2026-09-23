import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as InputKeyEvent,
} from "react";
import { Search, X } from "lucide-react";
import type { Chat, Overview, SearchResults } from "../../shared/schema.ts";
import { patchChat, searchAll } from "../api.ts";
import { ChatAvatar } from "../components/ChatAvatar.tsx";
import {
  agentPresence,
  Avatar,
  runtimeLabel,
  type Agent,
} from "../components/AgentAvatar.tsx";
import { convTime } from "../time.ts";

type Hit =
  | { type: "agent"; id: string; agent: SearchResults["agents"][number] }
  | { type: "chat"; id: string; chat: Chat }
  | { type: "message"; id: string; message: SearchResults["messages"][number] };

const sectionTitle = {
  agent: "Agents",
  chat: "会话",
  message: "消息",
} as const;

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

const row =
  "flex w-full min-w-0 items-center gap-2.5 rounded-[7px] px-2.5 py-2 text-left";
const name = "truncate text-[13px] font-medium text-ink";
const preview =
  "mt-0.5 min-w-0 truncate text-[11px] leading-[1.6] text-[#858278]";
const timeCls = "flex-none text-[10px] text-[#a8a394]";

export function GlobalSearch({
  overview,
  selectChat,
  openAgent,
  openingAgent,
  details,
  refresh,
  openMessage,
}: {
  overview: Overview | null;
  selectChat: (id: string) => void;
  openAgent: (agent: Agent) => void;
  openingAgent: string | null;
  details: (id: string) => void;
  refresh: () => void;
  openMessage: (chatId: string, messageId: number) => void;
}) {
  const agents = overview?.agents ?? [];
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults | null>(null);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const [isMac, setIsMac] = useState(true);
  const seq = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const trimmed = query.trim();
  const hits = useMemo(() => (results ? flatten(results) : []), [results]);

  useEffect(() => {
    setIsMac(/Mac|iPhone|iPad/.test(navigator.platform));
  }, []);

  useEffect(() => {
    if (!trimmed) {
      setResults(null);
      setOpen(false);
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
    }, 250);
    return () => clearTimeout(timer);
  }, [trimmed]);

  useEffect(() => {
    if (trimmed && focused) setOpen(true);
  }, [trimmed, focused]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

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
    closeSearch();
    selectChat(chat.id);
  }

  function closeSearch() {
    setQuery("");
    setResults(null);
    setOpen(false);
    inputRef.current?.blur();
  }

  function choose(hit: Hit) {
    if (hit.type === "agent") {
      const full = agents.find((agent) => agent.id === hit.agent.id);
      closeSearch();
      if (full) openAgent(full);
      else details(hit.agent.id);
      return;
    }
    if (hit.type === "chat") {
      void openChat(hit.chat);
      return;
    }
    closeSearch();
    openMessage(hit.message.chat_id, hit.message.id);
  }

  function onKeyDown(event: InputKeyEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (trimmed) {
        setQuery("");
        setResults(null);
        setOpen(false);
      } else inputRef.current?.blur();
      return;
    }
    if (!trimmed) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      if (hits.length) setActive((current) => (current + 1) % hits.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      if (hits.length)
        setActive((current) => (current - 1 + hits.length) % hits.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const hit = hits[active] ?? hits[0];
      if (hit) choose(hit);
    }
  }

  const showPanel = open && Boolean(trimmed);
  const shortcut = isMac ? "⌘K" : "Ctrl+K";

  return (
    <div ref={rootRef} className="relative min-w-0">
      <label
        className={`flex h-8 items-center gap-2 rounded-lg border px-2.5 transition-all duration-150 ${
          focused
            ? "border-black/[0.06] bg-white shadow-[0_1px_4px_rgba(24,32,25,0.06)]"
            : "border-transparent bg-[#f0f4f1] hover:bg-[#ebf0ec]"
        }`}
      >
        <Search size={14} className="flex-none text-[#6e7d72]" />
        <input
          ref={inputRef}
          className="plain-field min-w-0 flex-1 border-0 bg-transparent text-[13px] text-ink"
          value={query}
          placeholder="搜索会话、消息、Agent"
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-label="全局搜索"
          aria-expanded={showPanel}
          aria-autocomplete="list"
          aria-controls={showPanel ? "global-search-results" : undefined}
          aria-activedescendant={
            showPanel && hits[active]
              ? `search-hit-${hits[active].id}`
              : undefined
          }
          onChange={(event) => setQuery(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            setOpen(false);
          }}
          onKeyDown={onKeyDown}
        />
        <span className="flex w-7 flex-none items-center justify-end">
          {query ? (
            <button
              type="button"
              className="icon-button h-[22px] w-[22px] p-0"
              aria-label="清空搜索"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setQuery("");
                setResults(null);
                setOpen(false);
                inputRef.current?.focus();
              }}
            >
              <X size={13} />
            </button>
          ) : (
            !focused && (
              <kbd
                className="rounded bg-[#e2eae4] px-1.5 py-0.5 text-[10px] font-medium text-muted"
                aria-hidden
              >
                {shortcut}
              </kbd>
            )
          )}
        </span>
      </label>
      {showPanel && (
        <div
          id="global-search-results"
          role="listbox"
          aria-label="搜索结果"
          className="absolute inset-x-0 top-full z-30 mt-1.5 max-h-[min(420px,calc(100dvh-72px))] overflow-auto rounded-xl border border-black/[0.05] bg-white p-1.5 shadow-[0_12px_32px_rgba(24,32,25,0.08),0_2px_8px_rgba(24,32,25,0.04)]"
          onMouseDown={(event) => event.preventDefault()}
        >
          {!results ? (
            <p className="px-2.5 py-2 text-xs text-muted">搜索中…</p>
          ) : hits.length === 0 ? (
            <p className="px-2.5 py-2 text-xs text-muted">
              没有匹配「{trimmed}」的内容
            </p>
          ) : (
            hits.map((hit, index) => {
              const full =
                hit.type === "agent"
                  ? agents.find((agent) => agent.id === hit.agent.id)
                  : undefined;
              return (
                <div key={hit.id}>
                  {(index === 0 || hits[index - 1].type !== hit.type) && (
                    <div className="px-2.5 pb-1 pt-1.5 text-[11px] tracking-[0.025em] text-muted">
                      {sectionTitle[hit.type]}
                    </div>
                  )}
                  <button
                    type="button"
                    role="option"
                    id={`search-hit-${hit.id}`}
                    aria-selected={index === active}
                    disabled={hit.type === "agent" && openingAgent !== null}
                    className={`${row} ${
                      index === active ? "bg-[#edf5f1]" : "hover:bg-[#f4f7f5]"
                    }`}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => choose(hit)}
                  >
                    {hit.type === "agent" && (
                      <>
                        <Avatar
                          name={hit.agent.name}
                          presence={agentPresence(full)}
                          small
                        />
                        <span className="min-w-0 flex-1">
                          <strong className={name}>{hit.agent.name}</strong>
                          <small className={`block ${preview}`}>
                            {hit.agent.description ||
                              (full ? runtimeLabel(full) : "")}
                          </small>
                        </span>
                      </>
                    )}
                    {hit.type === "chat" && (
                      <>
                        <ChatAvatar chat={hit.chat} agents={agents} />
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 items-center justify-between gap-2">
                            <strong className={name}>{hit.chat.name}</strong>
                            <span className="flex flex-none items-center gap-1.5">
                              {hit.chat.hidden && (
                                <em className="rounded bg-[#e8eee9] px-[5px] text-[10px] not-italic text-muted">
                                  已隐藏
                                </em>
                              )}
                              <time className={timeCls}>
                                {convTime(hit.chat.updated_at)}
                              </time>
                            </span>
                          </span>
                          <small className={`block ${preview}`}>
                            {hit.chat.preview ?? ""}
                          </small>
                        </span>
                      </>
                    )}
                    {hit.type === "message" && (
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center justify-between gap-2">
                          <strong className={name}>
                            {hit.message.chat_name}
                          </strong>
                          <time className={timeCls}>
                            {convTime(hit.message.created_at)}
                          </time>
                        </span>
                        <small className={`block ${preview}`}>
                          {hit.message.sender_name}：{hit.message.text}
                        </small>
                      </span>
                    )}
                  </button>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
