import { useState } from "react";
import { History } from "lucide-react";
import type { Overview } from "../../shared/schema.ts";
import type { Agent } from "../components/AgentAvatar.tsx";
import { SidePanel } from "../components/SidePanel.tsx";
import { MemberList } from "./MemberList.tsx";
import { GroupProfile } from "./GroupProfile.tsx";
import { GroupSpace } from "./GroupSpace.tsx";

const TABS = [
  { id: "members", label: "成员" },
  { id: "space", label: "共享目录" },
  { id: "profile", label: "资料" },
] as const;
type Tab = (typeof TABS)[number]["id"];

/** 群信息抽屉：只管组装与切换，每块自己取数。 */
export function GroupDrawer({
  chat,
  agents,
  revision,
  close,
  changed,
  openRecords,
  openAgent,
}: {
  chat: Overview["chats"][number];
  agents: Agent[];
  revision: number;
  close: () => void;
  changed: () => void;
  openRecords: () => void;
  openAgent: (id: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("members");
  return (
    <SidePanel
      title={chat.name}
      close={close}
      badge={<span className="badge">群聊</span>}
    >
      <nav
        className="flex flex-none gap-2 border-b border-line px-4"
        role="tablist"
        aria-label="群信息"
      >
        {TABS.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            className={`-mb-px border-b-2 px-3 py-2.5 text-xs transition-colors ${
              tab === item.id
                ? "border-accent font-medium text-accent-strong"
                : "border-transparent text-muted hover:text-ink"
            }`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {tab === "members" && (
          <MemberList
            chatId={chat.id}
            agents={agents}
            changed={changed}
            openAgent={openAgent}
          />
        )}
        {tab === "space" && <GroupSpace chatId={chat.id} revision={revision} />}
        {tab === "profile" && <GroupProfile chat={chat} saved={changed} />}
      </div>
      <footer className="flex-none border-t border-line px-5 py-3">
        <button
          className="flex w-full items-center gap-2 rounded-[6px] px-2.5 py-2 text-left text-xs text-muted hover:bg-[#edf3ef] hover:text-ink"
          onClick={openRecords}
        >
          <History size={14} className="flex-none text-muted" />
          查找聊天记录
          <span className="muted small-text ml-auto">消息 · 图片 · 文件</span>
        </button>
      </footer>
    </SidePanel>
  );
}
