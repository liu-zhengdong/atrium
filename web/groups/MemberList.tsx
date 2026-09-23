import { useState } from "react";
import { createPortal } from "react-dom";
import { Plus, UserMinus } from "lucide-react";
import { api } from "../api.ts";
import { useJson } from "../useJson.ts";
import {
  agentPresence,
  Avatar,
  runtimeLabel,
  type Agent,
} from "../components/AgentAvatar.tsx";
import { Modal } from "../components/Modal.tsx";
import { AddMemberDialog } from "../chat/ChatDialogs.tsx";

/** 群成员：状态点、工作声明与自我介绍；工作声明由 Agent 自己报，会变。 */
export function MemberList({
  chatId,
  agents,
  changed,
  openAgent,
}: {
  chatId: string;
  agents: Agent[];
  changed: () => void;
  openAgent: (id: string) => void;
}) {
  const [revision, setRevision] = useState(0);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Agent | null>(null);
  const { data, error, loading } = useJson<{ members: string[] }>(
    `/chats/${chatId}`,
    revision,
  );
  const members = data?.members ?? [];
  const inGroup = agents.filter((agent) => members.includes(agent.id));
  function reload() {
    setRevision((n) => n + 1);
    changed();
  }
  return (
    <div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {loading && <p className="muted">读取中…</p>}
      <ul className="m-0 list-none p-0">
        {inGroup.map((agent) => (
          <li
            key={agent.id}
            className="group flex items-start gap-3 rounded-[8px] px-2.5 py-2 transition-colors hover:bg-[#edf5f1]"
          >
            <button
              className="mt-0.5 flex-none"
              aria-label={`查看 ${agent.name} 的运行轨迹`}
              onClick={() => openAgent(agent.id)}
            >
              <Avatar name={agent.name} presence={agentPresence(agent)} small />
            </button>
            <div className="min-w-0 flex-1">
              <p className="m-0 flex items-baseline gap-2 text-[13px] font-[550] text-ink">
                <span className="truncate">{agent.name}</span>
                <span className="muted small-text flex-none">{agent.ref}</span>
              </p>
              <p className="m-0 mt-0.5 truncate text-[11.5px] text-muted">
                {agent.work || runtimeLabel(agent)}
              </p>
              {agent.description && (
                <p className="m-0 mt-1 line-clamp-2 text-[11.5px] text-muted/80">
                  {agent.description}
                </p>
              )}
            </div>
            <button
              className="icon-button mt-0.5 flex-none text-muted opacity-0 hover:text-red-600 group-hover:opacity-100 focus:opacity-100"
              aria-label={`把 ${agent.name} 移出群`}
              title="移出群"
              onClick={() => setRemoving(agent)}
            >
              <UserMinus size={14} />
            </button>
          </li>
        ))}
      </ul>
      {!loading && !inGroup.length && (
        <p className="muted">这个群还没有成员。</p>
      )}
      <button
        className="button secondary mt-3 flex h-7 items-center gap-1.5 px-3 text-xs"
        onClick={() => setAdding(true)}
      >
        <Plus size={14} /> 添加成员
      </button>
      {adding && (
        <AddMemberDialog
          chatId={chatId}
          agents={agents}
          members={members}
          close={() => setAdding(false)}
          added={reload}
        />
      )}
      {removing && (
        <RemoveMember
          chatId={chatId}
          agent={removing}
          close={() => setRemoving(null)}
          removed={reload}
        />
      )}
    </div>
  );
}

function RemoveMember({
  chatId,
  agent,
  close,
  removed,
}: {
  chatId: string;
  agent: Agent;
  close: () => void;
  removed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function remove() {
    setBusy(true);
    setError("");
    try {
      await api(`/chats/${chatId}/members/${agent.id}`, "DELETE");
      removed();
      close();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }
  return createPortal(
    <Modal title="移出群成员？" close={close}>
      <div
        className="px-6 py-[22px] text-[13px] leading-[1.8]"
        aria-busy={busy}
      >
        <p className="m-0 text-base font-semibold [overflow-wrap:anywhere]">
          {agent.name} <span className="muted">· {agent.ref}</span>
        </p>
        <p className="mb-0 mt-3.5">
          移出后它不能再读取或发送这个群的消息，本群未处理的提醒会收回，并收到一条说明。
        </p>
        <p className="muted mt-3.5">
          群里的历史发言保留。需要时可以再把它加回来。
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="mt-[25px] flex justify-end gap-[9px]">
          <button
            className="button secondary"
            data-autofocus
            disabled={busy}
            onClick={close}
          >
            取消
          </button>
          <button
            className="button danger solid"
            disabled={busy}
            onClick={() => void remove()}
          >
            {busy ? "移出中…" : "确认移出"}
          </button>
        </div>
      </div>
    </Modal>,
    document.body,
  );
}
