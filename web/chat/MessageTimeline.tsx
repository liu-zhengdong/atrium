import { useMemo } from "react";
import { Hash, LoaderCircle } from "lucide-react";
import type { ChatReadState, Message, Overview } from "../../shared/schema.ts";
import { isUserRef, LOCAL_USER } from "../../shared/user.ts";
import { Avatar, type Agent } from "../components/AgentAvatar.tsx";
import { ReadReceipt } from "./ReadReceipt.tsx";
import { MessageBody } from "./MessageBody.tsx";
import { useFolds, type Expanded } from "./useFolds.ts";
import { MessageAttachments } from "./Attachments.tsx";
import { continuationFlags } from "./messages.ts";
import { time } from "../time.ts";
import type { useConversation } from "./useConversation.ts";

export function MessageTimeline({
  active,
  agents,
  messages,
  readState,
  loading,
  older,
  loadOlder,
  scroll,
  onScroll,
  headerRef,
  virtualizer,
  holdPosition,
  flash,
  details,
}: {
  active: Overview["chats"][number];
  agents: Agent[];
  flash: number | null;
  details: (id: string) => void;
} & Pick<
  ReturnType<typeof useConversation>,
  | "messages"
  | "readState"
  | "loading"
  | "older"
  | "loadOlder"
  | "scroll"
  | "onScroll"
  | "headerRef"
  | "virtualizer"
  | "holdPosition"
>) {
  // 连续发言按完整消息数组判断，与当前渲染的窗口无关。
  const continuations = useMemo(() => continuationFlags(messages), [messages]);
  const { expanded, toggle } = useFolds(scroll, holdPosition);
  const rows = virtualizer.getVirtualItems();
  return (
    <div
      ref={scroll}
      className="flex-1 overflow-auto px-[35px] [scrollbar-color:#dfdcd4_transparent] [scrollbar-width:thin] min-[1450px]:px-[max(40px,calc((100vw-1160px)/2))] max-[720px]:px-[22px] max-[560px]:px-[18px]"
      onScroll={onScroll}
    >
      {loading ? (
        <p className="flex items-center justify-center gap-2 p-8 text-xs text-[#8b8170]">
          <LoaderCircle className="spin" size={16} />
          加载消息…
        </p>
      ) : (
        <div
          className="relative w-full"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {/* 顶部留白、翻页按钮和空态不进虚拟列表，实测高度就是列表起点 */}
          <div
            ref={headerRef}
            className="absolute inset-x-0 top-0 flex flex-col pt-[30px] max-[720px]:pt-6 max-[560px]:pt-[25px]"
          >
            {older && (
              <button
                className="mx-auto mb-[30px] block rounded-md bg-[#f8f6f0] px-3 py-1.5 text-[11px] text-[#8e816b]"
                onClick={() => void loadOlder()}
              >
                查看更早消息
              </button>
            )}
            {!messages.length && (
              <div className="pb-[45px] pt-[30px] text-[#968972] [&_h2]:mb-[7px] [&_h2]:mt-[13px] [&_h2]:text-[#484236] [&_p]:text-xs [&_p]:text-[#a09584]">
                <Hash size={27} />
                <h2>{active.name}</h2>
                <p>
                  这是对话的开始。
                  {active.read_only
                    ? "这个 Agent 已删除，没有历史消息。"
                    : active.kind === "group"
                      ? "试着 @ 一位 Agent。"
                      : "发一条消息，和它聊聊。"}
                </p>
              </div>
            )}
          </div>
          {rows.map((row) => {
            const message = messages[row.index];
            if (!message) return null;
            return (
              <div
                key={row.key}
                data-index={row.index}
                ref={virtualizer.measureElement}
                // 下一条是同一个人的后续发言就收窄间距；间距计入本行高度，测量才准。
                className={`absolute inset-x-0 top-0 ${continuations[row.index + 1] ? "pb-3" : "pb-6"}`}
                style={{ transform: `translateY(${row.start}px)` }}
              >
                <MessageRow
                  message={message}
                  continuation={continuations[row.index] ?? false}
                  flash={flash === message.id}
                  agents={agents}
                  readState={readState}
                  direct={active.kind === "direct"}
                  details={details}
                  expanded={expanded[message.id] ?? {}}
                  toggle={toggle(message.id)}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MessageRow({
  message,
  continuation,
  flash,
  agents,
  readState,
  direct,
  details,
  expanded,
  toggle,
}: {
  message: Message;
  continuation: boolean;
  flash: boolean;
  agents: Agent[];
  readState: ChatReadState[];
  direct: boolean;
  details: (id: string) => void;
  expanded: Expanded;
  toggle: (part: keyof Expanded, anchor: HTMLElement) => void;
}) {
  const name =
    message.sender === LOCAL_USER
      ? "你"
      : (agents.find((a) => a.id === message.sender)?.name ??
        `${message.sender_name ?? "Agent"}${message.sender_deleted_at ? "（已删除）" : ""}`);
  return (
    <article
      className={`message flex items-start gap-[11px] max-[560px]:gap-2.5 ${message.sender === LOCAL_USER ? "outgoing flex-row-reverse" : ""} ${continuation ? "continuation" : ""} ${flash ? "flash" : ""}`}
      id={`msg-${message.id}`}
      data-message-id={message.id}
    >
      <span
        className={`flex-none basis-[34px] ${continuation ? "invisible" : ""}`}
        aria-hidden={continuation || undefined}
      >
        <Avatar
          name={name}
          onClick={
            !continuation && agents.some((a) => a.id === message.sender)
              ? () => details(message.sender)
              : undefined
          }
        />
      </span>
      <div className="flex min-w-0 max-w-[min(78%,760px)] flex-col items-start max-[560px]:max-w-[calc(100%-44px)] [.outgoing_&]:items-end">
        {!continuation && (
          <div className="mb-[5px] flex min-h-[22px] items-center gap-2">
            <strong className="text-xs font-[550]">{name}</strong>
            {!isUserRef(message.sender) && (
              <span className="rounded-[3px] border border-[#e7e6de] px-1 text-[9px] text-[#898779]">
                Agent
              </span>
            )}
            {message.mention_all && (
              <span
                className="rounded-[3px] bg-[#f1ece0] px-1 text-[9px] text-[#8a7a58]"
                title="发给了群内每位成员"
              >
                @全体
              </span>
            )}
            <time className="text-[10px] text-[#949187]">
              {time(message.created_at)}
            </time>
          </div>
        )}
        {message.body.trim() ? (
          <MessageBody message={message} expanded={expanded} toggle={toggle} />
        ) : null}
        <MessageAttachments attachments={message.attachments} />
        <ReadReceipt
          message={message}
          state={readState}
          agents={agents}
          direct={direct}
          details={details}
        />
      </div>
    </article>
  );
}
