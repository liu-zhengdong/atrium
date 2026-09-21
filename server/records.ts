import { z } from "zod";
import type { Store } from "./store.ts";
import {
  chatReference,
  agentReference,
  type FileRecord,
  type MessageHit,
} from "../shared/schema.ts";
import { isUserRef, LOCAL_USER, userReference } from "../shared/user.ts";
import { userNames } from "./users.ts";

/** 一页的条数。列表是倒序翻页，游标是上一页最后一条的排序键。 */
const PAGE = 40;
/** 关键词上限；再长也不会让结果更准，只会让 LIKE 扫得更慢。 */
const QUERY_MAX = 100;

/**
 * 发送者可以是用户或 Agent。不用 z.union：它会把两个分支的错误都报出来，
 * 界面只取第一条，结果是打错 Agent 短号时被告知要用用户短号。
 */
const senderReference = z
  .string()
  .trim()
  .refine(
    (value) =>
      userReference.safeParse(value).success ||
      agentReference.safeParse(value).success,
    "发送者请用用户短号 u1 或 Agent 短号，如 a1",
  );

/** 三种列表共享的筛选。时间是毫秒时间戳，from 含、to 不含。 */
export const recordQuery = z
  .object({
    chat: chatReference.optional(),
    sender: senderReference.optional(),
    from: z.coerce.number().int().nonnegative().optional(),
    to: z.coerce.number().int().nonnegative().optional(),
    kind: z.enum(["image", "file"]).optional(),
    q: z.string().trim().max(QUERY_MAX).optional(),
    before: z.coerce.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.from === undefined ||
      value.to === undefined ||
      value.from < value.to,
    { message: "开始时间要早于结束时间", path: ["from"] },
  );
export type RecordQuery = z.infer<typeof recordQuery>;

/**
 * 各列表的列名不同：消息按 id 排、关键词比对正文，附件按 rowid 排、关键词比对文件名，
 * 发送者一个在 sender 一个在 uploader。
 */
type Columns = {
  chat: string;
  sender: string;
  time: string;
  cursor: string;
  kind?: string;
  keyword?: string;
};

/** LIKE 的通配符按字面处理，别让用户输入的 % 变成「匹配任意」。 */
export const likeOf = (raw: string) =>
  `%${raw.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;

/**
 * 把筛选翻译成 SQL 条件。无 IO，条件的组合可以穷举测试。
 * 游标恒定存在，所以返回的 where 一定非空。
 */
export function recordConditions(
  query: RecordQuery,
  columns: Columns,
): { where: string; params: (string | number)[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  const add = (clause: string, ...values: (string | number)[]) => {
    where.push(clause);
    params.push(...values);
  };
  if (query.chat) add(`${columns.chat}=?`, query.chat);
  if (query.sender) add(`${columns.sender}=?`, query.sender);
  if (query.from !== undefined) add(`${columns.time}>=?`, query.from);
  if (query.to !== undefined) add(`${columns.time}<?`, query.to);
  if (query.kind && columns.kind) add(`${columns.kind}=?`, query.kind);
  if (query.q && columns.keyword)
    add(`${columns.keyword} LIKE ? ESCAPE '\\'`, likeOf(query.q));
  add(`${columns.cursor}<?`, query.before ?? Number.MAX_SAFE_INTEGER);
  return { where: where.join(" AND "), params };
}

/** 短号先换成内部 id，顺带确认会话与发送者真实存在。 */
function resolve(store: Store, query: RecordQuery): RecordQuery {
  const sender = resolveSender(store, query.sender);
  if (!query.chat) return { ...query, sender };
  const chatId = store.resolveChatId(query.chat);
  store.chat(chatId);
  return { ...query, chat: chatId, sender };
}

/** 多取一条用来判断还有没有下一页。 */
function paginate<T>(rows: T[]): { items: T[]; has_more: boolean } {
  const items = rows.slice(0, PAGE);
  return { items, has_more: rows.length > items.length };
}

/** 按筛选找消息正文，倒序。点进去跳回原消息。 */
export function messageRecords(store: Store, raw: RecordQuery) {
  const query = resolve(store, raw);
  const { where, params } = recordConditions(query, {
    chat: "m.chat_id",
    sender: "m.sender",
    time: "m.created_at",
    cursor: "m.id",
    keyword: "m.body",
  });
  const own = userNames(store).own;
  const rows = store.all<MessageHit>(
    `SELECT m.chat_id, 'c'||r.number AS chat_ref, c.name AS chat_name, m.id, m.sender,
     CASE WHEN m.sender=? THEN ? ELSE COALESCE(a.deleted_name, a.name, m.sender) END AS sender_name,
     substr(m.body,1,160) AS text, m.created_at
     FROM messages m JOIN chats c ON c.id=m.chat_id JOIN chat_refs r ON r.chat_id=c.id
     LEFT JOIN agents a ON a.id=m.sender
     WHERE ${where} ORDER BY m.id DESC LIMIT ?`,
    LOCAL_USER,
    own,
    ...params,
    PAGE + 1,
  );
  return paginate(rows);
}

/** 按筛选找附件，倒序。kind 决定这是图片网格还是文件列表。 */
export function fileRecords(store: Store, raw: RecordQuery) {
  const query = resolve(store, raw);
  const { where, params } = recordConditions(query, {
    chat: "t.chat_id",
    sender: "t.uploader",
    time: "t.created_at",
    cursor: "t.rowid",
    kind: "t.kind",
    keyword: "t.name",
  });
  const own = userNames(store).own;
  const rows = store.all<
    Omit<FileRecord, "uploader_name"> & { agent_name: string | null }
  >(
    `SELECT t.rowid AS cursor, t.id, t.chat_id, 'c'||r.number AS chat_ref, c.name AS chat_name,
     t.message_id, t.kind, t.name, t.mime, t.size, t.created_at, t.uploader,
     COALESCE(ag.deleted_name, ag.name) AS agent_name
     FROM attachments t JOIN chats c ON c.id=t.chat_id JOIN chat_refs r ON r.chat_id=c.id
     LEFT JOIN agents ag ON ag.id=t.uploader
     WHERE ${where} ORDER BY t.rowid DESC LIMIT ?`,
    ...params,
    PAGE + 1,
  );
  return paginate(
    rows.map(({ agent_name, ...file }) => ({
      ...file,
      uploader_name: isUserRef(file.uploader) ? own : (agent_name ?? "Agent"),
    })),
  );
}

/** 发送者筛选只接受真实存在的身份，不把打错的短号当成「没有结果」。 */
function resolveSender(store: Store, sender: string | undefined) {
  if (!sender || isUserRef(sender)) return sender;
  return store.agent(store.resolveAgentId(sender)).id;
}
