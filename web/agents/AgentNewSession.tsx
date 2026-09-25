import { useState } from "react";
import { createPortal } from "react-dom";
import { RotateCw } from "lucide-react";
import type { Agent } from "../components/AgentAvatar.tsx";
import { Modal } from "../components/Modal.tsx";
import { api, messageOf } from "../api.ts";

export function AgentNewSession({ agent }: { agent: Agent }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const close = () => {
    if (!busy) setOpen(false);
  };
  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ new_session_file: string | null }>(
        `/agents/${agent.id}/new-session`,
        "POST",
        { timeout: 300 },
      );
      setDone(
        `新会话已启动${result.new_session_file ? ` · ${result.new_session_file}` : ""}`,
      );
      setOpen(false);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        className="flex items-center gap-1 text-xs text-accent-strong hover:underline"
        onClick={() => {
          setError("");
          setOpen(true);
        }}
      >
        <RotateCw size={14} /> 开新会话
      </button>
      {done && (
        <p role="status" className="text-xs text-muted break-all">
          {done}
        </p>
      )}
      {open &&
        createPortal(
          <Modal title="为身份开新会话？" close={close}>
            <div
              className="px-6 py-5 text-[13px] leading-relaxed"
              aria-busy={busy}
            >
              <p className="font-medium break-words">
                {agent.name} · {agent.ref}
              </p>
              <p className="mt-3">
                旧会话保留在磁盘上，新会话看不到之前的对话，笔记和消息箱不受影响。
              </p>
              <p className="mt-2 text-muted">
                如果正在处理，会等当前回合结束再切换；最多等待 5 分钟。
              </p>
              {error && (
                <p className="error mt-3" role="alert">
                  {error}
                </p>
              )}
              <div className="mt-6 flex justify-end gap-2">
                <button
                  className="button secondary"
                  data-autofocus
                  disabled={busy}
                  onClick={close}
                >
                  取消
                </button>
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => void confirm()}
                >
                  {busy ? "等待当前回合…" : "开新会话"}
                </button>
              </div>
            </div>
          </Modal>,
          document.body,
        )}
    </>
  );
}
