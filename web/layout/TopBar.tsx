import { Hash, History, Menu, Users } from "lucide-react";
import type { Overview } from "../../shared/schema.ts";
import {
  agentPresence,
  Avatar,
  runtimeLabel,
  type Agent,
} from "../components/AgentAvatar.tsx";
import { GlobalSearch } from "./GlobalSearch.tsx";
import type { Section } from "./Sidebar.tsx";

export function TopBar({
  overview,
  section,
  activeChat,
  agents,
  selectChat,
  openAgent,
  openingAgent,
  details,
  refresh,
  openMessage,
  openUser,
  openGroup,
  openRecords,
  toggleMobile,
}: {
  overview: Overview | null;
  section: Section;
  activeChat?: Overview["chats"][number];
  agents: Agent[];
  selectChat: (id: string) => void;
  openAgent: (agent: Agent) => void;
  openingAgent: string | null;
  details: (id: string) => void;
  refresh: () => void;
  openMessage: (chatId: string, messageId: number) => void;
  openUser: () => void;
  openGroup: () => void;
  openRecords: () => void;
  toggleMobile?: () => void;
}) {
  const me = overview?.user.name.trim() ?? "";
  const isGroup = activeChat?.kind === "group";
  const chatMembers = activeChat
    ? agents.filter((a) => (isGroup ? true : a.id === activeChat.direct_agent))
    : [];

  return (
    <header
      role="banner"
      className="relative z-20 flex h-11 flex-none items-center justify-between border-b border-line-subtle/60 bg-white/90 px-4 backdrop-blur-md"
    >
      {/* 左侧：移动端切换 + 上下文标题/短号 */}
      <div className="flex min-w-0 items-center gap-2.5">
        {toggleMobile && (
          <button
            className="icon-button hidden max-[720px]:flex text-muted hover:text-ink"
            aria-label="打开侧边栏"
            onClick={toggleMobile}
          >
            <Menu size={16} />
          </button>
        )}

        {section === "chat" && activeChat ? (
          <div className="flex items-center gap-2 truncate">
            {isGroup ? (
              <button
                className="flex items-center gap-1.5 truncate text-left text-xs font-semibold text-ink transition-colors hover:text-accent"
                title="查看群信息"
                onClick={openGroup}
              >
                <Hash size={14} className="flex-none text-muted" />
                <span className="truncate">{activeChat.name}</span>
              </button>
            ) : (
              <span className="truncate text-xs font-semibold text-ink">
                {activeChat.name}
              </span>
            )}
            {activeChat.ref && (
              <span
                className="rounded bg-[#edf5f1] px-1.5 py-0.5 font-mono text-[10px] font-medium text-[#316e50]"
                title="会话短号"
              >
                {activeChat.ref}
              </span>
            )}
          </div>
        ) : section === "agents" ? (
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-ink">Agent 名册</span>
            {overview && (
              <span className="rounded bg-[#edf5f1] px-1.5 py-0.5 text-[10px] font-medium text-[#316e50]">
                {overview.agents.length} 位
              </span>
            )}
          </div>
        ) : section === "records" ? (
          <span className="text-xs font-semibold text-ink">聊天记录</span>
        ) : (
          <span className="text-xs font-semibold text-ink">工作台</span>
        )}
      </div>

      {/* 中间：居中的全局搜索 */}
      <div className="mx-4 w-full max-w-[440px] max-[720px]:mx-2">
        <GlobalSearch
          overview={overview}
          selectChat={selectChat}
          openAgent={openAgent}
          openingAgent={openingAgent}
          details={details}
          refresh={refresh}
          openMessage={openMessage}
        />
      </div>

      {/* 右侧：上下文操作项 + 我的资料 */}
      <div className="flex flex-none items-center gap-2">
        {section === "chat" && activeChat && (
          <div className="flex items-center gap-1.5">
            {/* 头像堆叠 */}
            <div className="flex items-center -space-x-1.5 overflow-hidden">
              {chatMembers.slice(0, 4).map((a) => (
                <button
                  key={a.id}
                  className="rounded-full ring-2 ring-white transition-transform hover:z-10 hover:scale-110"
                  aria-label={`查看 ${a.name} 的运行轨迹`}
                  title={`${a.name} · ${a.work || runtimeLabel(a)}`}
                  onClick={() => details(a.id)}
                >
                  <Avatar small name={a.name} presence={agentPresence(a)} />
                </button>
              ))}
            </div>

            <div className="mx-1 h-3.5 w-px bg-line" />

            <button
              className="icon-button text-muted hover:bg-[#edf3ef] hover:text-ink"
              aria-label="查找聊天记录"
              title="查找聊天记录"
              onClick={openRecords}
            >
              <History size={14} />
            </button>

            {isGroup && (
              <button
                className="icon-button text-muted hover:bg-[#edf3ef] hover:text-ink"
                aria-label="群成员与设置"
                title="群成员与设置"
                onClick={openGroup}
              >
                <Users size={14} />
              </button>
            )}

            {!isGroup && activeChat.direct_agent && (
              <button
                className="icon-button text-muted hover:bg-[#edf3ef] hover:text-ink"
                aria-label="Agent 轨迹与详情"
                title="Agent 轨迹与详情"
                onClick={() => details(activeChat.direct_agent!)}
              >
                <Users size={14} />
              </button>
            )}

            <div className="mx-1 h-3.5 w-px bg-line" />
          </div>
        )}

        {overview && (
          <button
            className="flex items-center gap-1.5 rounded-lg px-1.5 py-1 transition-colors hover:bg-[#edf3ef]"
            aria-label="我的资料"
            title="我的资料"
            onClick={openUser}
          >
            <Avatar name={me || "我"} small />
            {me && (
              <span className="truncate text-xs font-medium text-ink max-[720px]:hidden">
                {me}
              </span>
            )}
          </button>
        )}
      </div>
    </header>
  );
}
