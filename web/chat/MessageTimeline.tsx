import { Hash, LoaderCircle } from "lucide-react";
import Markdown from "react-markdown";
import type { Overview } from "../../shared/schema.ts";
import { Avatar, type Agent } from "../components/AgentAvatar.tsx";
import { ReadReceipt } from "./ReadReceipt.tsx";
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
}: {
  active: Overview["chats"][number];
  agents: Agent[];
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
    <div ref={scroll} className="timeline" onScroll={onScroll}>
      {loading ? (
        <p className="loading">
          <LoaderCircle className="spin" size={16} />
          加载消息…
        </p>
      ) : (
        <>
          {older && (
            <button className="older" onClick={() => void loadOlder()}>
              查看更早消息
            </button>
          )}
          {!messages.length && (
            <div className="conversation-start">
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
              message.sender === "user"
                ? "你"
                : (agents.find((a) => a.id === message.sender)?.name ??
                  `${message.sender_name ?? "Agent"}${message.sender_deleted_at ? "（已删除）" : ""}`);
            const continuation =
              index > 0 &&
              messages[index - 1].sender === message.sender &&
              message.created_at - messages[index - 1].created_at < 180000;
            return (
              <article
                className={`message ${message.sender === "user" ? "outgoing" : "incoming"} ${continuation ? "continuation" : ""}`}
                key={message.id}
                data-message-id={message.id}
              >
                <span
                  className="message-avatar"
                  aria-hidden={continuation || undefined}
                >
                  <Avatar name={name} />
                </span>
                <div className="message-content">
                  {!continuation && (
                    <div className="message-heading">
                      <strong>{name}</strong>
                      {message.sender !== "user" && (
                        <span className="agent-tag">Agent</span>
                      )}
                      <time>{time(message.created_at)}</time>
                    </div>
                  )}
                  <div className="message-bubble markdown">
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
                  <ReadReceipt
                    message={message}
                    state={readState}
                    agents={agents}
                    direct={active.kind === "direct"}
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
