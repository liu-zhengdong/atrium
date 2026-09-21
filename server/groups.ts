import type { Store } from "./store.ts";
import { Problem } from "./problem.ts";
import { isUserRef } from "../shared/user.ts";
import { userNames } from "./users.ts";
import { groupProfileInput } from "../shared/group.ts";

/** 群自己的两件事：可改的名字和一条公告。 */
export function ensureGroups(store: Store) {
  addColumn(store, "chats", "notice", "TEXT NOT NULL DEFAULT ''");
  addColumn(store, "messages", "mention_all", "INTEGER NOT NULL DEFAULT 0");
}

function addColumn(store: Store, table: string, column: string, type: string) {
  const existing = store
    .all<{ name: string }>(`PRAGMA table_info(${table})`)
    .map((row) => row.name);
  if (!existing.includes(column))
    store.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
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
    store.unreadCache.forget(agentId);
    return store.members(chatId);
  });
}

export type ChatFile = {
  id: string;
  message_id: number;
  kind: "image" | "file";
  name: string;
  mime: string;
  size: number;
  created_at: number;
  uploader_name: string;
  cursor: number;
};

const FILE_PAGE = 30;

/** 群文件就是这个会话里发过的附件，不另开上传口。 */
export function chatFiles(store: Store, chatId: string, before?: number) {
  store.chat(chatId);
  const rows = store.all<
    Omit<ChatFile, "uploader_name" | "cursor"> & {
      rowid: number;
      uploader: string;
      agent_name: string | null;
    }
  >(
    `SELECT a.rowid, a.id, a.message_id, a.kind, a.name, a.mime, a.size, a.created_at, a.uploader,
     COALESCE(ag.deleted_name, ag.name) AS agent_name
     FROM attachments a JOIN messages m ON m.id=a.message_id
     LEFT JOIN agents ag ON ag.id=a.uploader
     WHERE m.chat_id=? AND a.rowid<? ORDER BY a.rowid DESC LIMIT ?`,
    chatId,
    before ?? Number.MAX_SAFE_INTEGER,
    FILE_PAGE + 1,
  );
  const own = userNames(store).own;
  const items: ChatFile[] = rows
    .slice(0, FILE_PAGE)
    .map(({ rowid, uploader, agent_name, ...file }) => ({
      ...file,
      cursor: rowid,
      uploader_name: isUserRef(uploader) ? own : (agent_name ?? "Agent"),
    }));
  return { items, has_more: rows.length > items.length };
}

/** 群内搜索：只看这个会话的正文，命中后跳回原消息。 */
export function searchChat(store: Store, chatId: string, raw: string) {
  store.chat(chatId);
  const needle = raw.trim();
  if (!needle) throw new Problem(400, "缺少搜索词");
  const like = `%${needle.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
  const rows = store.all<{
    id: number;
    sender: string;
    sender_name: string | null;
    text: string;
    created_at: number;
  }>(
    `SELECT m.id, m.sender, COALESCE(ag.deleted_name, ag.name) AS sender_name,
     substr(m.body,1,160) AS text, m.created_at
     FROM messages m LEFT JOIN agents ag ON ag.id=m.sender
     WHERE m.chat_id=? AND m.body LIKE ? ESCAPE '\\' ORDER BY m.id DESC LIMIT 30`,
    chatId,
    like,
  );
  const own = userNames(store).own;
  return {
    items: rows.map((row) => ({
      ...row,
      sender_name: isUserRef(row.sender) ? own : (row.sender_name ?? "Agent"),
    })),
  };
}
