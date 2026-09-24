import { Hash, History, Users } from "lucide-react";
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
  openRecords,
}: {
  active: Overview["chats"][number];
  members: string[];
  agents: Agent[];
  openAgent: (id: string) => void;
  openGroup: () => void;
  openRecords: () => void;
}) {
  const isGroup = active.kind === "group";
  const title = (
    <h1 className="flex items-center gap-2 truncate text-sm font-semibold text-ink">
      {isGroup && <Hash size={15} className="flex-none text-muted" />}
      {active.name}
    </h1>
  );
  return (
    <header className="main-header flex h-12 flex-none items-center justify-between border-b border-line bg-surface/80 px-6 backdrop-blur-sm max-[720px]:px-4 max-[560px]:pl-12">
      <div className="min-w-0">
        {isGroup ? (
          <button
            className="group block min-w-0 max-w-full text-left"
            title="查看群信息"
            onClick={openGroup}
          >
            <span className="group-hover:text-accent-strong">{title}</span>
          </button>
        ) : (
          title
        )}
        <p className="mt-0.5 truncate text-[11px] text-muted">
          {active.read_only ? (
            <span className="text-[#a46452]">Agent 已删除 · 只读历史</span>
          ) : (
            <>
              <span className="font-medium text-ink/80">{members.length}</span>{" "}
              位 Agent · {isGroup ? "@ 提及可及时送达" : "私聊消息及时送达"}
            </>
          )}
        </p>
      </div>
      <div className="member-stack flex items-center gap-1.5">
        {agents
          .filter((a) => members.includes(a.id))
          .map((a) => (
            <button
              key={a.id}
              className="rounded-full transition-transform hover:scale-105"
              aria-label={`查看 ${a.name} 的运行轨迹`}
              title={`${a.name} · ${a.work || runtimeLabel(a)}`}
              onClick={() => openAgent(a.id)}
            >
              <Avatar small name={a.name} presence={agentPresence(a)} />
            </button>
          ))}
        <div className="ml-1 h-3.5 w-px bg-line" />
        <button
          className="icon-button text-muted hover:bg-[#edf3ef] hover:text-ink"
          aria-label="查找聊天记录"
          title="查找聊天记录"
          onClick={openRecords}
        >
          <History size={15} />
        </button>
        {isGroup && (
          <button
            className="icon-button text-muted hover:bg-[#edf3ef] hover:text-ink"
            aria-label="群信息"
            title="群信息"
            onClick={openGroup}
          >
            <Users size={15} />
          </button>
        )}
      </div>
    </header>
  );
}
