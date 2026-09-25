import { useState } from "react";
import { History } from "lucide-react";
import type { Overview } from "../../shared/schema.ts";
import type { Agent } from "../components/AgentAvatar.tsx";
import { SidePanel } from "../components/SidePanel.tsx";
import { MemberList } from "./MemberList.tsx";
import { GroupProfile } from "./GroupProfile.tsx";
import { GroupSpace } from "./GroupSpace.tsx";
import { DeleteGroup } from "./DeleteGroup.tsx";

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
  deleted,
  openRecords,
  openAgent,
}: {
  chat: Overview["chats"][number];
  agents: Agent[];
  revision: number;
  close: () => void;
  changed: () => void;
  deleted: () => void;
  openRecords: () => void;
  openAgent: (id: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("members");
  return (
    <SidePanel
      title={chat.name}
      close={close}

      actions={
        <button
          className="icon-button text-muted hover:bg-[#edf3ef] hover:text-ink"
          aria-label="查找本群聊天记录"
          title="查找本群聊天记录"
          onClick={openRecords}
        >
          <History size={15} />
        </button>
      }
    >
      <nav
        className="flex flex-none gap-5 border-b border-black/[0.04] px-5"
        role="tablist"
        aria-label="群信息"
      >
        {TABS.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            className={`-mb-px border-b-2 pb-2.5 pt-2 text-xs transition-colors ${
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
        {tab === "profile" && (
          <>
            <GroupProfile chat={chat} saved={changed} />
            <DeleteGroup chat={chat} deleted={deleted} />
          </>
        )}
      </div>
    </SidePanel>
  );
}
