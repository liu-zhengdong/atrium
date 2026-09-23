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
      <header className="main-header flex h-12 flex-none items-center justify-between border-b border-line bg-surface/80 px-6 backdrop-blur-sm max-[720px]:px-4 max-[560px]:pl-12">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold text-ink">聊天记录</h1>
          <p className="mt-0.5 truncate text-[11px] text-muted">
            {scopeName
              ? `只看「${scopeName}」`
              : "集中检索全部会话的历史与附件"}
          </p>
        </div>
        <nav
          className="flex items-center gap-1 rounded-lg bg-[#e8ecea] p-1"
          role="tablist"
          aria-label="聊天记录内容类型"
        >
          {TABS.map((item) => (
            <button
              key={item.id}
              role="tab"
              aria-selected={tab === item.id}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-all ${
                tab === item.id
                  ? "bg-white font-semibold text-ink shadow-[0_1px_2px_rgba(24,32,25,0.05)]"
                  : "text-muted hover:text-ink"
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
