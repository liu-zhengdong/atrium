import { useEffect, useRef, useState } from "react";
import { Hash, Plus } from "lucide-react";
import type { Overview } from "../../shared/schema.ts";
import { api } from "../api.ts";
import {
  Avatar,
  runtimeLabel,
  type Agent,
} from "../components/AgentAvatar.tsx";
import { MessageComposer } from "./MessageComposer.tsx";
import { MessageTimeline } from "./MessageTimeline.tsx";
import { AddMemberDialog } from "./ChatDialogs.tsx";
import { useConversation } from "./useConversation.ts";
export function ChatView({
  active,
  chatId,
  agents,
  revision,
  hidden,
  details,
  refresh,
  anchor,
  clearAnchor,
}: {
  active: Overview["chats"][number] | undefined;
  chatId: string | null;
  agents: Agent[];
  revision: number;
  hidden: boolean;
  details: (id: string) => void;
  refresh: () => void;
  anchor: { chatId: string; messageId: number } | null;
  clearAnchor: () => void;
}) {
  const anchoredId =
    anchor && anchor.chatId === chatId ? anchor.messageId : undefined;
  const conversation = useConversation(chatId, revision, anchoredId);
  const { members } = conversation;
  const [addingMember, setAddingMember] = useState(false);
  const directAgent = agents.find((a) => a.id === active?.direct_agent);
  const observed =
    active && !active.mine && !active.read_only ? active : null;
  const latest = conversation.messages.at(-1)?.id ?? 0;
  const markedRead = useRef(0);
  useEffect(() => {
    markedRead.current = 0;
  }, [chatId]);
  useEffect(() => {
    if (!chatId || hidden || !latest || latest <= markedRead.current) return;
    if (anchoredId) return; // 定位到历史消息不代表读到了最新
    if (!conversation.atBottom()) return;
    markedRead.current = latest;
    void api(`/chats/${chatId}/read`, "POST", { through: latest }).catch(
      () => {
        markedRead.current = 0;
      },
    );
  }, [chatId, latest, hidden, anchoredId]);
  const scrolledTo = useRef("");
  useEffect(() => {
    if (!anchoredId || conversation.loading) return;
    const key = `${chatId}:${anchoredId}`;
    if (scrolledTo.current === key) return;
    const el = document.getElementById(`msg-${anchoredId}`);
    if (!el) return;
    scrolledTo.current = key;
    el.scrollIntoView({ block: "center" });
    el.classList.add("flash");
    const timer = setTimeout(() => el.classList.remove("flash"), 2400);
    return () => clearTimeout(timer);
  }, [anchoredId, conversation.loading, chatId]);
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
          <header className="main-header flex h-[83px] flex-none items-center justify-between border-b border-[#eeede8] px-[35px] max-[720px]:h-[72px] max-[720px]:px-[22px] max-[560px]:pl-[49px]">
            <div>
              <h1 className="flex items-center gap-[7px] text-[17px] font-semibold max-[560px]:text-[15px]">
                {active.kind === "group" && (
                  <Hash size={21} className="text-[#a39b8b]" />
                )}{" "}
                {active.name}
              </h1>
              <p className="mt-1 text-[11px] text-[#959084] max-[560px]:text-[10px]">
                {active.ref && (
                  <>
                    <span title="会话短号">{active.ref}</span> ·{" "}
                  </>
                )}
                {active.read_only ? (
                  "Agent 已删除 · 历史记录"
                ) : (
                  <>
                    {members.length} 位 Agent ·{" "}
                    {active.kind === "group"
                      ? "@ 提及可及时送达"
                      : "私聊消息及时送达"}
                  </>
                )}
              </p>
            </div>
            <div className="member-stack">
              {agents
                .filter((a) => members.includes(a.id))
                .map((a) => (
                  <button
                    key={a.id}
                    aria-label={`查看 ${a.name} 的运行轨迹`}
                    title={`${a.name} · ${a.work || runtimeLabel(a)}`}
                    onClick={() => details(a.id)}
                  >
                    <Avatar small name={a.name} online={a.available} />
                  </button>
                ))}
              {active.kind === "group" && (
                <button
                  className="icon-button"
                  aria-label="添加群成员"
                  onClick={() => {
                    setAddingMember(true);
                  }}
                >
                  <Plus size={16} />
                </button>
              )}
            </div>
          </header>
          {directAgent?.error && (
            <p className="bg-soft px-[35px] py-2.5 text-xs text-muted max-[560px]:px-[18px]" role="status">
              暂时无法与 Agent 通信，已发送的消息会保留。
              <button
                className="ml-2 underline"
                onClick={() => details(directAgent.id)}
              >
                查看详情
              </button>
            </p>
          )}

          {anchoredId && (
            <p className="flex items-center justify-center gap-2.5 border-b border-[#eadfc8] bg-[#f6efe2] px-3 py-[7px] text-xs text-[#8a7150]" role="note">
              已定位到搜索到的消息
              <button
                className="text-xs text-[#72634a] underline underline-offset-[3px]"
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
            {...conversation}
          />
        </>
      )}
      {active?.read_only ? (
        <p className="bg-soft px-[35px] py-2.5 text-xs text-muted max-[560px]:px-[18px]" role="status">
          这个 Agent 已删除，聊天记录仍可查看，不能继续发送消息。
        </p>
      ) : (
        <>
          {observed && (
            <p className="px-[35px] pt-1.5 text-[11px] text-[#a09b8d]" role="note">
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
      {addingMember && active && (
        <AddMemberDialog
          chatId={active.id}
          agents={agents}
          members={members}
          close={() => setAddingMember(false)}
          added={refresh}
        />
      )}
    </section>
  );
}
