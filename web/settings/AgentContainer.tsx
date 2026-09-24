import { useEffect, useState } from "react";
import { api } from "../api.ts";
import type { Agent } from "../components/AgentAvatar.tsx";

export function AgentContainer({
  agent,
  changed,
}: {
  agent: Agent;
  changed: () => void;
}) {
  const [mounts, setMounts] = useState(agent.container.mounts.join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(
    () => setMounts(agent.container.mounts.join("\n")),
    [agent.id, agent.container.mounts],
  );
  async function setMode(enabled: boolean) {
    setBusy(true);
    setError("");
    try {
      await api(`/agents/${agent.id}/container`, "PUT", {
        enabled,
        mounts: mounts
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
      });
      changed();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function freeze() {
    setBusy(true);
    setError("");
    try {
      await api(
        `/agents/${agent.id}/container/${agent.container.paused ? "unpause" : "pause"}`,
        "POST",
      );
      changed();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }
  const running = !!agent.runtime || !!agent.container.paused;
  return (
    <section id="container" className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold">运行环境</h2>
        <p className="mt-1 text-sm text-muted">
          {agent.container.enabled
            ? "已启用容器运行。宿主目录只挂载身份目录、工作目录及额外授权目录。"
            : "当前使用本机运行。开启后，身份将在容器中启动。"}
          切换前须停止身份。容器不能隔离同机管理 API，仅对受信任身份启用。
        </p>
      </div>
      {agent.container.enabled && (
        <label className="form-label">
          额外授权目录（每行一个绝对路径）
          <textarea
            className="field"
            rows={2}
            value={mounts}
            onChange={(e) => setMounts(e.target.value)}
            placeholder="/Users/…/repo"
            disabled={running || busy}
          />
        </label>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="button secondary"
          disabled={!agent.agent_directory || running || busy}
          onClick={() => void setMode(!agent.container.enabled)}
        >
          {agent.container.enabled ? "关闭容器运行" : "开启容器运行"}
        </button>
        {agent.container.enabled && (
          <button
            className="button secondary"
            disabled={
              running ||
              busy ||
              mounts
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean)
                .join("\n") === agent.container.mounts.join("\n")
            }
            onClick={() => void setMode(true)}
          >
            保存授权目录
          </button>
        )}
        {agent.container.enabled && agent.runtime && (
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => void freeze()}
          >
            {agent.container.paused ? "恢复" : "冻结"}
          </button>
        )}
        {agent.container.paused && (
          <span role="status" className="text-sm text-muted">
            已冻结，消息仍会进入消息箱
          </span>
        )}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
