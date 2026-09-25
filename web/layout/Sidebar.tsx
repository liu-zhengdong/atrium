import {
  EyeOff,
  History,
  MessageSquare,
  Pin,
  PinOff,
  Plus,
  Settings2,
  Users,
} from "lucide-react";
import { unreadLabel, type Overview } from "../../shared/schema.ts";
import { patchChat } from "../api.ts";
import { ChatAvatar } from "../components/ChatAvatar.tsx";
import { failureSummary } from "../components/failure-summary.ts";
import { retryOf, retryStateText } from "../agents/retry-state.ts";
import { Mark } from "../components/Mark.tsx";
import { convTime } from "../time.ts";
import type { Agent } from "../components/AgentAvatar.tsx";
import { chatTabOf, hasChatTabActivity, type ChatTab } from "./chat-tabs.ts";
export type Section = "agents" | "chat" | "records";

const rowName = "truncate text-xs font-semibold text-ink";
const rowTime = "flex-none text-[10px] text-muted/70";
const rowPreview =
  "mt-0.5 min-w-0 flex-1 truncate text-[11px] leading-[1.6] text-muted";
const slotAction =
  "relative flex h-[22px] w-[22px] items-center justify-center rounded-md text-muted hover:bg-[#dce6df] hover:text-ink";
const hint = "px-2.5 py-2 text-xs text-muted/80";
const navButton = (active: boolean) =>
  `flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs font-medium transition-colors ${
    active
      ? "bg-[#e2ebe4] text-accent-strong shadow-[inset_0_0_0_1px_rgba(75,111,90,0.12)]"
      : "text-muted hover:bg-[#edf3ef] hover:text-ink"
  }`;
