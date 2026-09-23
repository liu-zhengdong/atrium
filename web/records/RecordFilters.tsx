import { Search, X } from "lucide-react";
import type { Overview } from "../../shared/schema.ts";
import { LOCAL_USER } from "../../shared/user.ts";
import type { Agent } from "../components/AgentAvatar.tsx";
import { emptyFilters, type RecordFilters } from "./query.ts";

// 控件高度统一到 28px（符合 Qoder 桌面紧凑标准），字号 12px。
const control =
  "h-7 rounded-lg border border-line bg-white shadow-[0_1px_2px_rgba(24,32,25,0.02)]";
const select = `${control} px-2 text-xs text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent/20`;

/** 会话、发送者、时间范围、关键词。三块内容共用这一条工具栏。靠距离自然形成呼吸与分组。 */
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
    <div className="flex flex-wrap items-center gap-2">
      {/* 搜索框 */}
      <div
        className={`${control} flex min-w-[200px] flex-1 items-center gap-1.5 px-2.5 focus-within:border-accent focus-within:ring-1 focus-within:ring-accent/20`}
      >
        <Search size={14} className="flex-none text-muted" />
        <input
          id="record-q"
          className="plain-field min-w-0 flex-1 border-0 bg-transparent text-xs text-ink placeholder:text-muted/70 outline-none"
          value={filters.q}
          placeholder="搜索消息正文或文件名..."
          aria-label="搜索消息正文或文件名"
          autoComplete="off"
          onChange={(e) => patch({ q: e.target.value })}
        />
      </div>

      {/* 会话筛选 */}
      <select
        id="record-chat"
        aria-label="按会话筛选"
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

      {/* 发送者筛选 */}
      <select
        id="record-sender"
        aria-label="按发送者筛选"
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

      {/* 时间范围 */}
      <div className="flex items-center gap-1.5">
        <input
          id="record-from"
          type="date"
          className={select}
          value={filters.from}
          aria-label="开始日期"
          onChange={(e) => patch({ from: e.target.value })}
        />
        <span className="text-[11px] text-muted">至</span>
        <input
          id="record-to"
          type="date"
          className={select}
          value={filters.to}
          aria-label="结束日期"
          onChange={(e) => patch({ to: e.target.value })}
        />
      </div>

      {dirty && (
        <button
          className="flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-muted transition-colors hover:bg-[#edf3ef] hover:text-ink"
          onClick={() => setFilters(emptyFilters)}
          title="清空所有筛选"
        >
          <X size={13} />
          重置
        </button>
      )}
    </div>
  );
}
