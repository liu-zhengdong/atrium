import type { Chat } from "../../shared/schema.ts";

export type ChatTab = "mine" | "observe";

export const chatTabOf = (chat: Pick<Chat, "mine">): ChatTab =>
  chat.mine ? "mine" : "observe";

/** 保留服务端置顶、时间排序，在当前一边取第一个。 */
export const firstChatInTab = <T extends Pick<Chat, "mine">>(
  chats: T[],
  tab: ChatTab,
) => chats.find((chat) => chatTabOf(chat) === tab);

export const hasChatTabActivity = (
  chats: Pick<Chat, "mine" | "unread" | "updated_at">[],
  tab: ChatTab,
  lastObservedAt: number,
) =>
  chats.some(
    (chat) =>
      chatTabOf(chat) === tab &&
      (tab === "mine"
        ? (chat.unread ?? 0) > 0
        : chat.updated_at > lastObservedAt),
  );