export function Sidebar({
  overview,
  section,
  setSection,
  chatId,
  chatTab,
  lastObservedAt,
  selectChatTab,
  selectChat,
  create,
  openAgent,
  openingAgent,
  connected,
  details,
  refresh,
  openSettings,
}: {
  overview: Overview | null;
  section: Section;
  setSection: (section: Section) => void;
  chatId: string | null;
  chatTab: ChatTab;
  lastObservedAt: number;
  selectChatTab: (tab: ChatTab) => void;
  selectChat: (id: string) => void;
  create: (kind: "agent" | "chat") => void;
  openAgent: (agent: Agent) => void;
  openingAgent: string | null;
  connected: boolean;
  details: (id: string) => void;
  refresh: () => void;
  openSettings: () => void;
}) {
  const agents = overview?.agents ?? [];
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const chats = overview?.chats ?? [];
  const visibleChats = chats.filter((chat) => chatTabOf(chat) === chatTab);

  async function setState(
    id: string,
    body: { hidden?: boolean; pinned?: boolean },
  ) {
    await patchChat(id, body).catch(() => {});
    refresh();
  }
  return (
    <aside className="sidebar flex h-full w-[250px] flex-none flex-col bg-surface-subtle pl-3.5 pr-2 py-3 max-[720px]:w-[220px] max-[720px]:px-2">
      {/* 侧边栏顶部品牌：Qoder 桌面风格 */}
      <div className="mb-4 flex items-center justify-between px-2">
        <div className="flex items-center gap-2">
          <Mark className="h-5 w-5 flex-none text-accent" />
          <span className="text-[13px] font-semibold tracking-tight text-ink">
            Atrium
          </span>
        </div>
      </div>

      <nav aria-label="主导航" className="mb-3.5 grid gap-1">
        <div className="group/nav flex items-center">
          <button
            className={`${navButton(section === "chat")} min-w-0 flex-1`}
            onClick={() => setSection("chat")}
          >
            <MessageSquare size={15} />
            会话
          </button>
          <button
            className="icon-button mr-2 opacity-0 group-hover/nav:opacity-100 group-focus-within/nav:opacity-100 max-[560px]:opacity-100"
            aria-label="新建会话"
            onClick={() => create("chat")}
          >
            <Plus size={15} />
          </button>
        </div>
        <button
          className={navButton(section === "agents")}
          onClick={() => setSection("agents")}
        >
          <Users size={15} />
          Agents
        </button>
        <button
          className={navButton(section === "records")}
          onClick={() => setSection("records")}
        >
          <History size={15} />
          聊天记录
        </button>
      </nav>
      {section !== "agents" ? (
        <div className="mb-4 flex min-h-0 flex-1 flex-col">
          <div
            role="tablist"
            aria-label="会话范围"
            className="mx-1.5 mb-2 grid grid-cols-2 rounded-lg bg-[#e7eee9] p-0.5"
          >
            {(["mine", "observe"] as const).map((tab) => {
              const label = tab === "mine" ? "我的" : "围观";
              const hasActivity = hasChatTabActivity(
                chats,
                tab,
                lastObservedAt,
              );
              const showDot = tab !== chatTab && hasActivity;
              return (
                <button
                  key={tab}
                  role="tab"
                  aria-selected={chatTab === tab}
                  aria-label={showDot ? `${label}，有新动态` : label}
                  onClick={() => selectChatTab(tab)}
                  className={`flex min-w-0 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors max-[560px]:min-h-11 ${
                    chatTab === tab
                      ? "bg-white text-ink shadow-sm"
                      : "text-muted hover:bg-white/60 hover:text-ink"
                  }`}
                >
                  {label}
                  {showDot && (
                    <span
                      aria-hidden="true"
                      className="h-1.5 w-1.5 rounded-full bg-accent"
                    />
                  )}
                </button>
              );
            })}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {visibleChats.map((chat) => (
              <div
                key={chat.id}
                className={`group/row relative rounded-lg transition-colors ${
                  chat.id === chatId
                    ? "bg-[#e2ebe4] shadow-[inset_0_0_0_1px_rgba(75,111,90,0.12)]"
                    : "hover:bg-[#edf3ef]"
                }`}
              >
                <button
                  className="absolute inset-0 rounded-lg"
                  onClick={() => selectChat(chat.id)}
                  aria-label={chat.name}
                  title={
                    agentById.get(chat.direct_agent ?? "")?.failure
                      ? (retryStateText(
                          retryOf(agentById.get(chat.direct_agent ?? "")!),
                        ) ??
                        failureSummary(
                          agentById.get(chat.direct_agent ?? "")!.failure!.text,
                        ))
                      : undefined
                  }
                />
                <div className="pointer-events-none relative flex items-center gap-2.5 p-2">
                  <ChatAvatar chat={chat} agents={agents} />
                  <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-1.5">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <strong className={rowName}>{chat.name}</strong>
                      {chat.pinned && (
                        <Pin size={11} className="flex-none text-accent" />
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
                            <PinOff size={13} />
                          ) : (
                            <Pin size={13} />
                          )}
                        </button>
                        <button
                          className={slotAction}
                          aria-label="隐藏"
                          onClick={() =>
                            void setState(chat.id, { hidden: true })
                          }
                        >
                          <EyeOff size={13} />
                        </button>
                      </span>
                    </span>
                    <span className="col-span-2 flex min-w-0 items-center gap-1.5">
                      <small className={rowPreview}>
                        {chat.preview ?? "开始这段对话"}
                      </small>
                      {(chat.unread ?? 0) > 0 &&
                        (chat.mine ? (
                          <span className="badge">
                            {unreadLabel(chat.unread ?? 0)}
                          </span>
                        ) : (
                          <span
                            className="h-1.5 w-1.5 flex-none rounded-full bg-accent"
                            title="有新动态"
                          />
                        ))}
                    </span>
                  </span>
                </div>
              </div>
            ))}
            {overview && !visibleChats.length && (
              <p className={hint}>
                {chatTab === "mine"
                  ? "还没有会话，从 Agents 里选一位开始"
                  : "Agent 之间的会话会出现在这里"}
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1" />
      )}
      <button
        className="mb-2 flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs text-muted hover:bg-[#edf3ef] hover:text-ink"
        onClick={openSettings}
      >
        <Settings2 size={15} />
        设置
      </button>
      {/* 连上时不占位；只在服务断开、正在重连时提示 */}
      {!connected && (
        <footer className="workspace flex items-center gap-2 border-t border-black/[0.04] px-2 pt-2.5 text-[11px] text-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
          <span>正在连接…</span>
        </footer>
      )}
    </aside>
  );
}
