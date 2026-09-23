import {
  EyeOff,
  History,
  MessageSquare,
  Pin,
  PinOff,
  Plus,
  Users,
} from "lucide-react";
import { unreadLabel, type Overview } from "../../shared/schema.ts";
import { patchChat } from "../api.ts";
import { ChatAvatar } from "../components/ChatAvatar.tsx";
import { Mark } from "../components/Mark.tsx";
import { convTime } from "../time.ts";
import {
  agentPresence,
  Avatar,
  runtimeLabel,
  type Agent,
} from "../components/AgentAvatar.tsx";
export type Section = "agents" | "chat" | "records";

const rowName = "truncate text-xs font-semibold text-ink";
const rowTime = "flex-none text-[10px] text-muted/70";
const rowPreview =
  "mt-0.5 min-w-0 flex-1 truncate text-[11px] leading-[1.6] text-muted";
const slotAction =
  "relative flex h-[22px] w-[22px] items-center justify-center rounded-md text-muted hover:bg-[#dce6df] hover:text-ink";
const agentRow =
  "agent-row flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-[#edf3ef]";
const sectionLabel =
  "mb-1.5 flex items-center justify-between px-2 text-[11px] font-medium tracking-[0.02em] text-muted";
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
  selectChat,
  create,
  openAgent,
  openingAgent,
  connected,
  details,
  refresh,
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
}) {
  const agents = overview?.agents ?? [];

  async function setState(
    id: string,
    body: { hidden?: boolean; pinned?: boolean },
  ) {
    await patchChat(id, body).catch(() => {});
    refresh();
  }
  return (
    <aside className="sidebar flex h-full w-[260px] flex-none flex-col border-r border-line bg-surface-subtle px-3 pb-3 pt-3.5 max-[720px]:w-[220px] max-[720px]:px-2">
      {/* 侧边栏顶部品牌：Qoder 桌面风格 */}
      <div className="mb-4 flex items-center justify-between px-2">
        <div className="flex items-center gap-2">
          <Mark className="h-5 w-5 flex-none text-accent" />
          <span className="text-[13px] font-semibold tracking-tight text-ink">
            Atrium
          </span>
          <span className="rounded bg-[#e4ede6] px-1.5 py-0.5 text-[10px] font-medium text-accent-strong">
            中庭
          </span>
        </div>
      </div>

      <nav aria-label="主导航" className="mb-3.5 grid gap-1">
        <button
          className={navButton(section === "chat")}
          onClick={() => setSection("chat")}
        >
          <MessageSquare size={15} />
          会话
        </button>
        <button
          className={navButton(section === "agents")}
          onClick={() => setSection("agents")}
        >
          <Users size={15} />
          Agents
          {agents.length > 0 && (
            <span className="ml-auto text-[10px] text-muted">
              {agents.length}
            </span>
          )}
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
          <div className={sectionLabel}>
            会话
            <button
              className="icon-button text-muted hover:bg-[#edf3ef] hover:text-ink"
              aria-label="新建会话"
              onClick={() => {
                create("chat");
              }}
            >
              <Plus size={15} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {overview?.chats.map((chat) => (
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
            {overview && !overview.chats.length && (
              <p className={hint}>还没有会话，从 Agents 里选一位开始</p>
            )}
          </div>
        </div>
      ) : (
        <div className="mb-4 min-h-0 flex-1 overflow-auto">
          <div className={sectionLabel}>
            Agents
            <button
              className="icon-button text-muted hover:bg-[#edf3ef] hover:text-ink"
              aria-label="新建 Agent"
              onClick={() => {
                create("agent");
              }}
            >
              <Plus size={15} />
            </button>
          </div>
          {agents.map((a) => (
            <div className={agentRow} key={a.id}>
              <Avatar
                name={a.name}
                presence={agentPresence(a)}
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
      <footer className="workspace flex items-center gap-2 border-t border-line px-2 pt-2.5 text-[11px] text-muted">
        <span
          className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-accent" : "bg-[#c29758]"}`}
        />
        <span>{connected ? "本机工作区" : "正在连接…"}</span>
        <span className="ml-auto text-[10px] text-muted/60">v0.1</span>
      </footer>
    </aside>
  );
}
