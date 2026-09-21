import { Hash, Users } from "lucide-react";
import type { Overview } from "../../shared/schema.ts";
import {
  agentPresence,
  Avatar,
  runtimeLabel,
  type Agent,
} from "../components/AgentAvatar.tsx";

/** 聊天顶栏：标题、短号、成员摘要与头像堆叠。 */
export function ChatHeader({
  active,
  members,
  agents,
  openAgent,
  openGroup,
}: {
  active: Overview["chats"][number];
  members: string[];
  agents: Agent[];
  openAgent: (id: string) => void;
  openGroup: () => void;
}) {
  const isGroup = active.kind === "group";
  const title = (
    <h1 className="flex items-center gap-[7px] truncate text-[15px] font-semibold max-[560px]:text-[15px]">
      {isGroup && <Hash size={16} className="flex-none text-[#a39b8b]" />}
      {active.name}
    </h1>
  );
  return (
    <header className="main-header flex h-[52px] flex-none items-center justify-between border-b border-[#eeede8] px-[35px] max-[720px]:px-[22px] max-[560px]:pl-[49px]">
      <div className="min-w-0">
        {isGroup ? (
          <button
            className="block min-w-0 max-w-full text-left"
            title="查看群信息"
            onClick={openGroup}
          >
            {title}
          </button>
        ) : (
          title
        )}
        <p className="mt-px truncate text-[11px] text-[#959084] max-[560px]:text-[10px]">
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
              {isGroup ? "@ 提及可及时送达" : "私聊消息及时送达"}
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
              onClick={() => openAgent(a.id)}
            >
              <Avatar small name={a.name} presence={agentPresence(a)} />
            </button>
          ))}
        {isGroup && (
          <button
            className="icon-button"
            aria-label="群信息"
            title="群信息"
            onClick={openGroup}
          >
            <Users size={16} />
          </button>
        )}
      </div>
    </header>
  );
}
