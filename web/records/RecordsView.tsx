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

/** 聊天记录页：靠组件空间位置与留白自然产生分组，不依赖割裂线条与背景块。 */
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
  const props = { filters, scoped, openMessage };
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-white">
      {/* 顶部工具行：过滤控件与类型切换直接呈现在白底上，靠留白与下方结果拉开距离 */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-8 pt-5 pb-1 max-[720px]:px-4">
        <div className="flex min-w-0 flex-1">
          <RecordFilterBar
            filters={filters}
            setFilters={setFilters}
            chats={overview.chats}
            agents={overview.agents as Agent[]}
            userName={overview.user.name || "你"}
          />
        </div>
        <nav
          className="flex flex-none items-center gap-1 rounded-lg bg-[#eef3f0] p-0.5"
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
                  ? "bg-white font-medium text-ink shadow-[0_1px_2px_rgba(24,32,25,0.06)]"
                  : "text-muted hover:text-ink"
              }`}
              onClick={() => setTab(item.id as RecordTab)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </div>
      {tab === "messages" && (
        <MessageRecords {...props} chats={overview.chats} />
      )}
      {tab === "images" && <ImageRecords {...props} />}
      {tab === "files" && <FileRecords {...props} />}
    </div>
  );
}
