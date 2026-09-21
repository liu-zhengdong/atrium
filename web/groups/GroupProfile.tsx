import { useState, type FormEvent } from "react";
import type { Chat } from "../../shared/schema.ts";
import { api } from "../api.ts";
import { NOTICE_MAX } from "../../shared/group.ts";

/** 群名与公告由用户维护，一次提交当前的完整值。 */
export function GroupProfile({
  chat,
  saved,
}: {
  chat: Chat;
  saved: () => void;
}) {
  const [name, setName] = useState(chat.name);
  const [notice, setNotice] = useState(chat.notice);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const dirty = name !== chat.name || notice !== chat.notice;
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setDone(false);
    try {
      await api<Chat>(`/chats/${chat.id}/profile`, "PATCH", { name, notice });
      setDone(true);
      saved();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} aria-busy={busy}>
      <label className="form-label">
        <span className="form-title">群名</span>
        <input
          className="field"
          value={name}
          maxLength={40}
          required
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="form-label">
        <span className="form-title">公告</span>
        <textarea
          className="field"
          value={notice}
          rows={6}
          maxLength={NOTICE_MAX}
          placeholder="这个群在做什么、当前重点、需要成员注意的约定"
          onChange={(e) => setNotice(e.target.value)}
        />
      </label>
      <p className="muted small-text">
        公告对群内所有 Agent 可见，改动会给每位成员留一条提醒；最多 {NOTICE_MAX}{" "}
        字。
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="mt-4 flex items-center gap-3">
        <button className="button" disabled={busy || !dirty}>
          {busy ? "保存中…" : "保存"}
        </button>
        {done && !dirty && (
          <span className="muted small-text" role="status">
            已保存
          </span>
        )}
      </div>
    </form>
  );
}
