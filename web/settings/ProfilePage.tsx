import { useEffect, useState, type FormEvent } from "react";
import {
  USER_NAME_MAX,
  USER_PROFILE_MAX,
  type UserProfile,
} from "../../shared/user.ts";
import { api } from "../api.ts";
import { matches } from "./types.ts";

export function ProfilePage({
  query,
  changed,
}: {
  query: string;
  changed: () => void;
}) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    api<UserProfile>("/user")
      .then((value) => {
        if (alive) {
          setProfile(value);
          setName(value.name);
          setBody(value.profile);
        }
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, []);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const value = await api<UserProfile>("/user", "PATCH", {
        name,
        profile: body,
      });
      setProfile(value);
      changed();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-6">
      <h1 className="m-0 text-xl font-medium">个人资料</h1>
      {error && (
        <p role="alert" className="text-xs text-[#9a5b4b]">
          {error}
        </p>
      )}
      {!profile && !error && (
        <p className="text-xs text-muted">正在读取资料…</p>
      )}
      {profile && (
        <form
          onSubmit={(event) => void save(event)}
          className="space-y-4 rounded-2xl bg-white p-5 shadow-lift"
        >
          {matches(query, "称呼", "名字", "Agent") && (
            <label className="block text-xs text-muted">
              称呼
              <input
                className="field mt-2"
                maxLength={USER_NAME_MAX}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Agent 怎么称呼你"
              />
            </label>
          )}
          {matches(query, "资料", "正文", "Agent") && (
            <label className="block text-xs text-muted">
              资料
              <textarea
                className="field mt-2 resize-none"
                rows={8}
                maxLength={USER_PROFILE_MAX}
                value={body}
                onChange={(event) => setBody(event.target.value)}
                placeholder="你在做什么、关心什么、希望 Agent 怎么配合"
              />
            </label>
          )}
          {matches(query, "称呼", "名字", "资料", "正文", "Agent") ? (
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-muted">
                {body.length >= USER_PROFILE_MAX - 200
                  ? `${body.length} / ${USER_PROFILE_MAX}`
                  : ""}
              </span>
              <button className="button" type="submit" disabled={busy}>
                {busy ? "保存中…" : "保存"}
              </button>
            </div>
          ) : (
            <p className="text-xs text-muted">没有匹配的设置项</p>
          )}
        </form>
      )}
    </div>
  );
}
