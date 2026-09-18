import { useState } from "react";
import { Hash, Plus } from "lucide-react";
import type { Overview } from "../../shared/schema.ts";
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
}: {
  active: Overview["chats"][number] | undefined;
  chatId: string | null;
  agents: Agent[];
  revision: number;
  hidden: boolean;
  details: (id: string) => void;
  refresh: () => void;
}) {
  const conversation = useConversation(chatId, revision);
  const { members } = conversation;
  const [addingMember, setAddingMember] = useState(false);
  const directAgent = agents.find((a) => a.id === active?.direct_agent);
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
          <header className="main-header">
            <div>
              <h1>
                {active.kind === "group" && <Hash size={21} />} {active.name}
              </h1>
              <p>
                {active.ref && (
                  <>
                    <span title="会话短号">{active.ref}</span> ·{" "}
                  </>
                )}
                {members.length} 位 Agent ·{" "}
                {active.kind === "group"
                  ? "@ 提及可及时送达"
                  : "私聊消息及时送达"}
              </p>
            </div>
            <div className="member-stack">
              {agents
                .filter((a) => members.includes(a.id))
                .map((a) => (
                  <button
                    key={a.id}
                    aria-label={`查看 ${a.name} 的收件箱`}
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
            <p className="conversation-alert" role="status">
              暂时无法与 Agent 通信，已发送的消息会保留。
              <button onClick={() => details(directAgent.id)}>查看详情</button>
            </p>
          )}

          <MessageTimeline active={active} agents={agents} {...conversation} />
        </>
      )}
      <MessageComposer
        active={active}
        agents={agents.filter((a) => members.includes(a.id))}
        onSent={() => {
          conversation.followLatest();
          refresh();
        }}
      />
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
