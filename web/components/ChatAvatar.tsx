import type { Chat } from "../../shared/schema.ts";
import { agentPresence, Avatar, type Agent } from "./AgentAvatar.tsx";

/** 会话列表头像：我的私聊用对方头像，Agent 间私聊与群用成员首字合成。 */
export function ChatAvatar({ chat, agents }: { chat: Chat; agents: Agent[] }) {
  if (chat.kind === "direct" && chat.direct_agent) {
    const agent = agents.find((a) => a.id === chat.direct_agent);
    return (
      <Avatar
        small
        name={agent?.name ?? chat.member_names?.[0] ?? chat.name}
        presence={agentPresence(agent)}
      />
    );
  }
  const names = (
    chat.member_names?.length ? chat.member_names : [chat.name]
  ).slice(0, 4);
  const fontSize =
    names.length === 1
      ? "text-sm"
      : names.length === 2
        ? "text-[11px]"
        : "text-[10px]";
  return (
    <span
      className={`grid h-[34px] w-[34px] flex-none overflow-hidden rounded-[9px] bg-[#e9e6dd] not-italic text-[#6d6a5e] ${
        names.length === 1 ? "grid-cols-1" : "grid-cols-2"
      }`}
      aria-hidden
    >
      {names.map((name) => (
        <i
          key={name}
          className={`flex min-w-0 items-center justify-center not-italic ${fontSize}`}
        >
          {[...name][0]}
        </i>
      ))}
    </span>
  );
}
