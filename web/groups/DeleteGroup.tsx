import { useState } from "react";
import { createPortal } from "react-dom";
import { Trash2 } from "lucide-react";
import type {
  Chat,
  ChatDeletion,
  ChatDeletionResult,
} from "../../shared/schema.ts";
import { Modal } from "../components/Modal.tsx";
import { api } from "../api.ts";
import { filesLabel } from "../../shared/group.ts";

/** 删除群：先看将要删掉什么，把群名抄一遍才允许确认。 */
export function DeleteGroup({
  chat,
  deleted,
}: {
  chat: Chat;
  deleted: () => void;
}) {
  const [target, setTarget] = useState<ChatDeletion | null>(null);
  const [typed, setTyped] = useState("");
  const [leftover, setLeftover] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const close = () => {
    if (busy) return;
    // 已经删掉、只是有文件没清理干净时，关闭即回到刷新后的界面。
    if (leftover.length) return deleted();
    setTarget(null);
    setTyped("");
  };
  async function open() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      setTarget(await api<ChatDeletion>(`/chats/${chat.id}/deletion`));
      setTyped("");
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (busy || !target) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<ChatDeletionResult>(
        `/chats/${chat.id}`,
        "DELETE",
        { confirm: typed.trim() },
      );
      if (result.failed.length) setLeftover(result.failed);
      else deleted();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section">
      <h3>删除群</h3>
      <p className="muted">
        连同消息、附件、共享目录与消息箱提醒一起删除；删除后无法恢复。
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button
        className="button secondary danger"
        disabled={busy}
        onClick={() => void open()}
      >
        <Trash2 size={15} /> {busy ? "读取中…" : "删除群"}
      </button>
      {target &&
        createPortal(
          <Modal
            title={leftover.length ? "群已删除" : "删除群？"}
            close={close}
          >
            <div
              className="px-6 py-[22px] text-[13px] leading-[1.8]"
              aria-busy={busy}
            >
              {leftover.length ? (
                <>
                  <p className="m-0">
                    「{target.name}」的消息、附件与共享目录记录已删除。
                  </p>
                  <p className="mb-0 mt-3.5">这些文件没能删掉，请手动清理：</p>
                  <ul className="muted mb-0 mt-1.5 list-disc pl-5 [overflow-wrap:anywhere]">
                    {leftover.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                  <div className="mt-[25px] flex justify-end">
                    <button
                      className="button secondary"
                      data-autofocus
                      onClick={close}
                    >
                      关闭
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="m-0 text-base font-semibold [overflow-wrap:anywhere]">
                    {target.name} <span className="muted">· {target.ref}</span>
                  </p>
                  <p className="mb-0 mt-3.5">
                    将删除 {target.members} 位成员关系、{target.messages}{" "}
                    条消息、{target.attachments} 个附件、共享目录里的{" "}
                    {filesLabel(target)}{" "}
                    个文件，以及本群在消息箱与投递队列里的记录。
                  </p>
                  <p className="muted mt-3.5">
                    删除后无法恢复；群内身份已经读到的内容（各自的 Pi
                    会话与上下文）删不掉。各成员未处理的本群提醒会收回，随后收到一条系统通知。
                  </p>
                  <label className="form-label !mt-3.5">
                    <span className="form-title">
                      输入群名确认：{target.name}
                    </span>
                    <input
                      className="field"
                      value={typed}
                      autoComplete="off"
                      data-autofocus
                      onChange={(event) => setTyped(event.target.value)}
                    />
                  </label>
                  {typed.trim() && typed.trim() !== target.name && (
                    <p className="muted small-text">群名不一致，请照抄</p>
                  )}
                  {error && (
                    <p className="error" role="alert">
                      {error}
                    </p>
                  )}
                  <div className="mt-[25px] flex justify-end gap-[9px]">
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={close}
                    >
                      取消
                    </button>
                    <button
                      className="button danger solid"
                      disabled={busy || typed.trim() !== target.name}
                      onClick={() => void remove()}
                    >
                      {busy ? "删除中…" : "确认删除"}
                    </button>
                  </div>
                </>
              )}
            </div>
          </Modal>,
          document.body,
        )}
    </section>
  );
}
