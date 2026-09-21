import { Hash, LoaderCircle } from "lucide-react";
import Markdown from "react-markdown";
import type { Overview } from "../../shared/schema.ts";
import { isUserRef, LOCAL_USER } from "../../shared/user.ts";
import { Avatar, type Agent } from "../components/AgentAvatar.tsx";
import { ReadReceipt } from "./ReadReceipt.tsx";
import { MessageAttachments } from "./Attachments.tsx";
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
  details,
}: {
  active: Overview["chats"][number];
  agents: Agent[];
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
>) {
  return (
    <div
      ref={scroll}
      className="flex-1 overflow-auto px-[35px] pb-6 pt-[30px] [scrollbar-color:#dfdcd4_transparent] [scrollbar-width:thin] min-[1450px]:px-[max(40px,calc((100vw-1160px)/2))] max-[720px]:px-[22px] max-[720px]:py-6 max-[560px]:px-[18px] max-[560px]:py-[25px]"
      onScroll={onScroll}
    >
      {loading ? (
        <p className="flex items-center justify-center gap-2 p-8 text-xs text-[#8b8170]">
          <LoaderCircle className="spin" size={16} />
          加载消息…
        </p>
      ) : (
        <>
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
          {messages.map((message, index) => {
            const name =
              message.sender === LOCAL_USER
                ? "你"
                : (agents.find((a) => a.id === message.sender)?.name ??
                  `${message.sender_name ?? "Agent"}${message.sender_deleted_at ? "（已删除）" : ""}`);
            const continuation =
              index > 0 &&
              messages[index - 1].sender === message.sender &&
              message.created_at - messages[index - 1].created_at < 180000;
            return (
              <article
                className={`message mb-6 flex items-start gap-[11px] max-[560px]:gap-2.5 ${message.sender === LOCAL_USER ? "outgoing flex-row-reverse" : ""} ${continuation ? "continuation -mt-3" : ""}`}
                key={message.id}
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
                      !continuation &&
                      agents.some((a) => a.id === message.sender)
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
                    <div className="markdown w-full min-w-0 rounded-[4px_13px_13px_13px] border border-[#eeede8] bg-[#f5f5f2] px-3.5 py-2.5 max-[560px]:px-3 max-[560px]:py-[9px] [.outgoing_&]:rounded-[13px_4px_13px_13px] [.outgoing_&]:border-[#e0e8f4] [.outgoing_&]:bg-[#eaf0fa]">
                      <Markdown
                        components={{
                          a: (props) => (
                            <a {...props} target="_blank" rel="noreferrer" />
                          ),
                          img: ({ alt }) => (
                            <span>[图片：{alt || "未加载"}]</span>
                          ),
                        }}
                      >
                        {message.body}
                      </Markdown>
                    </div>
                  ) : null}
                  <MessageAttachments attachments={message.attachments} />
                  <ReadReceipt
                    message={message}
                    state={readState}
                    agents={agents}
                    direct={active.kind === "direct"}
                    details={details}
                  />
                </div>
              </article>
            );
          })}
        </>
      )}
    </div>
  );
}
