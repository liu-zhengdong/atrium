import { useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { CheckCheck, Search, X } from "lucide-react";
import type { ChatReadState, Message } from "../../shared/schema.ts";
import { Avatar, type Agent } from "../components/AgentAvatar.tsx";
import { isImeKey } from "../keys.ts";

export function ReadReceipt({
  message,
  state,
  agents,
  direct,
  details,
}: {
  message: Message;
  state: ChatReadState[];
  agents: Agent[];
  direct: boolean;
  details: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
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
  if (direct && !seen.length) return null;
  const visible = readers.filter(
    (reader) =>
      reader.read === (filter === "read") &&
      reader.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  const label = `${seen.length} 人已读，${unseen} 人未读`;
  return (
    <Popover.Root
      open={open}
      onOpenChange={(open) => {
        setOpen(open);
        if (open) {
          setFilter(seen.length ? "read" : "unread");
          setSearch("");
        }
      }}
    >
      <Popover.Trigger
        ref={trigger}
        className={`mt-[3px] inline-flex min-h-[26px] max-w-full items-center justify-end gap-[5px] self-end whitespace-nowrap rounded px-[2px] py-[3px] text-[11px] leading-[1.6] hover:bg-[#f0f2f5] hover:text-[#3e577e] data-[state=open]:bg-[#f0f2f5] data-[state=open]:text-[#3e577e] max-[560px]:min-h-8 ${
          seen.length ? "text-[#687a99]" : "text-[#8a887f]"
        }`}
        aria-label={`查看阅读详情：${label}`}
      >
        {direct ? (
          <>
            <CheckCheck size={13} />
            <span>已读</span>
          </>
        ) : (
          <>
            {seen.length > 0 && (
              <span
                className="inline-flex items-center pr-0.5"
                aria-hidden="true"
              >
                {seen.slice(0, 3).map((reader, i) => (
                  <Avatar
                    key={reader.id}
                    name={reader.name}
                    tiny
                    className={`ring-2 ring-white ${i ? "-ml-1.5" : ""}`}
                  />
                ))}
              </span>
            )}
            {unseen > 0 && <span>{unseen} 人未读</span>}
          </>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="z-[60] max-h-[var(--radix-popover-content-available-height)] w-[304px] max-w-[calc(100vw-24px)] overflow-auto rounded-xl border border-[#e6e7e9] bg-white p-4 text-[#3b3e43] shadow-[0_8px_32px_#20283816,0_2px_8px_#20283809]"
          side="bottom"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          aria-label="阅读详情"
          onEscapeKeyDown={(event) => {
            // 搜索框里选字时按 Esc：Radix 自己监听 Esc，不走 isImeKey，要在这里挡住。
            if (isImeKey(event)) event.preventDefault();
          }}
        >
          <div className="mb-3 flex items-center justify-between">
            <h2 className="m-0 text-sm font-semibold">阅读详情</h2>
            <Popover.Close
              className="icon-button h-[25px] w-[25px] text-[#85888f]"
              aria-label="关闭阅读详情"
            >
              <X size={16} />
            </Popover.Close>
          </div>
          <div
            className="flex gap-5 border-b border-[#eeeff1]"
            role="group"
            aria-label="阅读状态筛选"
          >
            <button
              className="border-b-2 border-transparent px-0.5 pb-2.5 text-xs text-[#888b93] aria-pressed:border-[#6f8caf] aria-pressed:text-[#3f5e8d]"
              aria-pressed={filter === "read"}
              onClick={() => setFilter("read")}
            >
              已读 <span className="ml-[3px] text-[11px]">{seen.length}</span>
            </button>
            <button
              className="border-b-2 border-transparent px-0.5 pb-2.5 text-xs text-[#888b93] aria-pressed:border-[#6f8caf] aria-pressed:text-[#3f5e8d]"
              aria-pressed={filter === "unread"}
              onClick={() => setFilter("unread")}
            >
              未读 <span className="ml-[3px] text-[11px]">{unseen}</span>
            </button>
          </div>
          {readers.length > 8 && (
            <label className="receipt-search mt-3 flex items-center gap-[7px] rounded-md border border-[#e6e7e9] px-[9px] py-[7px] text-[#9b9da3] transition-[border-color] duration-150 focus-within:border-[#c4b9a4] focus-within:bg-white">
              <Search size={15} />
              <input
                className="plain-field w-full min-w-0 border-0 bg-transparent text-xs"
                aria-label="搜索阅读名单"
                placeholder="搜索 Agent"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
          )}
          <ul
            className="my-2 max-h-60 list-none overflow-auto p-0 [scrollbar-width:thin]"
            aria-label={filter === "read" ? "已读 Agent" : "未读 Agent"}
          >
            {visible.map((reader) => (
              <li
                className="flex min-h-[46px] items-center gap-2.5 px-0.5 py-1.5"
                key={reader.id}
              >
                <Avatar
                  name={reader.name}
                  small
                  onClick={
                    agents.some((a) => a.id === reader.id)
                      ? () => {
                          setOpen(false);
                          trigger.current?.focus({ preventScroll: true });
                          details(reader.id);
                        }
                      : undefined
                  }
                />
                <span className="min-w-0 flex-1 text-[13px] [overflow-wrap:anywhere]">
                  {reader.name}
                </span>
                {reader.read && (
                  <CheckCheck
                    size={15}
                    className="flex-none text-[#718cb0]"
                    aria-label="已读"
                  />
                )}
              </li>
            ))}
            {!visible.length && (
              <li className="flex min-h-[94px] items-center justify-center text-xs text-[#999ca3]">
                {search
                  ? "没有匹配的 Agent"
                  : filter === "read"
                    ? "暂无 Agent 已读"
                    : "全部 Agent 已读"}
              </li>
            )}
          </ul>
          <p className="m-0 border-t border-[#eeeff1] pt-2.5 text-[10px] leading-[1.7] text-[#999ca3]">
            已读表示 Agent 已取回正文，不代表已处理。
          </p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
