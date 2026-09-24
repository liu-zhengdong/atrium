import { useEffect, useState } from "react";
import { Hash, History, Menu, Search, Users } from "lucide-react";
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
  const [searchOpen, setSearchOpen] = useState(false);

  // 监听全局快捷键 ⌘K / Ctrl+K 打开全局搜索
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <header
        role="banner"
        className="relative z-20 flex h-11 flex-none items-center justify-between bg-white/90 px-4 backdrop-blur-md"
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
            </div>
          ) : section === "agents" ? (
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-ink">Agent 名册</span>
            </div>
          ) : section === "records" ? (
            <span className="text-xs font-semibold text-ink">聊天记录</span>
          ) : (
            <span className="text-xs font-semibold text-ink">工作台</span>
          )}
        </div>

        {/* 中间：自然留白，不霸占常驻输入框 */}
        <div className="flex-1" />

        {/* 右侧：搜索触发入口 + 上下文操作项 + 我的资料 */}
        <div className="flex flex-none items-center gap-2">
          {/* 全局搜索快捷入口 */}
          <button
            type="button"
            className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-muted transition-colors hover:bg-[#edf3ef] hover:text-ink"
            aria-label="全局搜索 (⌘K)"
            title="全局搜索 (⌘K)"
            onClick={() => setSearchOpen(true)}
          >
            <Search size={14} />
            <kbd className="hidden font-mono text-[10px] text-muted sm:inline-block">
              ⌘K
            </kbd>
          </button>

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
              className="flex items-center gap-1.5 rounded-lg p-1 transition-colors hover:bg-[#edf3ef]"
              aria-label="我的资料"
              title={me ? `当前用户：${me}` : "我的资料与设置"}
              onClick={openUser}
            >
              <Avatar small name={me || "我"} />
              {me && me !== "我" && (
                <span className="max-w-[100px] truncate text-xs font-medium text-ink">
                  {me}
                </span>
              )}
            </button>
          )}
        </div>
      </header>

      {/* Spotlight 模态浮层 */}
      <GlobalSearch
        overview={overview}
        selectChat={selectChat}
        openAgent={openAgent}
        openingAgent={openingAgent}
        details={details}
        refresh={refresh}
        openMessage={openMessage}
        isOpen={searchOpen}
        onClose={() => setSearchOpen(false)}
      />
    </>
  );
}
