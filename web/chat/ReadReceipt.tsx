import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, CheckCheck, Search, X } from "lucide-react";
import type { ChatReadState, Message } from "../../shared/schema.ts";
import { Avatar, type Agent } from "../components/AgentAvatar.tsx";

export function ReadReceipt({
  message,
  state,
  agents,
  direct,
}: {
  message: Message;
  state: ChatReadState[];
  agents: Agent[];
  direct: boolean;
}) {
  const [filter, setFilter] = useState<"read" | "unread">("read");
  const [search, setSearch] = useState("");
  const readers = state
    .filter(
      (reader) =>
        reader.agent_id !== message.sender &&
        (reader.deleted_after == null || message.id <= reader.deleted_after),
    )
    .map((reader) => ({
      id: reader.agent_id,
      name:
        agents.find((agent) => agent.id === reader.agent_id)?.name ??
        `${reader.name ?? "Agent"}${reader.deleted_at ? "（已删除）" : ""}`,
      read:
        message.id <= reader.through ||
        reader.ranges.some(
          (range) => message.id >= range.first && message.id <= range.last,
        ),
    }));
  if (!readers.length) return null;
  const seen = readers.filter((reader) => reader.read);
  const unseen = readers.length - seen.length;
  const visible = readers.filter(
    (reader) =>
      reader.read === (filter === "read") &&
      reader.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  const label = `${seen.length} 人已读，${unseen} 人未读`;
  return (
    <Popover.Root
      onOpenChange={(open) => {
        if (open) {
          setFilter(seen.length ? "read" : "unread");
          setSearch("");
        }
      }}
    >
      <Popover.Trigger
        className={`read-receipt ${seen.length ? "has-read" : ""}`}
        aria-label={`查看阅读详情：${label}`}
      >
        {direct ? (
          <>
            {seen.length ? <CheckCheck size={13} /> : <Check size={13} />}
            <span>{seen.length ? "已读" : "未读"}</span>
          </>
        ) : (
          <>
            {seen.length > 0 && (
              <span className="receipt-avatars" aria-hidden="true">
                {seen.slice(0, 3).map((reader) => (
                  <Avatar key={reader.id} name={reader.name} />
                ))}
              </span>
            )}
            <span>{seen.length} 人已读</span>
            <span className="receipt-separator" aria-hidden="true">
              ·
            </span>
            <span>{unseen} 人未读</span>
          </>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="receipt-popover"
          side="bottom"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          aria-label="阅读详情"
        >
          <div className="receipt-popover-heading">
            <h2>阅读详情</h2>
            <Popover.Close className="icon-button" aria-label="关闭阅读详情">
              <X size={16} />
            </Popover.Close>
          </div>
          <div
            className="receipt-filters"
            role="group"
            aria-label="阅读状态筛选"
          >
            <button
              aria-pressed={filter === "read"}
              onClick={() => setFilter("read")}
            >
              已读 <span>{seen.length}</span>
            </button>
            <button
              aria-pressed={filter === "unread"}
              onClick={() => setFilter("unread")}
            >
              未读 <span>{unseen}</span>
            </button>
          </div>
          {readers.length > 8 && (
            <label className="receipt-search">
              <Search size={15} />
              <input
                aria-label="搜索阅读名单"
                placeholder="搜索 Agent"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
          )}
          <ul
            className="receipt-members"
            aria-label={filter === "read" ? "已读 Agent" : "未读 Agent"}
          >
            {visible.map((reader) => (
              <li key={reader.id}>
                <Avatar name={reader.name} small />
                <span>{reader.name}</span>
                {reader.read && <CheckCheck size={15} aria-label="已读" />}
              </li>
            ))}
            {!visible.length && (
              <li className="receipt-empty">
                {search
                  ? "没有匹配的 Agent"
                  : filter === "read"
                    ? "暂无 Agent 已读"
                    : "全部 Agent 已读"}
              </li>
            )}
          </ul>
          <p className="receipt-footnote">
            已读表示 Agent 已取回正文，不代表已处理。
          </p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
