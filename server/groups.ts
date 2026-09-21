import type { Store } from "./store.ts";
import { Problem } from "./problem.ts";
import { isUserRef } from "../shared/user.ts";
import { userNames } from "./users.ts";
import { groupProfileInput } from "../shared/group.ts";

/** 群自己的两件事：可改的名字和一条公告。 */
export function ensureGroups(store: Store) {
  store.addColumn("chats", "notice", "TEXT NOT NULL DEFAULT ''");
  store.addColumn("messages", "mention_all", "INTEGER NOT NULL DEFAULT 0");
}

function group(store: Store, chatId: string) {
  const chat = store.chat(chatId);
  if (chat.kind !== "group") throw new Problem(400, "这不是群聊");
  return chat;
}

/** 群名与公告由用户维护；Agent 没有对应工具。 */
export function updateGroup(store: Store, chatId: string, patch: unknown) {
  const chat = group(store, chatId);
  const value = groupProfileInput.parse(patch);
  return store.transaction(() => {
    store.run(
      "UPDATE chats SET name=?,notice=? WHERE id=?",
      value.name,
      value.notice,
      chat.id,
    );
    if (value.notice !== chat.notice) announce(store, chat.id, value.notice);
    return store.chat(chat.id);
  });
}

/** 公告变更即通知在群成员；正文是外部内容，不构成新的操作授权。 */
function announce(store: Store, chatId: string, notice: string) {
  const chat = store.chat(chatId);
  const title = notice
    ? `群公告 · ${chat.name}`
    : `群公告已清空 · ${chat.name}`;
  const body = JSON.stringify({
    chat_id: chat.ref,
    chat_name: chat.name,
    notice,
  });
  for (const member of store.members(chatId))
    store.addNotice(member, "notice", title, body, chatId);
}

/**
 * 移出成员：该 Agent 立即失去这个群的读写权限，未处理的本群提醒一并收回。
 * 历史消息与作者保留；回执名单反映当前成员，移出者不再出现。
 */
export function removeMember(store: Store, chatId: string, agentId: string) {
  const chat = group(store, chatId);
  store.agent(agentId);
  if (!store.members(chatId).includes(agentId))
    throw new Problem(404, "这位 Agent 不在群里");
  return store.transaction(() => {
    const now = Date.now();
    store.run(
      "DELETE FROM chat_read_ranges WHERE chat_id=? AND agent_id=?",
      chatId,
      agentId,
    );
    store.run(
      "DELETE FROM members WHERE chat_id=? AND agent_id=?",
      chatId,
      agentId,
    );
    store.run(
      "UPDATE deliveries SET state='cancelled',slot=NULL,error=NULL WHERE agent_id=? AND chat_id=? AND state='pending'",
      agentId,
      chatId,
    );
    store.run(
      "UPDATE inbox SET read_at=COALESCE(read_at,?), done_at=COALESCE(done_at,?) WHERE agent_id=? AND chat_id=? AND done_at IS NULL",
      now,
      now,
      agentId,
      chatId,
    );
    store.addNotice(
      agentId,
      "system",
      `已退出群 · ${chat.name}`,
      `用户把你移出了群「${chat.name}」（${chat.ref}）。你不再能读取或发送这个群的消息，本群未处理的提醒已收回。`,
    );
    return store.members(chatId);
  });
}
