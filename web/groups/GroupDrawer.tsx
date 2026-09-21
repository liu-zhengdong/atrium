import { useState } from "react";
import type { Overview } from "../../shared/schema.ts";
import type { Agent } from "../components/AgentAvatar.tsx";
import { Modal } from "../components/Modal.tsx";
import { MemberList } from "./MemberList.tsx";
import { GroupProfile } from "./GroupProfile.tsx";
import { FileList } from "./FileList.tsx";
import { ChatSearch } from "./ChatSearch.tsx";

const TABS = [
  { id: "members", label: "成员" },
  { id: "profile", label: "资料" },
  { id: "files", label: "文件" },
  { id: "search", label: "搜索" },
] as const;
type Tab = (typeof TABS)[number]["id"];

/** 群信息抽屉：只管组装与切换，每块自己取数。 */
export function GroupDrawer({
  chat,
  agents,
  close,
  changed,
  openMessage,
  openAgent,
}: {
  chat: Overview["chats"][number];
  agents: Agent[];
  close: () => void;
  changed: () => void;
  openMessage: (chatId: string, messageId: number) => void;
  openAgent: (id: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("members");
  const jump = (messageId: number) => {
    openMessage(chat.id, messageId);
    close();
  };
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
        {tab === "files" && <FileList chatId={chat.id} openMessage={jump} />}
        {tab === "search" && <ChatSearch chatId={chat.id} openMessage={jump} />}
      </div>
    </Modal>
  );
}
