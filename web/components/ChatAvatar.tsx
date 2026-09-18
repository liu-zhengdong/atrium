import type { Chat } from "../../shared/schema.ts";
import { Avatar, type Agent } from "./AgentAvatar.tsx";

/** 会话列表头像：我的私聊用对方头像，Agent 间私聊与群用成员首字合成。 */
export function ChatAvatar({
  chat,
  agents,
}: {
  chat: Chat;
  agents: Agent[];
}) {
  if (chat.kind === "direct" && chat.direct_agent) {
    const agent = agents.find((a) => a.id === chat.direct_agent);
    return (
      <Avatar
        small
        name={agent?.name ?? chat.member_names?.[0] ?? chat.name}
        online={agent?.available ?? false}
      />
    );
  }
  const names = (chat.member_names?.length
    ? chat.member_names
    : [chat.name]
  ).slice(0, 4);
  return (
    <span className={`chat-avatar pieces-${names.length}`} aria-hidden>
      {names.map((name) => (
        <i key={name}>{[...name][0]}</i>
      ))}
    </span>
  );
}
