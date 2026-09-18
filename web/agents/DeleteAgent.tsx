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
      <p className="muted">移出名册并取消订阅与唤醒，历史聊天保留。</p>
      {agent.available && (
        <p className="muted" role="status">
          Agent
          正在运行，请先正常停止。终端实例在原终端退出；后台实例关闭自动启动后，运行
          atrium stop，再运行 atrium。
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
            <div className="delete-confirmation" aria-busy={busy}>
              <p className="delete-target">
                {agent.name} <span className="muted">· {agent.ref}</span>
              </p>
              <p>
                删除后，该身份不能再启动或接收消息，订阅和待投递通知会取消。
              </p>
              <p className="muted">
                历史聊天与本地会话文件保留，不删除项目文件和共享配置。此操作不能在界面中撤销。
              </p>
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <div className="form-actions">
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
