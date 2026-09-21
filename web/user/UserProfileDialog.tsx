import {
  USER_NAME_MAX,
  USER_PROFILE_MAX,
  type UserProfile,
} from "../../shared/user.ts";
import { api } from "../api.ts";
import { SubmitDialog } from "../components/SubmitDialog.tsx";

/** 用户自己的资料：Agent 用 user_info 读，界面上由本人维护。 */
export function UserProfileDialog({
  user,
  close,
  saved,
}: {
  user: UserProfile;
  close: () => void;
  saved: () => void;
}) {
  async function submit(data: FormData) {
    await api<UserProfile>("/user", "PATCH", {
      name: data.get("name"),
      profile: data.get("profile"),
    });
    saved();
  }
  return (
    <SubmitDialog
      title="我的资料"
      close={close}
      submit={submit}
      submitLabel="保存"
      pendingLabel="保存中…"
    >
      <p className="muted">
        Agent 需要了解你时读这份资料，它保存在 Atrium，与 Agent
        自己的笔记分开。留空则它们不会自动知道你是谁。
      </p>
      <label className="form-label">
        <span className="form-title">称呼</span>
        <input
          className="field"
          name="name"
          maxLength={USER_NAME_MAX}
          placeholder="Agent 怎么称呼你"
          defaultValue={user.name}
          data-autofocus
        />
      </label>
      <label className="form-label">
        <span className="form-title">资料</span>
        <textarea
          className="field"
          name="profile"
          maxLength={USER_PROFILE_MAX}
          rows={8}
          placeholder="你在做什么、关心什么、希望 Agent 怎么配合"
          defaultValue={user.profile}
        />
      </label>
      <p className="muted small-text">
        这里写给 Agent 看，不是聊天记录；最多 {USER_PROFILE_MAX} 字。
      </p>
    </SubmitDialog>
  );
}
