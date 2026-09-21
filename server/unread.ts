import { UNREAD_CAP } from "../shared/schema.ts";

/** 一个 Agent 的未读会话摘要；count 封顶 UNREAD_CAP+1。 */
export type UnreadChat = {
  chat_id: string;
  name: string;
  count: number;
};

/**
 * 未读计数只数到封顶就停。unreadRows 是一条每行代表一条未读消息的
 * SELECT，newestFirst 是它里的消息序号表达式。
 *
 * 必须从最新一条往回数：LIMIT 拦的是数到的行，不是扫过的行。正着数会
 * 先扫完已读位置之后自己发的全部消息才凑够封顶，倒着数则落在会话尾部——
 * 有未读的会话，尾部几乎都是别人发的。十万条实测 6.2ms 降到 0.019ms。
 */
export const cappedCount = (unreadRows: string, newestFirst: string) =>
  `(SELECT COUNT(*) FROM (${unreadRows} ORDER BY ${newestFirst} DESC LIMIT ${UNREAD_CAP + 1}))`;
