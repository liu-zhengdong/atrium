import type { Store } from "./store.ts";
import { Problem } from "./problem.ts";
import {
  isUserRef,
  LOCAL_USER,
  userProfileInput,
  type UserProfile,
} from "../shared/user.ts";

/**
 * 用户表与本机用户 u1。
 * 旧库把人类发言与上传都写作字面量 'user'，指的就是这个人；开库时一次改成短号，
 * 之后消息发送者与附件上传者只有两种形态：Agent 的 UUID 和用户短号。
 */
export function ensureUsers(store: Store) {
  store.db
    .exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '',
    profile TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
  const now = Date.now();
  store.run(
    "INSERT OR IGNORE INTO users(id,created_at,updated_at) VALUES(?,?,?)",
    LOCAL_USER,
    now,
    now,
  );
  const legacy =
    store.one("SELECT 1 FROM messages WHERE sender='user' LIMIT 1") ??
    store.one("SELECT 1 FROM attachments WHERE uploader='user' LIMIT 1");
  if (legacy)
    store.transaction(() => {
      store.run("UPDATE messages SET sender=? WHERE sender='user'", LOCAL_USER);
      store.run(
        "UPDATE attachments SET uploader=? WHERE uploader='user'",
        LOCAL_USER,
      );
    });
}

export function readUser(
  store: Store,
  reference: string = LOCAL_USER,
): UserProfile {
  const trimmed = reference.trim();
  if (!isUserRef(trimmed)) throw new Problem(400, "请使用用户短号，如 u1");
  const row = store.one<UserProfile>(
    "SELECT id,name,profile,updated_at FROM users WHERE id=?",
    trimmed,
  );
  if (!row) throw new Problem(404, "用户不存在");
  return row;
}

/** 资料由用户本人维护；Agent 只读。 */
export function writeUser(
  store: Store,
  reference: string,
  patch: unknown,
): UserProfile {
  const user = readUser(store, reference);
  const value = userProfileInput.parse(patch);
  store.run(
    "UPDATE users SET name=?,profile=?,updated_at=? WHERE id=?",
    value.name,
    value.profile,
    Date.now(),
    user.id,
  );
  return readUser(store, user.id);
}

/** 用户的两个显示名：界面上是「你」，送给 Agent 的用资料里的称呼。 */
export function userNames(store: Store, reference: string = LOCAL_USER) {
  const row = store.one<{ name: string }>(
    "SELECT name FROM users WHERE id=?",
    reference.trim(),
  );
  return { own: "你", peer: row?.name.trim() || "用户" };
}
