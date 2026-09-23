import { Search, X } from "lucide-react";
import type { Overview } from "../../shared/schema.ts";
import { LOCAL_USER } from "../../shared/user.ts";
import type { Agent } from "../components/AgentAvatar.tsx";
import { emptyFilters, type RecordFilters } from "./query.ts";

// 控件高度统一到 28px（符合 Qoder 桌面紧凑标准），字号 12px。
const control =
  "h-7 rounded-lg border border-line bg-white shadow-[0_1px_2px_rgba(24,32,25,0.02)]";
const select = `${control} px-2 text-xs text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent/20`;
const label = "text-[11px] font-medium text-muted";

/** 会话、发送者、时间范围、关键词。三块内容共用这一条。 */
export function RecordFilterBar({
  filters,
  setFilters,
  chats,
  agents,
  userName,
}: {
  filters: RecordFilters;
  setFilters: (next: RecordFilters) => void;
  chats: Overview["chats"];
  agents: Agent[];
  userName: string;
}) {
  const patch = (part: Partial<RecordFilters>) =>
    setFilters({ ...filters, ...part });
  const dirty =
    filters.chat !== null ||
    filters.sender !== null ||
    filters.from !== "" ||
    filters.to !== "" ||
    filters.q !== "";
  return (
    <div className="flex flex-wrap items-end gap-x-3 gap-y-2 border-b border-line bg-surface/50 px-6 py-2.5 max-[720px]:px-4">
      <div className="flex min-w-[200px] flex-1 flex-col gap-1">
        <label className={label} htmlFor="record-q">
          关键词
        </label>
        {/* 图标与 input 并排，不用绝对定位——.field 的背景会盖掉它。 */}
        <div
          className={`${control} flex items-center gap-1.5 px-2.5 focus-within:border-accent focus-within:ring-1 focus-within:ring-accent/20`}
        >
          <Search size={14} className="flex-none text-muted" />
          <input
            id="record-q"
            className="plain-field min-w-0 flex-1 border-0 bg-transparent text-xs text-ink placeholder:text-muted/70 outline-none"
            value={filters.q}
            placeholder="搜索消息正文或文件名..."
            autoComplete="off"
            onChange={(e) => patch({ q: e.target.value })}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label className={label} htmlFor="record-chat">
          会话
        </label>
        <select
          id="record-chat"
          className={select}
          value={filters.chat ?? ""}
          onChange={(e) => patch({ chat: e.target.value || null })}
        >
          <option value="">全部会话</option>
          {chats.map((chat) => (
            <option key={chat.id} value={chat.id}>
              {chat.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label className={label} htmlFor="record-sender">
          发送者
        </label>
        <select
          id="record-sender"
          className={select}
          value={filters.sender ?? ""}
          onChange={(e) => patch({ sender: e.target.value || null })}
        >
          <option value="">所有人</option>
          <option value={LOCAL_USER}>{userName}</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label className={label} htmlFor="record-from">
          时间范围
        </label>
        <div className="flex items-center gap-1.5">
          <input
            id="record-from"
            type="date"
            className={select}
            value={filters.from}
            aria-label="开始日期"
            onChange={(e) => patch({ from: e.target.value })}
          />
          <span className="text-[11px] text-[#a09b8d]">到</span>
          <input
            type="date"
            className={select}
            value={filters.to}
            aria-label="结束日期"
            onChange={(e) => patch({ to: e.target.value })}
          />
        </div>
      </div>
      {dirty && (
        <button
          className="flex h-7 items-center gap-1 rounded-lg px-2.5 text-xs text-muted transition-colors hover:bg-[#edf3ef] hover:text-ink"
          onClick={() => setFilters(emptyFilters)}
        >
          <X size={13} />
          清除
        </button>
      )}
    </div>
  );
}
