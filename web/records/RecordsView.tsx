import type { Overview } from "../../shared/schema.ts";
import type { Agent } from "../components/AgentAvatar.tsx";
import { RecordFilterBar } from "./RecordFilters.tsx";
import { FileRecords, ImageRecords, MessageRecords } from "./RecordLists.tsx";
import type { RecordFilters, RecordTab } from "./query.ts";

const TABS = [
  { id: "messages", label: "消息" },
  { id: "images", label: "图片" },
  { id: "files", label: "文件" },
] as const;

/** 聊天记录页：只管组装筛选条与三块内容，取数各自管各自的。 */
export function RecordsView({
  overview,
  tab,
  setTab,
  filters,
  setFilters,
  openMessage,
}: {
  overview: Overview;
  tab: RecordTab;
  setTab: (tab: RecordTab) => void;
  filters: RecordFilters;
  setFilters: (filters: RecordFilters) => void;
  openMessage: (chatId: string, messageId: number) => void;
}) {
  const scoped = filters.chat !== null;
  const scopeName = overview.chats.find((c) => c.id === filters.chat)?.name;
  const props = { filters, scoped, openMessage };
  return (
    <>
      <header className="main-header flex h-[52px] flex-none items-center justify-between border-b border-[#eeede8] px-[35px] max-[720px]:px-[22px] max-[560px]:pl-[49px]">
        <div className="min-w-0">
          <h1 className="truncate text-[15px] font-semibold">聊天记录</h1>
          <p className="mt-px truncate text-[11px] text-[#959084]">
            {scopeName ? `只看「${scopeName}」` : "全部会话"}
          </p>
        </div>
        <nav
          className="flex gap-1"
          role="tablist"
          aria-label="聊天记录内容类型"
        >
          {TABS.map((item) => (
            <button
              key={item.id}
              role="tab"
              aria-selected={tab === item.id}
              className={`rounded-[7px] px-3 py-1.5 text-[12.5px] ${
                tab === item.id
                  ? "bg-[#eeede7] font-[550] text-ink"
                  : "text-[#8e8779] hover:bg-[#f2f1ec]"
              }`}
              onClick={() => setTab(item.id as RecordTab)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>
      <RecordFilterBar
        filters={filters}
        setFilters={setFilters}
        chats={overview.chats}
        agents={overview.agents as Agent[]}
        userName={overview.user.name || "你"}
      />
      {tab === "messages" && <MessageRecords {...props} />}
      {tab === "images" && <ImageRecords {...props} />}
      {tab === "files" && <FileRecords {...props} />}
    </>
  );
}
