import { Search, X } from "lucide-react";
import type { Overview } from "../../shared/schema.ts";
import { LOCAL_USER } from "../../shared/user.ts";
import type { Agent } from "../components/AgentAvatar.tsx";
import { emptyFilters, type RecordFilters } from "./query.ts";

// select 、input[type=date] 、关键词框的原生高度各不相同（实测 33 / 37 / 36px），统一钉到 36px。
const control = "h-9 rounded-[7px] border border-line bg-white";
const select = `${control} px-2.5 text-[12.5px] text-ink`;
const label = "text-[11px] text-[#8b8577]";

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
    <div className="flex flex-wrap items-end gap-x-3 gap-y-2.5 border-b border-[#eeede8] px-[35px] py-3 max-[720px]:px-[22px]">
      <div className="flex min-w-[220px] flex-1 flex-col gap-1">
        <label className={label} htmlFor="record-q">
          关键词
        </label>
        {/* 图标与 input 并排，不用绝对定位——.field 的背景会盖掉它。 */}
        <div
          className={`${control} flex items-center gap-2 px-3 focus-within:border-[#c4b9a4]`}
        >
          <Search size={15} className="flex-none text-[#a09b8d]" />
          <input
            id="record-q"
            className="plain-field min-w-0 flex-1 border-0 bg-transparent text-[13px] text-ink"
            value={filters.q}
            placeholder="消息正文或文件名"
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
          className="flex items-center gap-1 rounded-[7px] px-2 py-[7px] text-[12px] text-[#8b8577] hover:bg-[#f2f1ec]"
          onClick={() => setFilters(emptyFilters)}
        >
          <X size={13} />
          清除
        </button>
      )}
    </div>
  );
}
