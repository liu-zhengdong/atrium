import { EyeOff, MessageSquare, Pin, PinOff, Plus, Users } from "lucide-react";
import type { Overview } from "../../shared/schema.ts";
import { patchChat } from "../api.ts";
import { ChatAvatar } from "../components/ChatAvatar.tsx";
import { convTime } from "../time.ts";
import {
  agentPresence,
  Avatar,
  runtimeLabel,
  type Agent,
} from "../components/AgentAvatar.tsx";
export type Section = "agents" | "chat";

const rowName = "truncate text-[13px] font-medium";
const rowTime = "flex-none text-[10px] text-[#a8a394]";
const rowPreview =
  "mt-0.5 min-w-0 flex-1 truncate text-[11px] leading-[1.6] text-[#858278]";
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
    <aside className="sidebar flex w-[258px] flex-none flex-col border-r border-line bg-surface px-3.5 pt-2 max-[720px]:w-[220px] max-[720px]:px-[9px]">
      <nav aria-label="主导航" className="mb-3 grid gap-[3px]">
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
      {section === "chat" ? (
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
