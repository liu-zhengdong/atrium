import { useState } from "react";
import type { Overview } from "../../shared/schema.ts";
import { api } from "../api.ts";
import type { Agent } from "../components/AgentAvatar.tsx";
import { MessageComposer } from "./MessageComposer.tsx";
import { MessageTimeline } from "./MessageTimeline.tsx";
import { ChatNotice } from "./ChatNotice.tsx";
import { useConversation } from "./useConversation.ts";
import { useAnchorScroll, useReadReporter } from "./useChatEffects.ts";

export function ChatView({
  active,
  chatId,
  agents,
  revision,
  hidden,
  details,
  inspectAgent,
  openTrigger,
  refresh,
  anchor,
  clearAnchor,
  openGroup,
  openRecords,
}: {
  active: Overview["chats"][number] | undefined;
  chatId: string | null;
  agents: Agent[];
  revision: number;
  hidden: boolean;
  details: (id: string) => void;
  inspectAgent: (id: string) => void;
  openTrigger: (id: string, traceId: number) => void;
  refresh: () => void;
  anchor: { chatId: string; messageId: number } | null;
  clearAnchor: () => void;
  openGroup: () => void;
  openRecords: () => void;
}) {
  const anchoredId =
    anchor && anchor.chatId === chatId ? anchor.messageId : undefined;
  const conversation = useConversation(chatId, revision, anchoredId);
  const { members } = conversation;
  const directAgent = agents.find((a) => a.id === active?.direct_agent);
  const [retryError, setRetryError] = useState<{
    id: string;
    text: string;
  } | null>(null);
  const observed = active && !active.mine && !active.read_only ? active : null;
  useReadReporter({
    chatId,
    latest: conversation.messages.at(-1)?.id ?? 0,
    hidden,
    anchoredId,
    atBottom: conversation.atBottom,
  });
  const flash = useAnchorScroll({
    chatId,
    anchoredId,
    loading: conversation.loading,
    scrollToMessage: conversation.scrollToMessage,
  });
  return (
    <section
      className="chat-panel"
      hidden={hidden || !active}
      aria-label="聊天内容"
    >
      {conversation.error && (
        <p className="error" role="alert">
          {conversation.error} <button onClick={refresh}>重试</button>
        </p>
      )}
      {active && (
        <>
          <ChatNotice notice={active.notice} />
          {directAgent?.sleeping_at && (
            <p
              className="flex items-center gap-2 bg-soft px-[35px] py-2.5 text-xs text-muted max-[560px]:px-[18px]"
              role="status"
            >
              {directAgent.waking
                ? "正在唤醒"
                : directAgent.failure
                  ? "唤醒失败 · 可重试。已发送的消息会保留。"
                  : "休息中 · 来消息会醒"}
              {directAgent.failure && !directAgent.waking && (
                <button
                  className="underline"
                  onClick={() => {
                    setRetryError(null);
                    void api(`/agents/${directAgent.id}/retry`, "POST")
                      .catch((e) =>
                        setRetryError({ id: directAgent.id, text: String(e) }),
                      )
                      .finally(refresh);
                  }}
                >
                  重试
                </button>
              )}
              {retryError?.id === directAgent.id && retryError.text}
            </p>
          )}
          {directAgent?.error && !directAgent.sleeping_at && (
            <p
              className="bg-soft px-[35px] py-2.5 text-xs text-muted max-[560px]:px-[18px]"
              role="status"
            >
              暂时无法与 Agent 通信，已发送的消息会保留。
              <button
                className="ml-2 underline"
                onClick={() => inspectAgent(directAgent.id)}
              >
                查看详情
              </button>
            </p>
          )}
          {anchoredId && (
            <p
              className="flex items-center justify-center gap-2.5 rounded-lg bg-[#edf5f1] px-3 py-1.5 text-xs text-[#316e50]"
              role="note"
            >
              已定位到搜索到的消息
              <button
                className="text-xs text-[#316e50] underline underline-offset-[3px]"
                onClick={clearAnchor}
              >
                回到最新
              </button>
            </p>
          )}
          <MessageTimeline
            active={active}
            agents={agents}
            details={details}
            openTrigger={openTrigger}
            flash={flash}
            {...conversation}
          />
        </>
      )}
      {active?.read_only ? (
        <p
          className="bg-soft px-[35px] py-2.5 text-xs text-muted max-[560px]:px-[18px]"
          role="status"
        >
          这个 Agent 已删除，聊天记录仍可查看，不能继续发送消息。
        </p>
      ) : (
        <>
          {observed && (
            <p
              className="px-[35px] pt-1.5 text-[11px] text-[#a09b8d]"
              role="note"
            >
              {observed.kind === "direct"
                ? `这是 ${observed.name} 的私聊，你的发言对双方可见`
                : "你不是这个群的成员，发言会对群内成员可见"}
            </p>
          )}
          <MessageComposer
            active={active}
            agents={agents.filter((a) => members.includes(a.id))}
            onSent={() => {
              conversation.followLatest();
              refresh();
            }}
          />
        </>
      )}
    </section>
  );
}
