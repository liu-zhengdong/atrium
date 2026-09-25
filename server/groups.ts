import type { Store } from "./store.ts";
import type {
  Chat,
  ChatDeletion,
  ChatDeletionResult,
} from "../shared/schema.ts";
import { Problem } from "./problem.ts";
import { isUserRef } from "../shared/user.ts";
import { userNames } from "./users.ts";
import { groupProfileInput } from "../shared/group.ts";

/** 群自己的三件事：可改的名字、一条公告、连同历史一起删除。 */
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

/**
 * 删除群将要动到的行与文件：给预览用的数字，外加提交后要照删的附件编号。
 * 附件先取编号，提交后再删文件。
 */
function deletion(store: Store, chat: Chat) {
  const attachmentIds = store
    .all<{ id: string }>(
      "SELECT id FROM attachments WHERE chat_id=? OR message_id IN (SELECT id FROM messages WHERE chat_id=?)",
      chat.id,
      chat.id,
    )
    .map((row) => row.id);
  const space = store.spaces.list(chat);
  const members = store.one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM members WHERE chat_id=?",
    chat.id,
  )!;
  const messages = store.one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM messages WHERE chat_id=?",
    chat.id,
  )!;
  return {
    preview: {
      ref: chat.ref,
      name: chat.name,
      members: members.n,
      messages: messages.n,
      attachments: attachmentIds.length,
      files: space.files.length,
      files_truncated: space.truncated,
    },
    attachmentIds,
  };
}

/** 删除前的预览：确认框与命令行都拿它说清楚将要删掉多少东西。 */
export function deletionPreview(store: Store, chatId: string): ChatDeletion {
  return deletion(store, group(store, chatId)).preview;
}

/**
 * 删除群与它的全部历史。成员关系、消息、已读与回执、消息箱提醒、投递记录、
 * user_chat_state、附件记录在同一个事务里删；附件文件与共享目录在提交后删，
 * 删不掉的只记在回执里，不回滚已提交的数据。最后给每位成员留一条系统通知，
 * 不叫醒离线身份。
 */
export function disbandGroup(
  store: Store,
  chatId: string,
  confirm: string,
): ChatDeletionResult {
  const chat = group(store, chatId);
  if (confirm !== chat.name)
    throw new Problem(
      400,
      "确认信息不匹配：请输入完整的群名",
      "validation_failed",
    );
  const members = store.members(chatId);
  const target = deletion(store, chat);
  store.transaction(() => {
    // 先删指向 messages、members、chats 的子表，最后删群本身。
    store.run(
      "DELETE FROM attachments WHERE chat_id=? OR message_id IN (SELECT id FROM messages WHERE chat_id=?)",
      chatId,
      chatId,
    );
    store.run("DELETE FROM chat_read_ranges WHERE chat_id=?", chatId);
    store.run("DELETE FROM members WHERE chat_id=?", chatId);
    store.run("DELETE FROM messages WHERE chat_id=?", chatId);
    store.run("DELETE FROM inbox WHERE chat_id=?", chatId);
    store.run("DELETE FROM deliveries WHERE chat_id=?", chatId);
    store.run("DELETE FROM user_reads WHERE chat_id=?", chatId);
    store.run("DELETE FROM user_chat_state WHERE chat_id=?", chatId);
    store.run("DELETE FROM chats WHERE id=?", chatId);
  });
  const failed: string[] = [];
  for (const id of target.attachmentIds)
    try {
      store.files.remove(id);
    } catch (error) {
      failed.push(`附件 ${id}`);
      console.error(`删除群 ${chat.ref} 的附件失败：${id}`, error);
    }
  try {
    store.spaces.remove(chat);
  } catch (error) {
    failed.push(`共享目录 ${chat.ref}`);
    console.error(`删除群 ${chat.ref} 的共享目录失败`, error);
  }
  for (const member of members)
    store.addNotice(
      member,
      "system",
      `群「${chat.name}」已被用户删除`,
      `用户删除了群「${chat.name}」（${chat.ref}）及其全部历史：消息、附件与共享目录不再可读，本群未处理的提醒已收回。你不再能读取或发送这个群的消息。`,
    );
  return { ...target.preview, failed };
}
