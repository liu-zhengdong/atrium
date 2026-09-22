import { useState } from "react";
import { createPortal } from "react-dom";
import { Trash2 } from "lucide-react";
import type { Agent } from "../components/AgentAvatar.tsx";
import { Modal } from "../components/Modal.tsx";
import { api } from "../api.ts";

export function DeleteAgent({
  agent,
  disabled,
  removed,
}: {
  agent: Agent;
  disabled: boolean;
  removed: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const close = () => {
    if (!busy) setConfirming(false);
  };
  async function remove() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api(`/agents/${agent.id}`, "DELETE", { confirm: agent.ref });
      removed();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section">
      <h3>删除 Agent</h3>
      <p className="muted">移出名册并取消待投递通知与唤醒，历史聊天保留。</p>
      {agent.available && (
        <p className="muted" role="status">
          Agent 正在运行，请先停止。后台实例用上面的「停止 Agent」或 atrium stop
          名称；终端实例在原终端退出。
        </p>
      )}
      <button
        className="button secondary danger"
        disabled={disabled || agent.available}
        onClick={() => {
          setError("");
          setConfirming(true);
        }}
      >
        <Trash2 size={15} /> 删除 Agent
      </button>
      {confirming &&
        createPortal(
          <Modal title="删除 Agent？" close={close}>
            <div
              className="px-6 py-[22px] text-[13px] leading-[1.8]"
              aria-busy={busy}
            >
              <p className="m-0 text-base font-semibold [overflow-wrap:anywhere]">
                {agent.name} <span className="muted">· {agent.ref}</span>
              </p>
              <p className="mb-0 mt-3.5">
                删除后，该身份不能再启动或接收消息，待投递通知会取消。
              </p>
              <p className="muted mt-3.5">
                历史聊天与本地会话文件保留，不删除项目文件和共享配置。此操作不能在界面中撤销。
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
                  disabled={busy || agent.available}
                  onClick={() => void remove()}
                >
                  {busy ? "删除中…" : "确认删除"}
                </button>
              </div>
            </div>
          </Modal>,
          document.body,
        )}
    </section>
  );
}
