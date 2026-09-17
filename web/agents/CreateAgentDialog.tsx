import { api } from "../api.ts";
import { SubmitDialog } from "../components/SubmitDialog.tsx";
import type { Agent } from "../components/AgentAvatar.tsx";
export function CreateAgentDialog({
  close,
  created,
}: {
  close: () => void;
  created: (agent: Agent, startError?: string) => Promise<void>;
}) {
  async function submit(data: FormData) {
    const result = await api<{ agent: Agent; start_error?: string }>(
      "/agents",
      "POST",
      { name: data.get("name"), cwd: data.get("cwd"), start: true },
    );
    await created(result.agent, result.start_error);
  }
  return (
    <SubmitDialog
      title="新建 Agent"
      close={close}
      submit={submit}
      submitLabel="创建并启动"
      pendingLabel="创建并启动中…"
    >
      <p className="muted">创建一位新的 Agent，并启动它的后台 Pi。</p>
      <label>
        名称
        <input
          name="name"
          required
          maxLength={40}
          placeholder="例如 Atlas"
          autoFocus
        />
      </label>
      <label>
        工作目录
        <input name="cwd" required placeholder="/绝对路径/工作目录" />
      </label>
      <p className="muted small-text">
        Pi
        使用该目录和你现有的权限运行，不是隔离沙箱。退出后默认不被事件自动拉起。
      </p>
    </SubmitDialog>
  );
}
