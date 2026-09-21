import { useState } from "react";
import { History } from "lucide-react";
import type { Overview } from "../../shared/schema.ts";
import type { Agent } from "../components/AgentAvatar.tsx";
import { Modal } from "../components/Modal.tsx";
import { MemberList } from "./MemberList.tsx";
import { GroupProfile } from "./GroupProfile.tsx";

const TABS = [
  { id: "members", label: "成员" },
  { id: "profile", label: "资料" },
] as const;
type Tab = (typeof TABS)[number]["id"];

/** 群信息抽屉：只管组装与切换，每块自己取数。 */
export function GroupDrawer({
  chat,
  agents,
  close,
  changed,
  openRecords,
  openAgent,
}: {
  chat: Overview["chats"][number];
  agents: Agent[];
  close: () => void;
  changed: () => void;
  openRecords: () => void;
  openAgent: (id: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("members");
  return (
    <Modal title={chat.name} close={close} drawer>
      <nav
        className="flex flex-none gap-1 border-b border-line px-4"
        role="tablist"
        aria-label="群信息"
      >
        {TABS.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            className={`-mb-px border-b-2 px-3 py-2.5 text-[12.5px] ${
              tab === item.id
                ? "border-[#8a8172] font-[550] text-[#45463c]"
                : "border-transparent text-[#8e8779] hover:text-[#5f5a4e]"
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
        {tab === "profile" && <GroupProfile chat={chat} saved={changed} />}
      </div>
      <footer className="flex-none border-t border-line px-5 py-3">
        <button
          className="flex w-full items-center gap-2 rounded-[7px] px-2 py-2 text-left text-[12.5px] text-[#6f6a5e] hover:bg-[#f6f5f0]"
          onClick={openRecords}
        >
          <History size={15} className="flex-none text-[#a39b8b]" />
          查找聊天记录
          <span className="muted small-text ml-auto">消息 · 图片 · 文件</span>
        </button>
      </footer>
    </Modal>
  );
}
