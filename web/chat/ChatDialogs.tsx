import { api } from "../api.ts";
import { SubmitDialog } from "../components/SubmitDialog.tsx";
import {
  Avatar,
  runtimeLabel,
  type Agent,
} from "../components/AgentAvatar.tsx";
export function CreateChatDialog({
  agents,
  close,
  created,
}: {
  agents: Agent[];
  close: () => void;
  created: (id: string) => void;
}) {
  async function submit(data: FormData) {
    const direct = data.get("direct")?.toString();
    const result = await api<{ id: string }>(
      "/chats",
      "POST",
      direct
        ? {
            name: agents.find((a) => a.id === direct)?.name,
            members: [direct],
            direct_agent: direct,
          }
        : { name: data.get("name"), members: data.getAll("members") },
    );
    created(result.id);
  }
  return (
    <SubmitDialog title="新建会话" close={close} submit={submit}>
      <label className="form-label">
        群聊名称
        <input
          className="field"
          name="name"
          maxLength={40}
          placeholder="例如 Chat 开发"
          autoFocus
        />
      </label>
      <fieldset className="member-picker">
        <legend className="member-picker-legend">群成员</legend>
        {agents.map((a) => (
          <label className="check-row" key={a.id}>
            <input type="checkbox" name="members" value={a.id} />
            <Avatar small name={a.name} />
            {a.name}
            <span className="muted">{runtimeLabel(a)}</span>
          </label>
        ))}
        {!agents.length && (
          <p className="muted">可先创建群聊，或关闭后添加 Agent。</p>
        )}
      </fieldset>
      <label className="form-label">
        或直接发起私聊
        <select className="field" name="direct" defaultValue="">
          <option value="">创建上面的群聊</option>
          {agents.map((a) => (
            <option value={a.id} key={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
    </SubmitDialog>
  );
}
export function AddMemberDialog({
  chatId,
  agents,
  members,
  close,
  added,
}: {
  chatId: string;
  agents: Agent[];
  members: string[];
  close: () => void;
  added: () => void;
}) {
  async function submit(data: FormData) {
    await api(`/chats/${chatId}/members`, "POST", {
      agent_id: data.get("member"),
    });
    added();
  }
  return (
    <SubmitDialog
      title="添加群成员"
      close={close}
      submit={submit}
      submitLabel="添加"
      pendingLabel="添加中…"
    >
      <p className="muted">加入后可读取本群的聊天记录。</p>
      <label className="form-label">
        Agent
        <select className="field" name="member" required defaultValue="">
          <option value="" disabled>
            选择要加入的 Agent
          </option>
          {agents
            .filter((a) => !members.includes(a.id))
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
        </select>
      </label>
    </SubmitDialog>
  );
}
