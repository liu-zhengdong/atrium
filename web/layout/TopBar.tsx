import { Menu } from "lucide-react";
import type { Overview } from "../../shared/schema.ts";
import { Avatar, type Agent } from "../components/AgentAvatar.tsx";
import { GlobalSearch } from "./GlobalSearch.tsx";

export function TopBar({
  overview,
  selectChat,
  openAgent,
  openingAgent,
  details,
  refresh,
  openMessage,
  openUser,
  toggleMobile,
}: {
  overview: Overview | null;
  selectChat: (id: string) => void;
  openAgent: (agent: Agent) => void;
  openingAgent: string | null;
  details: (id: string) => void;
  refresh: () => void;
  openMessage: (chatId: string, messageId: number) => void;
  openUser: () => void;
  toggleMobile?: () => void;
}) {
  const me = overview?.user.name.trim() ?? "";
  return (
    <header
      role="banner"
      className="relative z-20 flex h-11 flex-none items-center justify-between border-b border-line bg-surface-subtle px-3.5"
    >
      <div className="flex items-center gap-2">
        {toggleMobile && (
          <button
            className="icon-button hidden max-[720px]:flex text-muted hover:text-ink"
            aria-label="打开侧边栏"
            onClick={toggleMobile}
          >
            <Menu size={16} />
          </button>
        )}
      </div>
      <div className="mx-auto w-full max-w-[540px]">
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
      <div className="flex items-center justify-end">
        {overview && (
          <button
            className="flex items-center gap-2 rounded-md px-2 py-1 transition-colors hover:bg-[#edf3ef]"
            aria-label="我的资料"
            title="我的资料"
            onClick={openUser}
          >
            <Avatar name={me || "我"} small />
            {me && (
              <span className="truncate text-xs text-muted max-[720px]:hidden">
                {me}
              </span>
            )}
          </button>
        )}
      </div>
    </header>
  );
}
